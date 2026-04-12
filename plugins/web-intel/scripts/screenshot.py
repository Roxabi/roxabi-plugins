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

import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

# Add _shared to path for sibling imports (consistent with fetchers/*.py)
SHARED_DIR = Path(__file__).resolve().parent / "_shared"
if str(SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_DIR))

from validators_ssrf import validate_url_ssrf  # noqa: E402

# Navigation timeout (ms) — keep bounded so a hung site can't stall the agent
DEFAULT_TIMEOUT_MS = 30_000

# Wait after domcontentloaded for dynamic content / fonts to settle
POST_LOAD_WAIT_MS = 2_500

from roxabi_sdk.browser import (  # noqa: E402
    PlaywrightNotAvailableError,
    close_stealth,
    launch_stealth_sync,
)

# Independent module-level pre-flight flags — kept separate from
# roxabi_sdk.browser._raise_if_unavailable so any future test that
# wants to monkey-patch them (mirroring tests/test_stealth.py:104) can
# still drive the "missing dep" branch without reaching into SDK internals.
try:
    import playwright  # noqa: F401

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

try:
    import playwright_stealth  # noqa: F401

    PLAYWRIGHT_STEALTH_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_STEALTH_AVAILABLE = False


def capture_full_page(
    url: str,
    output_path: str,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> tuple[bool, str]:
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

    pw = ctx = None
    try:
        try:
            pw, ctx, page = launch_stealth_sync()
        except PlaywrightNotAvailableError as exc:
            return False, str(exc)

        page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
        # Let fonts, lazy images, and CF auto-redirects settle
        page.wait_for_timeout(POST_LOAD_WAIT_MS)
        page.screenshot(path=output_path, full_page=True)
        return True, output_path

    except Exception as exc:
        return False, f"Screenshot failed: {exc}"
    finally:
        if pw is not None and ctx is not None:
            try:
                close_stealth(pw, ctx)
            except Exception:
                logger.debug("close_stealth raised during screenshot cleanup", exc_info=True)


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
