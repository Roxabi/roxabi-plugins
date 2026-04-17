# readme-upgrade

Audit and upgrade project documentation quality — `README.md`, `CONTRIBUTING.md`, and plugin READMEs — against the developer-tool documentation pattern.

## Usage

```
/readme-upgrade                          → Audit + improve all docs
/readme-upgrade --target root            → Root README.md only
/readme-upgrade --target plugins         → All plugin READMEs
/readme-upgrade --target contributing    → CONTRIBUTING.md only
/readme-upgrade --plugin dev-core        → One specific plugin README
/readme-upgrade --force                  → Re-audit even passing sections
```

## What it does

1. **Audits** each target file against a structured checklist
2. **Reports** findings: ✅ Pass · ⚠️ Weak · ❌ Missing — per section
3. **Applies targeted improvements** — fills gaps, strengthens weak sections, never rewrites passing content

## Quality checklists

**Root README** — Title + tagline · Badges · One-liner description · Why/Problem · Quick Start · How it works · Feature table (categorized) · Contributing · License

**Plugin README** — Name + one-liner · Why/use case · Install commands · Trigger phrases + examples · How it works · Configuration · Attribution

**CONTRIBUTING.md** — Dev setup · Test instructions · Commit format · PR process · Code review expectations

## Writing style

Direct and imperative. No filler. Each new section ≤150 words. Mermaid diagrams for workflows (ASCII fallback for npm packages). Feature tables grouped by category.

## Triggers

`"improve readme"` | `"upgrade docs"` | `"readme quality"` | `"readme upgrade"` | `"docs health"`
