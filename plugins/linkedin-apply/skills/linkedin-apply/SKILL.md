---
name: linkedin-apply
description: 'Scrape a LinkedIn job offer and score it against your profile using Claude LLM — produces APPLY / REVIEW / SKIP decision with 4-dimension scores. Triggers: "linkedin apply" | "analyze job" | "job match" | "linkedin-apply" | "score this job".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# LinkedIn Apply Skill

Analyze a LinkedIn job offer against your candidate profile and get an LLM-powered decision: **APPLY**, **REVIEW**, or **SKIP**.

Let:
  VL := ~/.roxabi-vault/linkedin-apply/
  SD := `$CLAUDE_PLUGIN_ROOT/../../scripts/`

## Phase 1 — Validate Arguments and Prerequisites

Extract LinkedIn URL from $ARGUMENTS. ¬URL → "Usage: /linkedin-apply <linkedin-job-url>" → stop.

URL valid ⟺ contains `linkedin.com` ∧ (`/jobs/view/` ∨ `/jobs/`).

Check prerequisites:
1. `VL/candidate.yaml` exists — ¬exists → run `/linkedin-apply-init` first
2. `python3 -c "import playwright, playwright_stealth, jinja2" 2>&1` — missing → `pip install playwright playwright-stealth jinja2 pyyaml`
3. Playwright Chromium installed — missing → `playwright install chromium`

## Phase 2 — Scrape the Job

```bash
cd <scripts_dir> && python3 scraper.py "<url>"
```

Capture stdout (JSON) + stderr (logs). Errors: `SessionExpiredError` → run `/linkedin-apply-init`; `PlaywrightNotAvailableError` → install playwright; `JobNotFoundError` → job no longer available; other → show message. Parse JSON output → job data dict.

## Phase 3 — Load Candidate and Criteria

```bash
cat ~/.roxabi-vault/linkedin-apply/candidate.yaml
```

Criteria (user override ≻ plugin default): `VL/criteria.yaml` if ∃, else `<plugin_dir>/config/criteria.yaml`.

## Phase 4 — Run LLM Matching

CV path: `~/.roxabi-vault/cv/cv_data.json` if ∃, else construct minimal JSON from `candidate.yaml`.

```bash
echo '<job_json>' > /tmp/linkedin_job_<job_id>.json
cd <scripts_dir> && python3 matcher.py \
  --job-json /tmp/linkedin_job_<job_id>.json \
  --cv-json <cv_data_path> \
  --criteria-yaml <criteria_path> \
  --output json
```

## Phase 5 — Save Results

```bash
cd <scripts_dir> && python3 -c "
import json, sys
sys.path.insert(0, '_lib')
from storage import save_analysis
# reconstruct dataclasses and call save_analysis(job, match)
"
```

## Phase 6 — Display Results

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DECISION: APPLY  |  Score: 7.8/10
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Job:     <title> at <company>
  URL:     <url>
  Type:    <Easy Apply / External (ATS: greenhouse)>

  Scores:
    Tech:             8/10
    Seniority:        7/10
    Culture:          8/10
    Responsibilities: 8/10

  Dealbreakers: PASS

  Highlights:
  + <highlight 1>
  + <highlight 2>

  Prepare for:
  ? <expected question 1>
  ? <expected question 2>

  Summary: <analysis_summary>

  Saved to: ~/.roxabi-vault/linkedin-apply/applications/<path>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

SKIP → show dealbreaker issues clearly. REVIEW → highlight what's uncertain/missing.

## Notes

- Scraper uses visible browser (¬headless) for anti-bot reliability
- Browser profile `~/.config/linkedin_browser_profile` persists session between runs
- Results stored in `VL/applications/YYYY-MM/`
- Phase 1 only: scraping + matching + display. Auto-application (Easy Apply form filling) is Phase 2.

$ARGUMENTS
