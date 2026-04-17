---
name: web-design-guidelines
description: 'Review UI code for Web Interface Guidelines compliance. Triggers: "review my UI" | "check accessibility" | "audit design" | "review UX" | "web design guidelines".'
version: 0.1.0
allowed-tools: Read, Glob, Grep, WebFetch
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## Workflow

1. Fetch latest guidelines:
   ```
   https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
   ```
   WebFetch → retrieves all rules and output format instructions.

2. $ARGUMENTS ∃ → read those files. ∄ → ask which files to review.

3. Check all files against fetched guidelines.

4. Output findings in terse `file:line` format specified in guidelines.

$ARGUMENTS
