# Apex Log Monitor

Stream Apex debug logs and analyze errors using Cursor Agent CLI (with regex fallback).

## Run

Must run from inside a Salesforce project (has `sfdx-project.json`), or set `SF_PROJECT_DIR`:

```bash
cd /path/to/your/sf-project
node /Users/rsahoo/Debugfast/apex-log-monitor/server.js
```

Or with env:
```bash
SF_PROJECT_DIR=/path/to/your/sf-project node server.js
```

Open **http://localhost:3456**

Logs are saved to `.sf-log/` in the project root.

## Prerequisites

- **Cursor Agent CLI** for AI analysis: `curl https://cursor.com/install -fsS | bash`
- **Salesforce CLI** (`sf`) for log tail and org operations

## Usage

1. **Find org** – Select a connected org from the dropdown.
2. **Set Default Org** – Click to set the selected org as project default.
3. **Start Audit** – Enables debug log tail. Logs stream in real time.
4. **Analyze (Cursor AI)** – Runs Cursor Agent CLI with the prompt in `prompts/apex-log-analysis.md`:
   - Reads `.sf-log` folder
   - Lists errors from Apex logs
   - Fetches metadata from org via `sf project retrieve start`
   - Suggests fixes with code snippets
   - Output rendered as styled HTML
5. **Stop** – Stops the log stream.

## Log Rotation

When the current log file exceeds **1 MB**, a new file is created automatically (e.g. `apex-2025-02-13T12-30-45.log`).

## Prompt File

Edit `prompts/apex-log-analysis.md` to customize Cursor Agent behavior.
