# linkedin-apply

Scrape LinkedIn job offers and score them against your profile with Claude LLM — APPLY / REVIEW / SKIP decisions with 4-dimension scoring.

## What it does

When you find a LinkedIn job posting, instead of reading it and guessing, run `/linkedin-apply <url>`. The plugin:

1. Opens a stealth browser (Playwright + persistent session) and scrapes the full job description
2. Loads your candidate profile from the vault
3. Sends both to Claude, which scores the match across 4 dimensions
4. Returns a clear decision with reasoning, score breakdown, and interview prep questions
5. Saves everything to your vault for tracking

**Decision outcomes:**
- **APPLY** (score ≥ 7.0): Strong match — worth applying
- **REVIEW** (score 5.0–6.9): Uncertain — review manually before deciding
- **SKIP** (score < 5.0 or dealbreaker): Poor fit — skip

**4-dimension scoring:**
- **Tech** (25%): Skills and stack alignment
- **Seniority** (25%): Experience level fit
- **Culture** (20%): Company culture and work style
- **Responsibilities** (30%): Day-to-day tasks match

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install linkedin-apply
```

## Setup (run once)

```
/linkedin-apply-init
```

This will:
1. Install Python dependencies (playwright, playwright-stealth, jinja2, pyyaml)
2. Install Playwright's Chromium browser
3. Create your candidate profile at `~/.roxabi-vault/linkedin-apply/candidate.yaml`
4. Open a browser so you can log into LinkedIn (session is saved for future runs)

After init, edit your candidate profile with real data — the skill copies a fictional example to get you started.

## Usage

```
/linkedin-apply https://www.linkedin.com/jobs/view/123456789/
```

Trigger phrases: `"linkedin apply"` | `"analyze job"` | `"job match"` | `"linkedin-apply"` | `"score this job"`

### Example output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DECISION: APPLY  |  Score: 7.8/10
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Job:     Senior Product Manager at TechCorp
  Type:    Easy Apply

  Scores:
    Tech:             8/10
    Seniority:        7/10
    Culture:          8/10
    Responsibilities: 8/10

  Highlights:
  + Strong match on SaaS product experience
  + Agile/Scrum methodology aligns with your background

  Prepare for:
  ? How do you prioritize features under pressure?
  ? Describe a product you took from 0 to 1

  Saved to: ~/.roxabi-vault/linkedin-apply/applications/2026-03/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Customizing criteria

Copy the default criteria file and edit to match your preferences:

```bash
cp ~/.claude/plugins/cache/roxabi-marketplace/linkedin-apply/*/config/criteria.yaml \
   ~/.roxabi-vault/linkedin-apply/criteria.yaml
```

Edit the file to set your dealbreakers, score weights, and preferences. The plugin loads your override automatically.

## Data storage

All data lives in `~/.roxabi-vault/linkedin-apply/`:

```
~/.roxabi-vault/linkedin-apply/
├── candidate.yaml           # Your profile (created by init)
├── criteria.yaml            # Optional scoring criteria override
└── applications/
    ├── index.jsonl          # Append-only log of all analyses
    └── YYYY-MM/
        └── YYYYMMDD_company_title/
            ├── recap.json        # Decision summary
            ├── job_snapshot.json # Job data at scrape time
            └── match_result.json # Full scoring breakdown
```

Browser profile at `~/.config/linkedin_browser_profile` (not in vault — managed by Playwright).

## How it works

**Scraping** uses Playwright with `playwright-stealth` to bypass LinkedIn's anti-bot detection. The persistent browser profile at `~/.config/linkedin_browser_profile` keeps you logged in between runs so you don't need to re-authenticate.

**Matching** renders your candidate profile and the job description into a structured prompt using Jinja2, then calls the Claude CLI (`claude -p`) to get a JSON analysis. Scores are recalculated locally with configurable weights to ensure consistency regardless of how Claude interprets the instructions.

**Storage** uses an append-only `index.jsonl` for fast lookup plus per-job directories for full data, following the Roxabi vault conventions.

## Phase 1 scope

This plugin implements Phase 1: **scrape + match + display + log**. It does not submit applications automatically.

Phase 2 (auto Easy Apply form filling) is planned but not yet implemented.

## Requirements

- Python 3.10+
- `playwright`, `playwright-stealth`, `jinja2`, `pyyaml` (installed by init skill)
- Chromium (installed via `playwright install chromium`)
- Claude CLI in PATH
- A LinkedIn account with a valid browser session
