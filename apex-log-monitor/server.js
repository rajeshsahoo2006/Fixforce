#!/usr/bin/env node
/**
 * Apex Log Monitor - Audit log streamer and error analyzer
 * 1. Find org, set default | 2. Start audit (enable debug log tail) | 3. Analyze via Cursor Agent CLI (or regex fallback)
 * Log rotation: new file created when current log exceeds 1 MB
 */

const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '3456', 10);

function findProjectDir() {
  const explicit = process.env.SF_PROJECT_DIR || process.argv.find((a) => a.startsWith('--project='))?.split('=')[1];
  if (explicit) {
    const p = path.resolve(explicit);
    if (fs.existsSync(path.join(p, 'sfdx-project.json'))) return p;
    return p; // use even if no sfdx-project, user specified it
  }
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'sfdx-project.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const PROJECT_DIR = findProjectDir();
if (!PROJECT_DIR) {
  console.error('Error: Not inside a Salesforce project. Run from a project root (with sfdx-project.json) or set SF_PROJECT_DIR=/path/to/project');
  process.exit(1);
}

const SF_LOG_DIR = path.join(PROJECT_DIR, '.sf-log');
const SF_LOG_ANALYSIS_DIR = path.join(PROJECT_DIR, '.sf-log_Analysis');
const LOG_ROTATE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
const PROMPT_FILE = path.join(__dirname, 'prompts', 'apex-log-analysis.md');

// Regex patterns for error scanning (fallback when Cursor CLI unavailable)
const ERROR_PATTERNS = [
  { pattern: /\|EXCEPTION_THROWN(?!\w)/g, label: 'EXCEPTION_THROWN', severity: 'error' },
  { pattern: /\|FATAL_ERROR(?!\w)/g, label: 'FATAL_ERROR', severity: 'error' },
  { pattern: /\|UNHANDLED_EXCEPTION(?!\w)/g, label: 'UNHANDLED_EXCEPTION', severity: 'error' },
  { pattern: /\|VALIDATION_FAIL(?!\w)/g, label: 'VALIDATION_FAIL', severity: 'error' },
  { pattern: /\|VALIDATION_FORMULA(?!\w)/g, label: 'VALIDATION_FORMULA', severity: 'warning' },
  { pattern: /\|LIMIT_USAGE(?!\w)/g, label: 'LIMIT_USAGE', severity: 'warning' },
  { pattern: /System\.LimitException/g, label: 'LIMIT_EXCEPTION', severity: 'error' },
  { pattern: /System\.Exception/g, label: 'SYSTEM_EXCEPTION', severity: 'error' },
  { pattern: /NullPointerException/g, label: 'NULL_POINTER', severity: 'error' },
];

function analyzeLogs(logContent) {
  const lines = logContent.split('\n');
  const errors = [];
  const errorTypes = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, label, severity } of ERROR_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(line)) {
        errorTypes.add(label);
        const ctxBefore = lines.slice(Math.max(0, i - 1), i).join('\n');
        const ctxAfter = lines.slice(i + 1, Math.min(lines.length, i + 2)).join('\n');
        errors.push({
          line: line.trim(),
          type: label,
          severity,
          context: `${ctxBefore}\n>>> ${line} <<<\n${ctxAfter}`,
        });
        break;
      }
    }
  }

  let report = errors.length === 0
    ? 'No errors detected.'
    : `Found ${errors.length} issue(s): ${[...errorTypes].join(', ')}\n\n--- Errors ---\n` +
      errors.map((e, i) => `[${i + 1}] ${e.type}: ${e.line.slice(0, 100)}${e.line.length > 100 ? '…' : ''}`).join('\n');

  if (errors.length > 0) {
    report += '\n\n--- Quick fixes ---\n';
    if (errors.some((e) => e.type.includes('VALIDATION'))) report += '• Validation: Check rule formula\n';
    if (errors.some((e) => e.type.includes('EXCEPTION') || e.type === 'FATAL')) report += '• Apex: Add try/catch\n';
    if (errors.some((e) => e.type.includes('LIMIT'))) report += '• Limits: Optimize SOQL/DML\n';
  }
  return { report, errors };
}

