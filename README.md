# Debugfast

Apex Log Monitor – stream debug logs and analyze for errors.

## Prerequisites

- **Node.js** (v16+) – Runtime for the app
- **Salesforce CLI** (`sf`) – For org operations and debug log tail
  - Install: `npm install -g @salesforce/cli` or [download](https://developer.salesforce.com/tools/salesforcecli)
- **Salesforce project** – You must run from a project directory containing `sfdx-project.json`, or set `SF_PROJECT_DIR` to point to one
- **Authenticated org** – At least one org connected via `sf org login web` or `sf auth login`
- **Cursor Agent CLI** (optional) – For AI-powered log analysis; app falls back to regex if unavailable
  - Install: `curl https://cursor.com/install -fsS | bash`

## Quick Start

1. Clone the repo
2. Run from your Salesforce project directory (must contain `sfdx-project.json`):

```bash
cd /path/to/your/salesforce-project
node /path/to/Debugfast/apex-log-monitor/server.js
```

Or from within `apex-log-monitor`, with the project path:

```bash
cd apex-log-monitor
SF_PROJECT_DIR=/path/to/your/salesforce-project npm start
```

3. Open **http://localhost:3456**

## Usage

1. **Find org** – Pick a connected org from the dropdown
2. **Set Default Org** – Set the selected org as the project default
3. **Start Audit** – Start streaming debug logs (uses `sf apex tail log`)
4. **Analyze** – Run error scan (Cursor AI if available, otherwise regex)
5. **Stop** – Stop the log stream

Logs are written to `.sf-log/` in your Salesforce project.

## VS Code Extension

Install the extension from `vscode-extension/` or run `npm run package` there to create a `.vsix`. Then use **Ctrl+Shift+P** → **Fastforce: Launch Log Analysis** to open the monitor inside VS Code/Cursor.
