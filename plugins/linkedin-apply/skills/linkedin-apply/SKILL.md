---
name: linkedin-apply
description: 'Scrape a LinkedIn job offer and score it against your profile using Claude LLM — produces APPLY / REVIEW / SKIP decision with 4-dimension scores. Triggers: "linkedin apply" | "analyze job" | "job match" | "linkedin-apply" | "score this job".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# LinkedIn Apply Skill

Analyze a LinkedIn job offer against your candidate profile and get an LLM-powered decision: **APPLY**, **REVIEW**, or **SKIP**.

## Phase 1 — Validate Arguments and Prerequisites

Extract the LinkedIn URL from $ARGUMENTS. If no URL is provided, tell the user:
"Usage: /linkedin-apply <linkedin-job-url>"
Then stop.

Validate URL format: must contain `linkedin.com` and `/jobs/view/` or `/jobs/`.

Check prerequisites:
1. `~/.roxabi-vault/linkedin-apply/candidate.yaml` exists — if not, tell user to run `/linkedin-apply-init` first
2. Python dependencies available: `python3 -c "import playwright, playwright_stealth, jinja2" 2>&1`
   - If missing, suggest: `pip install playwright playwright-stealth jinja2 pyyaml`
3. Playwright Chromium installed — if missing, suggest: `playwright install chromium`

## Phase 2 — Scrape the Job

Locate the scripts directory: `$CLAUDE_PLUGIN_ROOT/../../scripts/` relative to this skill.

Run the scraper:

```bash
cd <scripts_dir> && python3 scraper.py "<url>"
```

Capture stdout (JSON) and stderr (logs). If the command fails:
- `SessionExpiredError`: tell user to run `/linkedin-apply-init` to refresh the LinkedIn session
- `PlaywrightNotAvailableError`: suggest installing playwright
- `JobNotFoundError`: tell user the job is no longer available
- Other errors: show the error message

Parse the JSON output into a job data dict.

## Phase 3 — Load Candidate and Criteria

Load candidate profile:
```bash
cat ~/.roxabi-vault/linkedin-apply/candidate.yaml
```

Load criteria (user override takes precedence over plugin default):
1. Check `~/.roxabi-vault/linkedin-apply/criteria.yaml` — use if exists
2. Fall back to `<plugin_dir>/config/criteria.yaml`

## Phase 4 — Run LLM Matching

Locate the CV data file for rich matching context. Check in order:
1. `~/.roxabi-vault/cv/cv_data.json` (cv plugin data)
2. If not found, use candidate.yaml as simplified profile

Run the matcher:

```bash
cd <scripts_dir> && python3 matcher.py \
  --job-json /tmp/linkedin_job_<job_id>.json \
  --cv-json <cv_data_path> \
  --criteria-yaml <criteria_path> \
  --output json
```

If cv_data.json is not available, construct a minimal JSON from candidate.yaml fields and pass it as the CV.

Save the scraped job to a temp file first:
```bash
echo '<job_json>' > /tmp/linkedin_job_<job_id>.json
```

## Phase 5 — Save Results

Run storage:

```bash
cd <scripts_dir> && python3 -c "
import json, sys
sys.path.insert(0, '_lib')
from storage import save_analysis

# Import job and match from JSON files
# ... reconstruct dataclasses and call save_analysis(job, match)
"
```

Or use the storage CLI to verify the save was successful.

## Phase 6 — Display Results

Present a clear, formatted summary to the user:

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

For SKIP decisions, show the dealbreaker issues clearly.
For REVIEW decisions, highlight what's uncertain or missing.

## Notes

- The scraper opens a visible browser window (non-headless) for better reliability against LinkedIn's anti-bot detection
- Browser profile at `~/.config/linkedin_browser_profile` persists the session between runs
- Results are stored in `~/.roxabi-vault/linkedin-apply/applications/YYYY-MM/` for tracking
- Phase 1 only: scraping + matching + display. Auto-application (Easy Apply form filling) is Phase 2.

$ARGUMENTS
