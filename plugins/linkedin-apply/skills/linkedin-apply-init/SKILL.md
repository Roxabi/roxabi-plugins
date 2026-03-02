---
name: linkedin-apply-init
description: 'Initialize the LinkedIn Apply plugin — create vault candidate profile, install Playwright, and set up LinkedIn browser session. Triggers: "linkedin-apply-init" | "init linkedin apply" | "setup linkedin apply" | "linkedin apply setup".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# LinkedIn Apply — Init Skill

Set up everything needed to use `/linkedin-apply` for the first time. Run this once before analyzing any job offers.

## Phase 1 — Check Prerequisites

1. Check that Python 3.10+ is available: `python3 --version`
2. Check that `pip` or `uv` is available for package installation
3. Check that `claude` CLI is in PATH: `which claude`

If any prerequisite is missing, stop and tell the user what to install.

## Phase 2 — Install Python Dependencies

Install required packages if not already installed:

```bash
pip install playwright playwright-stealth jinja2 pyyaml
```

Or with uv if available:
```bash
uv pip install playwright playwright-stealth jinja2 pyyaml
```

## Phase 3 — Install Playwright Chromium

Check if Playwright's Chromium is installed:

```bash
python3 -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); p.stop()" 2>/dev/null && echo "ok"
```

If not installed or error:
```bash
playwright install chromium
```

## Phase 4 — Set Up Vault Candidate Profile

Determine vault home:
- Default: `~/.roxabi-vault/linkedin-apply/`
- Override: `$ROXABI_VAULT_HOME/linkedin-apply/` if env var is set

Check if `~/.roxabi-vault/linkedin-apply/candidate.yaml` exists.

**If it does NOT exist:**
1. Create the directory: `mkdir -p ~/.roxabi-vault/linkedin-apply`
2. Find the plugin's `examples/candidate.example.yaml` — it's in `$CLAUDE_PLUGIN_ROOT/../../examples/candidate.example.yaml` relative to this skill
3. Copy it to `~/.roxabi-vault/linkedin-apply/candidate.yaml`
4. Tell the user: "candidate.yaml created at ~/.roxabi-vault/linkedin-apply/candidate.yaml — please edit it with your real data before using /linkedin-apply"
5. Show the key fields they must fill in: `personal.full_name`, `personal.email`, `personal.phone`, `professional.current_title`, `professional.years_experience`, `preferences.salary`

**If it already exists:**
- Tell the user it already exists and show a summary of what's in it (name, title, email masked as `a***@***.com`)

## Phase 5 — Set Up LinkedIn Browser Session

The scraper uses a persistent Chromium profile at `~/.config/linkedin_browser_profile/`.

Check if the profile directory exists and has session data:

```bash
ls ~/.config/linkedin_browser_profile/ 2>/dev/null | head -5
```

**If no session exists:**
1. Tell the user they need to log into LinkedIn manually in the browser
2. Launch Chromium in visible (non-headless) mode pointing to the profile:

```bash
python3 -c "
import asyncio
from playwright.async_api import async_playwright

async def open_browser():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir='$HOME/.config/linkedin_browser_profile',
            headless=False,
            viewport={'width': 1280, 'height': 900}
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto('https://www.linkedin.com/login')
        print('Browser opened — log in to LinkedIn, then close the browser window.')
        await page.wait_for_event('close', timeout=300000)
        await ctx.close()

asyncio.run(open_browser())
"
```

3. Wait for the user to log in and close the browser
4. Confirm the session was saved by checking if profile files exist

**If session exists:**
- Tell the user a session profile is already present (may still be valid)

## Phase 6 — Summary

Print a setup summary:

```
✓ Python dependencies installed
✓ Playwright Chromium ready
✓ candidate.yaml: <path>
✓ LinkedIn session: <found/created>

Next steps:
1. Edit ~/.roxabi-vault/linkedin-apply/candidate.yaml with your real data
2. Run: /linkedin-apply <linkedin-job-url>
```

$ARGUMENTS