function analyzeWithCursorAgent(logDir, callback) {
  if (!fs.existsSync(PROMPT_FILE)) {
    return callback({ ok: false, error: 'Prompt file not found', fallback: true });
  }
  const promptContent = fs.readFileSync(PROMPT_FILE, 'utf8');
  const workspaceDir = PROJECT_DIR;
  const logDirRef = path.relative(workspaceDir, logDir) || path.basename(logDir);
  const fullPrompt = `${promptContent}\n\n---\nContext: The log folder path is ${logDirRef}. Analyze it now.`;
  const args = [
    '--print',
    '--output-format', 'text',
    '--workspace', workspaceDir,
    '--approve-mcps',
    fullPrompt,
  ];
  const proc = spawn('agent', args, {
    cwd: workspaceDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (c) => { stdout += c.toString(); });
  proc.stderr?.on('data', (c) => { stderr += c.toString(); });
  proc.on('close', (code) => {
    if (code === 0) {
      return callback({ ok: true, report: stdout.trim(), errors: [] });
    }
    callback({
      ok: false,
      error: stderr || `Agent exited with code ${code}`,
      fallback: true,
      report: stdout?.trim(),
    });
  });
  proc.on('error', (err) => {
    callback({ ok: false, error: err.message, fallback: true });
  });
}

let tailProcess = null;
let logBuffer = [];
let logFileStream = null;
let currentLogPath = null;
let currentLogFilePath = null;
let orgCache = { orgs: [], expiresAt: 0 };
const CACHE_TTL = 2 * 60 * 1000;

function ensureSfLogDir() {
  if (!fs.existsSync(SF_LOG_DIR)) {
    fs.mkdirSync(SF_LOG_DIR, { recursive: true });
  }
}

function archiveOldLogsBeforeAudit() {
  if (!fs.existsSync(SF_LOG_DIR)) return;
  const files = fs.readdirSync(SF_LOG_DIR);
  const logFiles = files.filter((f) => f.endsWith('.log') || f.endsWith('.log.gz'));
  if (logFiles.length === 0) return;
  const ts = new Date();
  const date = ts.toISOString().slice(0, 10);
  const time = [ts.getHours(), ts.getMinutes(), ts.getSeconds()].map((n) => String(n).padStart(2, '0')).join('-');
  const archiveDir = path.join(PROJECT_DIR, `.sf-log_${date}_${time}`);
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const f of logFiles) {
    fs.renameSync(path.join(SF_LOG_DIR, f), path.join(archiveDir, f));
  }
}

function prepareLogsForAnalysis() {
  if (logFileStream?.writable) {
    try { logFileStream.end(); } catch (e) {}
    logFileStream = null;
    currentLogFilePath = null;
  }
}

function createArchiveDir() {
  const ts = new Date();
  const date = ts.toISOString().slice(0, 10);
  const time = [ts.getHours(), ts.getMinutes(), ts.getSeconds()].map((n) => String(n).padStart(2, '0')).join('-');
  return path.join(PROJECT_DIR, `.sf-log_archive_${date}_${time}`);
}

function moveLogsToAnalysisFolder() {
  prepareLogsForAnalysis();
  ensureSfLogDir();
  const hasAnalysisFiles = fs.existsSync(SF_LOG_ANALYSIS_DIR) && (fs.readdirSync(SF_LOG_ANALYSIS_DIR) || []).length > 0;
  const mainFiles = (fs.readdirSync(SF_LOG_DIR) || []).filter((f) => {
    try { return fs.statSync(path.join(SF_LOG_DIR, f)).isFile(); } catch { return false; }
  });
  const hasMainFiles = mainFiles.length > 0;
  const archiveDir = (hasAnalysisFiles || hasMainFiles) ? createArchiveDir() : null;
  if (archiveDir && hasAnalysisFiles) {
    fs.mkdirSync(path.join(archiveDir, 'analysis'), { recursive: true });
    for (const f of fs.readdirSync(SF_LOG_ANALYSIS_DIR)) {
      const p = path.join(SF_LOG_ANALYSIS_DIR, f);
      if (fs.statSync(p).isFile()) {
        fs.renameSync(p, path.join(archiveDir, 'analysis', f));
      }
    }
  }
  if (!fs.existsSync(SF_LOG_ANALYSIS_DIR)) {
    fs.mkdirSync(SF_LOG_ANALYSIS_DIR, { recursive: true });
  }
  if (archiveDir && hasMainFiles) {
    fs.mkdirSync(path.join(archiveDir, 'main'), { recursive: true });
    for (const f of mainFiles) {
      const src = path.join(SF_LOG_DIR, f);
      try {
        fs.renameSync(src, path.join(archiveDir, 'main', f));
      } catch (_) {}
    }
  }
  const mainArchivePath = archiveDir ? path.join(archiveDir, 'main') : null;
  if (mainArchivePath && fs.existsSync(mainArchivePath)) {
    for (const f of fs.readdirSync(mainArchivePath)) {
      const src = path.join(mainArchivePath, f);
      const dest = path.join(SF_LOG_ANALYSIS_DIR, f);
      try {
        fs.copyFileSync(src, dest);
      } catch (_) {}
    }
  }
  if (tailProcess) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logFileName = `apex-${timestamp}.log`;
    const logPath = path.join(SF_LOG_DIR, logFileName);
    try {
      logFileStream = fs.createWriteStream(logPath, { flags: 'w' });
      currentLogPath = path.relative(PROJECT_DIR, logPath);
      currentLogFilePath = logPath;
    } catch (e) {
      console.error('Failed to create new log file after analysis:', e.message);
    }
  }
}

