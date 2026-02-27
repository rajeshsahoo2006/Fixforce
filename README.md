# Debugfast

**A Cursor Extension by Rajesh Sahoo** — AI-powered Salesforce Apex log monitoring & analysis.

> 📊 [View Presentation](https://github.com/rajeshsahoo2006/hackathon_presentation) · 🎬 [Watch Demo](https://github.com/rajeshsahoo2006/Debugfast-Demo)

Apex Log Monitor – stream debug logs and analyze for errors.

## Prerequisites

- **Node.js** (v16+) – Runtime for the app
- **Salesforce CLI** (`sf`) – For org operations and debug log tail
  - Install: `npm install -g @salesforce/cli` or [download](https://developer.salesforce.com/tools/salesforcecli)
- **Salesforce project** – You must run from a project directory containing `sfdx-project.json`, or set `SF_PROJECT_DIR` to point to one
- **Authenticated org** – At least one org connected via `sf org login web` or `sf auth login`
- **Cursor Agent CLI** (optional) – For AI-powered log analysis; app falls back to regex if unavailable

## Cursor Agent CLI – Install & Login

### macOS

```bash
# Install
curl https://cursor.com/install -fsS | bash

# Add to PATH (if not already)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc

# Login (opens browser)
agent login

# Verify
agent status
```

### Windows

**PowerShell (native):**
```powershell
# Install
irm 'https://cursor.com/install?win32=true' | iex

# Login (opens browser)
agent login

# Verify
agent status
```

**WSL / Linux:** Use the macOS instructions (curl install).

### Login options

- **Browser login** (default): `agent login` — opens browser to sign in with your Cursor account
- **No browser**: Set `NO_OPEN_BROWSER=1` before `agent login` to get a device code/link instead
- **API key**: For scripts/CI, set `CURSOR_API_KEY` or use `agent --api-key <key>`
- **Logout**: `agent logout`

### Verify installation

```bash
agent --version
agent models
```

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

**Folder structure (in your Salesforce project):**
- `.sf-log` – live logs (rotates at 1 MB)
- `.sf-log_Analysis` – logs moved here when you click **Analyze**; AI reads from this folder
- `.sf-log_archive` – on app load, existing logs are archived here (timestamped subfolders)

## VS Code Extension

Install the extension from `vscode-extension/` or run `npm run package` there to create a `.vsix`. Then use **Ctrl+Shift+P** → **Debugfast: Launch Log Analysis** to open the monitor inside VS Code/Cursor.
