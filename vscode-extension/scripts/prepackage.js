const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', '..', 'apex-log-monitor');
const dest = path.join(__dirname, '..', 'apex-log-monitor');
if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
