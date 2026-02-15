const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = 3456;
let serverProcess = null;
let panel = null;

function findProjectDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return null;
  for (const folder of folders) {
    if (fs.existsSync(path.join(folder.uri.fsPath, 'sfdx-project.json')))
      return folder.uri.fsPath;
  }
  return null;
}

function getServerPath() {
  const bundled = path.join(__dirname, 'apex-log-monitor', 'server.js');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(__dirname, '..', 'apex-log-monitor', 'server.js');
}

function waitForServer(attempts = 30) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    let n = 0;
    const tryConnect = () => {
      const req = http.get(`http://localhost:${PORT}/`, () => resolve());
      req.on('error', () => {
        if (++n >= attempts) reject(new Error('Server failed to start'));
        else setTimeout(tryConnect, 300);
      });
    };
    tryConnect();
  });
}

function getWebviewContent() {
  const bundled = path.join(__dirname, 'apex-log-monitor', 'index.html');
  const sibling = path.join(__dirname, '..', 'apex-log-monitor', 'index.html');
  let html = fs.readFileSync(fs.existsSync(bundled) ? bundled : sibling, 'utf8');
  const apiBase = `http://localhost:${PORT}`;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src ${apiBase} http://127.0.0.1:${PORT} https://cdn.jsdelivr.net; img-src https:; font-src https://cdn.jsdelivr.net;`;
  const proxyScript = `<script>
(function() {
  if (typeof acquireVsCodeApi === 'undefined') return;
  const vscode = acquireVsCodeApi();
  const _fetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url !== 'string' || (!url.startsWith('http://localhost:') && !url.startsWith('http://127.0.0.1:'))) return _fetch.apply(this, arguments);
    const id = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const handler = (e) => {
        if (e.data?.type === 'debugfast-api-response' && e.data.id === id) {
          window.removeEventListener('message', handler);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve({ ok: e.data.ok, json: () => Promise.resolve(e.data.body), status: e.data.status });
        }
      };
      window.addEventListener('message', handler);
      vscode.postMessage({ type: 'debugfast-api', id, url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
    });
  };
})();
<\/script>`;
  html = html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${csp}">${proxyScript}`);
  html = html.replace(/fetch\(path,/g, `fetch('${apiBase}' + path,`);
  return html;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('debugfast.launchLogAnalysis', async () => {
      const projectDir = findProjectDir();
      if (!projectDir) {
        vscode.window.showErrorMessage('No Salesforce project found. Open a workspace with sfdx-project.json.');
        return;
      }

      const serverPath = getServerPath();
      if (!fs.existsSync(serverPath)) {
        vscode.window.showErrorMessage(`Apex Log Monitor not found at ${serverPath}`);
        return;
      }

      if (serverProcess) {
        if (panel) panel.reveal();
        return;
      }

      serverProcess = spawn('node', [serverPath], {
        cwd: projectDir,
        env: { ...process.env, SF_PROJECT_DIR: projectDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      serverProcess.stderr?.on('data', (c) => { stderr += c.toString(); });
      serverProcess.on('error', (err) => {
        serverProcess = null;
        vscode.window.showErrorMessage(`Failed to start: ${err.message}`);
      });
      serverProcess.on('exit', (code) => {
        serverProcess = null;
      });

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Starting Apex Log Monitor…' },
          () => waitForServer()
        );
      } catch (e) {
        serverProcess?.kill();
        serverProcess = null;
        vscode.window.showErrorMessage(`Server failed to start: ${e.message}`);
        return;
      }

      panel = vscode.window.createWebviewPanel('debugfast', 'Debugfast: Apex Log Analysis', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.webview.html = getWebviewContent();

      panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type !== 'debugfast-api' || !panel) return;
        const http = require('http');
        const url = new URL(msg.url);
        const opts = {
          hostname: url.hostname,
          port: url.port || 3456,
          path: url.pathname + url.search,
          method: msg.method || 'GET',
          headers: { 'Content-Type': 'application/json' },
        };
        const req = http.request(opts, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            let parsed = {};
            try { parsed = JSON.parse(body || '{}'); } catch (_) {}
            panel?.webview.postMessage({
              type: 'debugfast-api-response',
              id: msg.id,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              body: parsed,
            });
          });
        });
        req.on('error', (err) => {
          panel?.webview.postMessage({ type: 'debugfast-api-response', id: msg.id, error: err.message });
        });
        if (msg.body) req.write(msg.body);
        req.end();
      });

      panel.onDidDispose(() => {
        panel = null;
        if (serverProcess) {
          serverProcess.kill();
          serverProcess = null;
        }
      });
    })
  );
}

function deactivate() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

module.exports = { activate, deactivate };
