---
name: cv
description: 'Generate, adapt, and update CVs from structured data stored in cv_data.json. Triggers: "cv" | "generate cv" | "adapt cv" | "update cv" | "tailor cv".'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob, Grep
---

# CV

Generate professional CVs from structured data. Adapt them for specific job postings. Update the master data file.

Let:
  V := ~/.roxabi-vault/cv/               — plugin data root
  D := V/cv_data.json                    — master CV data
  G := V/generated/                      — generated CVs
  A := V/adapted/                        — job-adapted CVs
  T := <plugin>/templates/               — Jinja2 templates
  S := <plugin>/scripts/generate_cv.py   — generation script
  C := ~/.roxabi-vault/config/cv.json    — plugin config

## Self-Check

1. Verify D:
```bash
test -f ~/.roxabi-vault/cv/cv_data.json && echo "OK" || echo "MISSING"
```
¬D → "No cv_data.json found. Run /cv-init to set up the CV plugin." Halt.

2. Verify Jinja2:
```bash
python3 -c "import jinja2" 2>/dev/null && echo "OK" || echo "MISSING"
```
¬jinja2 → "Jinja2 is required. Install with: pip install jinja2". Halt.

## Phase 1 — Determine Intent

Parse $ARGUMENTS:

| Intent | Signal | Action |
|--------|--------|--------|
| **Generate** | "generate", "create", "build", no args | Generate CV from D |
| **Adapt** | "adapt", "tailor", "for [job]", URL or job description | Adapt CV for role |
| **Update** | "update", "add", "change", "edit" | Modify D |

Ambiguous → AskUserQuestion.

## Phase 2 — Generate

1. Read D. Determine format (md/html/all) and language (fr/en/all) from args or C. Default: C values.
2. Template: default `cv_template`; use `cv_template_rich` if D has `experiences` key with `title`/`dates`/`sections` fields, or user requests it.
3. Run:
```bash
python3 <plugin>/scripts/generate_cv.py --data ~/.roxabi-vault/cv/cv_data.json --lang <lang> --format <format> [--template cv_template_rich]
```
`--lang all` → one file per language (`cv_fr.md`, `cv_en.md`); `--lang fr` → `cv.md` (no suffix). `--format all` → md + html. Both `experience`/`experiences` keys accepted (aliased). Report output path(s).

## Phase 3 — Adapt

1. Read D. Gather job posting from $ARGUMENTS (URL or text); AskUserQuestion if missing.
2. Analyze posting: extract requirements, skills, keywords.
3. Adapt CV: reorder experience → relevant roles; emphasize matching skills; adjust summary → target role. ¬fabricate experience.
4. Write adapted data → `/tmp/cv_adapted.json`, generate:
```bash
python3 <plugin>/scripts/generate_cv.py --data /tmp/cv_adapted.json --output ~/.roxabi-vault/cv/adapted/cv_<company>_<date>.<format> --format <format>
```
5. Report changes + output path.

## Phase 4 — Update

Read D → present structure → AskUserQuestion (experience/skills/education/personal info) → apply changes → validate JSON.

## Vault Integration (Optional)

```bash
test -f ~/.roxabi-vault/vault.db && echo "VAULT_AVAILABLE" || echo "NO_VAULT"
```
VAULT_AVAILABLE → after generate/adapt: index output file with `category=cv` + type tag.

$ARGUMENTS
