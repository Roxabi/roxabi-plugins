---
name: cv-init
description: 'Initialize the CV plugin — creates data directories and starter cv_data.json template. Triggers: "cv-init" | "init cv" | "setup cv".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob, AskUserQuestion
---

# CV Init

Set up the CV plugin data directories and starter files.

Let:
  V := ~/.roxabi-vault/cv/               — plugin data root
  G := V/generated/                      — generated CVs output
  A := V/adapted/                        — adapted CVs output
  D := V/cv_data.json                    — master CV data
  C := ~/.roxabi-vault/config/cv.json    — plugin config
  E := <plugin>/examples/cv_data.example.json — example data template

## Phase 1 — Check Existing State

```bash
echo "=== CV Plugin State ==="
test -d ~/.roxabi-vault/cv && echo "Data dir: EXISTS" || echo "Data dir: MISSING"
test -f ~/.roxabi-vault/cv/cv_data.json && echo "cv_data.json: EXISTS" || echo "cv_data.json: MISSING"
test -d ~/.roxabi-vault/cv/generated && echo "generated/: EXISTS" || echo "generated/: MISSING"
test -d ~/.roxabi-vault/cv/adapted && echo "adapted/: EXISTS" || echo "adapted/: MISSING"
test -f ~/.roxabi-vault/config/cv.json && echo "Config: EXISTS" || echo "Config: MISSING"
```

If D exists, AskUserQuestion: "cv_data.json already exists. Overwrite with template? (yes/no)". If no, skip data file creation.

## Phase 2 — Create Directories

```bash
mkdir -p ~/.roxabi-vault/cv/generated ~/.roxabi-vault/cv/adapted ~/.roxabi-vault/config
chmod 700 ~/.roxabi-vault/cv
```

## Phase 3 — Copy Starter Data

If D does not exist (or user approved overwrite):

1. Read E (the example file bundled with the plugin).
2. Write it to D.
3. Inform the user: "Created cv_data.json from template. Edit it with your real information before generating a CV."

## Phase 4 — Create Config

If C does not exist:

Write default config:
```json
{
  "default_format": "md",
  "default_template": "cv_template",
  "output_dir_generated": "~/.roxabi-vault/cv/generated",
  "output_dir_adapted": "~/.roxabi-vault/cv/adapted"
}
```

## Phase 5 — Report

```
CV Plugin Initialized
  Data directory:  ~/.roxabi-vault/cv/
  Generated CVs:   ~/.roxabi-vault/cv/generated/
  Adapted CVs:     ~/.roxabi-vault/cv/adapted/
  Master data:     ~/.roxabi-vault/cv/cv_data.json [NEW|EXISTING]
  Config:          ~/.roxabi-vault/config/cv.json [NEW|EXISTING]

Next step: edit cv_data.json with your information, then run /cv to generate.
```

$ARGUMENTS
