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
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src ${apiBase} https://cdn.jsdelivr.net; img-src https:; font-src https://cdn.jsdelivr.net;`;
  html = html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
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

      panel = vscode.window.createWebviewPanel('debugfast', 'Fastforce: Apex Log Analysis', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.webview.html = getWebviewContent();
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
