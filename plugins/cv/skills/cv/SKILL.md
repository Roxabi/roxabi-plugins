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

1. Verify D exists:
```bash
test -f ~/.roxabi-vault/cv/cv_data.json && echo "OK" || echo "MISSING"
```

2. D missing → inform the user: "No cv_data.json found. Run /cv-init to set up the CV plugin." Halt.

3. Verify Jinja2 is available:
```bash
python3 -c "import jinja2" 2>/dev/null && echo "OK" || echo "MISSING"
```

4. Jinja2 missing → inform the user: "Jinja2 is required. Install with: pip install jinja2". Halt.

## Phase 1 — Determine Intent

Parse $ARGUMENTS to determine the operation:

| Intent | Signal | Action |
|--------|--------|--------|
| **Generate** | "generate", "create", "build", no args | Generate CV from D |
| **Adapt** | "adapt", "tailor", "for [job]", URL or job description | Adapt CV for a specific role |
| **Update** | "update", "add", "change", "edit" | Modify D |

AskUserQuestion if intent is ambiguous.

## Phase 2 — Generate

1. Read D.
2. Determine format (md, html, or all) from args or config. Default: from config.
3. Determine language (fr, en, or all) from args or config. Default: from config `default_language`.
4. Run the generation script:
```bash
python3 <plugin>/scripts/generate_cv.py --data ~/.roxabi-vault/cv/cv_data.json --lang <lang> --format <format>
```
   - `--lang all` generates one file per supported language (`cv_fr.md`, `cv_en.md`)
   - `--lang fr` generates a single file (`cv.md`, no language suffix)
   - `--format all` generates both md and html
5. Report the output path(s).

## Phase 3 — Adapt

1. Read D.
2. Gather the job posting — from $ARGUMENTS (URL or pasted text). AskUserQuestion if not provided.
3. Analyze the job posting: extract key requirements, skills, keywords.
4. Create an adapted version of the CV:
   - Reorder experience to highlight relevant roles
   - Emphasize matching skills
   - Adjust the summary to target the role
   - Keep all facts truthful — never fabricate experience
5. Write adapted data to a temporary JSON, generate CV:
```bash
python3 <plugin>/scripts/generate_cv.py --data /tmp/cv_adapted.json --output ~/.roxabi-vault/cv/adapted/cv_<company>_<date>.<format> --format <format>
```
6. Report what was changed and the output path.

## Phase 4 — Update

1. Read D.
2. Present current structure to the user.
3. AskUserQuestion: what to update (experience, skills, education, personal info).
4. Apply changes to D.
5. Validate the JSON structure after editing.

## Vault Integration (Optional)

If vault is available, index generated CVs:
```bash
test -f ~/.roxabi-vault/vault.db && echo "VAULT_AVAILABLE" || echo "NO_VAULT"
```

When vault is available, after generating or adapting:
- Index the output file with category=cv and appropriate type tag.

$ARGUMENTS
