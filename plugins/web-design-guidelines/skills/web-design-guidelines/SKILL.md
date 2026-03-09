---
name: web-design-guidelines
description: 'Review UI code for Web Interface Guidelines compliance. Triggers: "review my UI" | "check accessibility" | "audit design" | "review UX" | "web design guidelines".'
version: 0.1.0
allowed-tools: Read, Glob, Grep, WebFetch
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## Workflow

1. Fetch the latest guidelines from the source URL:
   ```
   https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
   ```
   Use WebFetch to retrieve the latest rules. The fetched content contains all the rules and output format instructions.

2. If the user provided files or a pattern via `$ARGUMENTS`, read those files. Otherwise, ask which files to review.

3. Check all files against the fetched guidelines.

4. Output findings in the terse `file:line` format specified in the guidelines.

$ARGUMENTS