function getSfEnv() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.volta', 'bin'),
  ];
  try {
    const nvmCurrent = path.join(home, '.nvm', 'versions', 'node', 'current', 'bin');
    if (fs.existsSync(nvmCurrent)) candidates.push(nvmCurrent);
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      const vers = fs.readdirSync(nvmDir).filter((v) => fs.existsSync(path.join(nvmDir, v, 'bin')));
      if (vers.length) candidates.push(path.join(nvmDir, vers.sort().pop(), 'bin'));
    }
  } catch (_) {}
  const extra = candidates.filter((p) => p && fs.existsSync(p)).join(path.delimiter);
  return { ...process.env, PATH: extra ? extra + path.delimiter + (process.env.PATH || '') : process.env.PATH };
}

function getConnectedOrgs(force = false) {
  if (!force && Date.now() < orgCache.expiresAt) return { orgs: orgCache.orgs };
  try {
    const out = execSync('sf org list --json', {
      encoding: 'utf8',
      cwd: PROJECT_DIR,
      maxBuffer: 1024 * 1024,
      timeout: 60000,
      shell: true,
      env: getSfEnv(),
    });
    const data = JSON.parse(out?.trim() || '{}');
    const r = data?.result || data;
    const all = [...(r.scratchOrgs || []), ...(r.nonScratchOrgs || []), ...(r.other || []), ...(r.sandboxes || [])];
    const orgs = all
      .filter((o) => o.connectedStatus === 'Connected')
      .map((o) => ({ alias: o.alias || o.username, username: o.username }));
    orgCache = { orgs, expiresAt: Date.now() + CACHE_TTL };
    return { orgs };
  } catch (e) {
    const err = e.stderr?.toString() || e.stdout?.toString() || e.message;
    return { orgs: orgCache.orgs, error: err.trim() || e.message };
  }
}

