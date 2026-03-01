---
name: doctor
description: 'Health check — verify dev-core config, GitHub project, labels, workflows, branch protection. Triggers: "doctor" | "health check" | "check setup" | "verify config".'
version: 0.2.0
allowed-tools: Bash
---

# Doctor

Run the doctor CLI and display the report.

## Instructions

1. Run: `bun ${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts`
2. Display the output directly — it is pre-formatted.
3. If exit code is non-zero, suggest: "Run `/init` to fix missing items."
4. For JSON output: `bun ${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts --json`

$ARGUMENTS
