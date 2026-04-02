---
name: linkedin-apply-init
description: 'Initialize the LinkedIn Apply plugin — create vault candidate profile, install Playwright, and set up LinkedIn browser session. Triggers: "linkedin-apply-init" | "init linkedin apply" | "setup linkedin apply" | "linkedin apply setup".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# LinkedIn Apply — Init Skill

Set up everything needed to use `/linkedin-apply` for the first time. Run once before analyzing any job offers.

Let:
  VL := ~/.roxabi-vault/linkedin-apply/
  BP := ~/.config/linkedin_browser_profile/

## Phase 1 — Check Prerequisites

1. `python3 --version` → Python 3.10+ required.
2. `pip` or `uv` available for package installation.
3. `which claude` → `claude` CLI in PATH.

¬prerequisite → stop + tell user what to install.

## Phase 2 — Install Python Dependencies

```bash
pip install playwright playwright-stealth jinja2 pyyaml
# or with uv:
uv pip install playwright playwright-stealth jinja2 pyyaml
```

## Phase 3 — Install Playwright Chromium

```bash
python3 -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); p.stop()" 2>/dev/null && echo "ok"
```

Error ∨ ¬installed → `playwright install chromium`.

## Phase 4 — Set Up Vault Candidate Profile

Vault home: `~/.roxabi-vault/linkedin-apply/` (default) or `$ROXABI_VAULT_HOME/linkedin-apply/`.

¬`VL/candidate.yaml`:
1. `mkdir -p ~/.roxabi-vault/linkedin-apply`
2. Copy `$CLAUDE_PLUGIN_ROOT/../../examples/candidate.example.yaml` → `VL/candidate.yaml`
3. Inform user: "candidate.yaml created — please edit it with your real data before using /linkedin-apply"
4. Show required fields: `personal.full_name`, `personal.email`, `personal.phone`, `professional.current_title`, `professional.years_experience`, `preferences.salary`

∃`VL/candidate.yaml` → show summary (name, title, email masked as `a***@***.com`).

## Phase 5 — Set Up LinkedIn Browser Session

```bash
ls ~/.config/linkedin_browser_profile/ 2>/dev/null | head -5
```

¬session:
1. Tell user: log into LinkedIn manually in the browser.
2. Launch visible Chromium:
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
3. Wait for login + browser close. Confirm session saved (check BP files).

∃session → tell user session profile already present (may still be valid).

## Phase 6 — Summary

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
