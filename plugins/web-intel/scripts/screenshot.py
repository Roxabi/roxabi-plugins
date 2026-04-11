#!/usr/bin/env python3
"""
Full-page screenshot CLI — headless Chromium via Playwright.

Used as a fallback by ``/roast`` and ``/benchmark`` when the agent-browser
CLI is not installed. Reuses the Playwright stack already required for X
articles — no new dependencies.

Usage:
    uv run python scripts/screenshot.py <url> <output_path>

Exit codes:
    0 — screenshot written to ``<output_path>``
    1 — Playwright missing, SSRF block, navigation, or capture failure
        (error message on stderr)

Security:
    - SSRF validation before launching the browser
    - Headless-only
    - Bounded navigation timeout
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Tuple

# Add _shared to path for sibling imports (consistent with fetchers/*.py)
SHARED_DIR = Path(__file__).resolve().parent / "_shared"
if str(SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_DIR))

from validators_ssrf import validate_url_ssrf  # noqa: E402

# Navigation timeout (ms) — keep bounded so a hung site can't stall the agent
DEFAULT_TIMEOUT_MS = 30_000

# Wait after domcontentloaded for dynamic content / fonts to settle
POST_LOAD_WAIT_MS = 2_500

_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
_DEFAULT_VIEWPORT = {"width": 1280, "height": 900}

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

try:
    from playwright_stealth import Stealth as _Stealth

    PLAYWRIGHT_STEALTH_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_STEALTH_AVAILABLE = False


def capture_full_page(
    url: str,
    output_path: str,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> Tuple[bool, str]:
    """Capture a full-page PNG screenshot to disk.

    Args:
        url:         Target URL (re-validated for SSRF before launch).
        output_path: Destination file path for the PNG.
        timeout_ms:  Navigation timeout in milliseconds.

    Returns:
        ``(True, output_path)`` on success, ``(False, error_message)`` on failure.
    """
    if not PLAYWRIGHT_AVAILABLE:
        return (
            False,
            "Playwright not installed. "
            "Run: uv sync --extra twitter && uv run playwright install chromium",
        )

    is_valid, err = validate_url_ssrf(url)
    if not is_valid:
        return False, f"URL rejected by SSRF validation: {err}"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=_DEFAULT_USER_AGENT,
                viewport=_DEFAULT_VIEWPORT,
                locale="en-US",
            )
            page = context.new_page()

            if PLAYWRIGHT_STEALTH_AVAILABLE:
                _Stealth().use_sync(page)

            page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            # Let fonts, lazy images, and CF auto-redirects settle
            page.wait_for_timeout(POST_LOAD_WAIT_MS)
            page.screenshot(path=output_path, full_page=True)
            browser.close()
            return True, output_path

    except Exception as exc:
        return False, f"Screenshot failed: {exc}"


def main() -> int:
    """CLI entry point."""
    if len(sys.argv) != 3:
        print(
            "Usage: python screenshot.py <url> <output_path>",
            file=sys.stderr,
        )
        return 1

    url = sys.argv[1]
    output_path = sys.argv[2]

    success, result = capture_full_page(url, output_path)
    if success:
        print(result)
        return 0
    print(result, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
