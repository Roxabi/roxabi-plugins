# checkup

Health check — verify dev-core configuration, GitHub project, labels, workflows, and branch protection.

## Why

After running `/init` (or when something seems off), you want a single command that verifies the full configuration is correct and functional — not just that the files exist, but that the values work. `/checkup` runs all checks inline and fixes issues it finds without redirecting you to other skills.

## Usage

```
/checkup
```

Triggers: `"checkup"` | `"health check"` | `"check setup"` | `"verify config"`

## How it works

Runs three phases of checks, each loaded from a cookbook file:

**Phase 1 — dev-core checks** — verifies `.claude/dev-core.yml` exists and has required fields (`github_repo`, `gh_project_id`, field IDs), confirms the GitHub project board is accessible, and checks that env vars are set correctly.

**Phase 2 — Stack configuration** — verifies `.claude/stack.yml` is present, imported in CLAUDE.md (`@.claude/stack.yml`), and that required fields (`runtime`, `commands.*`) are set.

**Phase 3 — Workspace health** — checks git remote, branch protection rules, label completeness, and workspace registration.

## Severity guide

| Icon | Meaning |
|------|---------|
| ❌ | Blocking error — must fix before using dev-core |
| ⚠️ | Warning — may cause issues |
| ✅ | Pass |
| ⏭ | Skipped (not applicable) |

Issues are fixed inline where possible (e.g., adding missing `.gitignore` entries). Checks that require a sub-skill are reported with the command to run.