function setDefaultOrg(alias) {
  if (!alias?.trim()) return { ok: false, error: 'No org selected' };
  try {
    execSync(`sf config set target-org ${alias}`, { encoding: 'utf8', cwd: PROJECT_DIR, shell: true, env: getSfEnv() });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function startAudit(orgAlias) {
  if (tailProcess) {
    tailProcess.kill('SIGTERM');
    tailProcess = null;
  }
  if (logFileStream) {
    try { logFileStream.end(); } catch (e) {}
    logFileStream = null;
  }
  logBuffer = [];
  currentLogPath = null;
  currentLogFilePath = null;
  archiveOldLogsBeforeAudit();
  ensureSfLogDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFileName = `apex-${timestamp}.log`;
  const logPath = path.join(SF_LOG_DIR, logFileName);
  currentLogFilePath = logPath;
  try {
    logFileStream = fs.createWriteStream(logPath, { flags: 'w' });
    currentLogPath = path.relative(PROJECT_DIR, logPath);
  } catch (e) {
    console.error('Failed to create log file:', e.message);
  }
  const org = orgAlias?.trim() || null;
  const args = ['apex', 'tail', 'log', '--debug-level', 'DEBUG'];
  if (org) args.push('--target-org', org);
  tailProcess = spawn('sf', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: true, cwd: PROJECT_DIR, env: getSfEnv() });
  const maybeRotateLog = () => {
    if (!logFileStream?.writable || !currentLogFilePath) return;
    try {
      const stat = fs.statSync(currentLogFilePath);
      if (stat.size >= LOG_ROTATE_SIZE_BYTES) {
        logFileStream.end();
        logFileStream = null;
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const newName = `apex-${ts}.log`;
        const newPath = path.join(SF_LOG_DIR, newName);
        currentLogFilePath = newPath;
        logFileStream = fs.createWriteStream(newPath, { flags: 'w' });
        currentLogPath = path.relative(PROJECT_DIR, newPath);
      }
    } catch (_) {}
  };
  const write = (text) => {
    logBuffer.push(text);
    if (logFileStream?.writable) {
      maybeRotateLog();
      if (logFileStream?.writable) logFileStream.write(text);
    }
  };
  tailProcess.stdout?.on('data', (c) => write(c.toString()));
  tailProcess.stderr?.on('data', (c) => write(c.toString()));
  tailProcess.on('close', () => {
    tailProcess = null;
    if (logFileStream) {
      try { logFileStream.end(); } catch (e) {}
      logFileStream = null;
    }
  });
  return { ok: true, org: org || '(default)', logPath: currentLogPath };
}

function stopAudit() {
  if (tailProcess) {
    tailProcess.kill('SIGTERM');
    tailProcess = null;
  }
  if (logFileStream) {
    try { logFileStream.end(); } catch (e) {}
    logFileStream = null;
  }
  return { ok: true, logPath: currentLogPath };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const send = (data, code = 200) => {
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (url.pathname === '/' && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) return res.writeHead(500, CORS).end('Error');
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/html' }).end(data);
    });
    return;
  }

  if (url.pathname === '/api/orgs') {
    const result = getConnectedOrgs(url.searchParams.get('refresh') === '1');
    return send(result);
  }

  if (url.pathname === '/api/set-default' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { org } = JSON.parse(body || '{}');
      send(setDefaultOrg(org));
    });
    return;
  }

  if (url.pathname === '/api/start' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { org } = JSON.parse(body || '{}');
      send(startAudit(org));
    });
    return;
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    return send(stopAudit());
  }

  if (url.pathname === '/api/logs') {
    return send({ logs: logBuffer.join(''), logPath: currentLogPath });
  }

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { logContent, useCursorAgent } = JSON.parse(body || '{}');
      const useAgent = useCursorAgent !== false;
      moveLogsToAnalysisFolder();
      const logsOnDisk = fs.existsSync(SF_LOG_ANALYSIS_DIR)
        ? (fs.readdirSync(SF_LOG_ANALYSIS_DIR) || []).filter((f) => f.endsWith('.log')).sort().reverse()
        : [];
      const latestLog = logsOnDisk[0];
      const content = logContent || (latestLog ? fs.readFileSync(path.join(SF_LOG_ANALYSIS_DIR, latestLog), 'utf8') : null) || logBuffer.join('');
      if (!content?.trim()) {
        return send({ report: 'No logs to analyze. Start audit and wait for output.', errors: [], source: 'none' });
      }
      if (useAgent) {
        if (!latestLog && content) {
          const tmpName = `apex-analysis-${Date.now()}.log`;
          fs.writeFileSync(path.join(SF_LOG_ANALYSIS_DIR, tmpName), content);
        }
        analyzeWithCursorAgent(SF_LOG_ANALYSIS_DIR, (result) => {
          if (result.ok) {
            return send({ report: result.report, errors: result.errors || [], source: 'cursor-agent' });
          }
          if (result.fallback) {
            const { report, errors } = analyzeLogs(content);
            return send({ report, errors, source: 'regex', agentError: result.error });
          }
          send({ report: result.error || 'Analysis failed', errors: [], source: 'error', agentError: result.error });
        });
      } else {
        const { report, errors } = analyzeLogs(content);
        send({ report, errors, source: 'regex' });
      }
    });
    return;
  }

  res.writeHead(404, CORS).end('Not found');
});

server.listen(PORT, () => {
  console.log(`Apex Log Monitor: http://localhost:${PORT}`);
  console.log(`Project: ${PROJECT_DIR}`);
  console.log(`Logs: ${SF_LOG_DIR}`);
});
