# Apex Log Error Analysis – Cursor Agent Instructions

You are analyzing Salesforce Apex debug logs for errors. Follow these steps:

## 1. Refer to the Log Folder

- The log folder is `.sf-log_Analysis` (full path provided in the Context section below).
- Read all `.log` files in `.sf-log_Analysis`, starting with the most recent.
- Focus on the latest log file if multiple exist.

## 2. Show the Errors

- List all errors found in the logs.
- Include error types (e.g. EXCEPTION_THROWN, FATAL_ERROR, VALIDATION_FAIL, NullPointerException, System.LimitException).
- For each error, show:
  - Error type
  - Relevant log line(s)
  - Context (surrounding lines) when helpful
  - Source class/method if present in the log

## 3. Fetch File from Org (SF CLI)

- For each error that references an Apex class, trigger, or other metadata:
  - Run `sf project retrieve start --metadata ApexClass:<ClassName>` (or appropriate metadata type) to fetch the file from the default org.
  - Use the target org already configured for the project.
  - If the class name is not clear from the log, infer from stack traces or suggest which metadata to retrieve.

## 4. Find the Error and Suggest Fix

- Open the retrieved Apex/metadata file.
- Locate the line(s) that correspond to the error.
- Suggest a concrete fix:
  - Add null checks for NullPointerException
  - Add try/catch for unhandled exceptions
  - Optimize SOQL/DML for limit exceptions
  - Adjust validation rule formulas when applicable
- Provide code snippets showing the suggested fix.
- Format the output in clear markdown with headings, code blocks, and numbered steps.

## Output Format

Respond in valid Markdown suitable for HTML rendering. Use:

- `##` and `###` for sections
- Code blocks with ` ```apex ` or ` ```javascript ` for Apex code
- Bullet lists for multiple errors and suggestions
- Bold for emphasis on important terms
