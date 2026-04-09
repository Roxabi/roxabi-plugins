# seed-community

Bootstrap OSS community health files — `CONTRIBUTING.md`, `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, PR template, and GitHub issue templates.

## Usage

```
/seed-community                          → Detect + generate all missing files
/seed-community --only SECURITY,CoC     → Generate specific files only
/seed-community --force                 → Overwrite even populated files
```

## What it does

1. Reads project metadata from `package.json` / `pyproject.toml` / `go.mod` + GitHub API
2. Reads `CLAUDE.md` for commit format, PR process, and stack notes
3. Detects which community health files are missing or below the content threshold
4. Asks for: license type, author/org name, optional extras (FUNDING.yml, CODEOWNERS)
5. Generates each missing file with project-specific content

## Files generated

| File | Contents |
|------|---------|
| `LICENSE` | Standard SPDX text (MIT, Apache-2.0, GPL-3.0) |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1 |
| `SECURITY.md` | Vulnerability reporting policy + GitHub Security Advisories link |
| `CONTRIBUTING.md` | Dev setup, test commands, commit format, branch naming, PR process |
| `.github/PULL_REQUEST_TEMPLATE.md` | Type of change + checklist |
| `.github/ISSUE_TEMPLATE/bug_report.md` | Steps to reproduce, environment |
| `.github/ISSUE_TEMPLATE/feature_request.md` | Problem + proposed solution |
| `README.md` | Adds missing Getting Started / Installation sections + badges |

Existing populated files are skipped unless `--force`. `LICENSE` is never overwritten.

## Triggers

`"seed community"` | `"add contributing"` | `"add license"` | `"add security policy"` | `"github community files"`
