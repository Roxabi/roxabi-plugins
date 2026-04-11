#!/usr/bin/env python3
"""
Stealth browser fallback for anti-bot protected pages.

Reuses the Playwright + playwright-stealth stack already required by the
Twitter/X article path. This module is NOT a standalone fetcher — it's a
fallback utility invoked by ``generic.py`` when the fast path (plain HTTP
via ``safe_fetch`` + Trafilatura) fails to extract meaningful content or
hits an anti-bot signature.

Triggers for a stealth retry:
  - HTTP 403 / 429 / 503 from the fast path
  - Cloudflare / generic anti-bot challenge markers in the body
  - Post-Trafilatura extracted text < 50 chars (page rendered nothing useful)

The module does NOT attempt to solve Cloudflare Turnstile challenges —
it only bypasses the plain-TLS / headless-fingerprint heuristics that
block basic HTTP clients. For Turnstile-gated sites the fallback will
still fail; callers should surface the original fast-path error.

Security:
  - SSRF validation before launching the browser
  - Headless-only mode
  - Bounded navigation timeout
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

# Add _shared to path for sibling imports (consistent with other fetchers)
SHARED_DIR = Path(__file__).resolve().parents[1] / "_shared"
if str(SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_DIR))

from validators_ssrf import validate_url_ssrf  # noqa: E402

logger = logging.getLogger(__name__)

# Cloudflare / generic anti-bot challenge markers
CF_CHALLENGE_MARKERS: tuple[str, ...] = (
    "Just a moment...",
    "Attention Required! | Cloudflare",
    "cf-browser-verification",
    "cf-challenge",
    "challenge-platform",
    "Enable JavaScript and cookies to continue",
    "_cf_chl_opt",
)

# HTTP status codes that usually indicate bot protection kicked in
ANTIBOT_STATUS_CODES: frozenset[int] = frozenset({403, 429, 503})

# Below this length, we assume the fast-path page rendered nothing useful
MIN_USEFUL_CONTENT_LENGTH = 50

# Navigation timeout (ms) — keep bounded so a hung site cannot stall the agent
DEFAULT_TIMEOUT_MS = 30_000

# Wait after domcontentloaded for dynamic content / CF auto-redirect
POST_LOAD_WAIT_MS = 2_500

# Viewport + UA tuned to match a common desktop Chrome fingerprint
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


def has_antibot_signature(
    status_code: Optional[int] = None,
    html: Optional[str] = None,
    text_length: Optional[int] = None,
) -> bool:
    """Detect whether a fast-path fetch looks like it hit anti-bot protection.

    Args:
        status_code: HTTP status from the fast-path fetch (``None`` if no response).
        html:        Raw HTML body returned by the fast path (``None`` if not available).
        text_length: Length of text extracted by Trafilatura on the fast-path
                     HTML (``None`` if no extraction was attempted).

    Returns:
        ``True`` if a stealth retry is warranted.
    """
    if status_code in ANTIBOT_STATUS_CODES:
        return True
    if html:
        for marker in CF_CHALLENGE_MARKERS:
            if marker in html:
                return True
    if text_length is not None and text_length < MIN_USEFUL_CONTENT_LENGTH:
        return True
    return False


def fetch_html_stealth(
    url: str,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> Optional[str]:
    """Fetch a URL's rendered HTML using headless Chromium + stealth patches.

    Intended as a fallback for anti-bot protected pages. Returns ``None`` on
    failure — the caller decides how to surface the error (typically by
    falling back to the original fast-path error message).

    Args:
        url:        URL to fetch. Re-validated for SSRF before launching.
        timeout_ms: Navigation timeout in milliseconds.

    Returns:
        Rendered HTML string on success, ``None`` on any failure.
    """
    if not PLAYWRIGHT_AVAILABLE:
        logger.debug("Playwright unavailable — cannot run stealth fallback")
        return None

    # SSRF pre-flight — the fast path already validated, but defense in depth
    is_valid, err = validate_url_ssrf(url)
    if not is_valid:
        logger.warning("Stealth fetch refused by SSRF validation: %s", err)
        return None

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
                logger.debug("playwright-stealth patches applied")
            else:
                logger.debug("playwright-stealth not installed; running without stealth")

            page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            # Let dynamic content settle — CF challenge pages typically
            # auto-redirect after ~1-2s when the stealth patches work
            page.wait_for_timeout(POST_LOAD_WAIT_MS)

            html = page.content()
            browser.close()

            # If we STILL see a challenge marker, stealth didn't bypass it —
            # don't pretend success, let the caller surface the original error
            for marker in CF_CHALLENGE_MARKERS:
                if marker in html:
                    logger.info(
                        "Stealth fetch still blocked by anti-bot challenge: %s", marker
                    )
                    return None

            return html

    except Exception as exc:
        logger.warning("Stealth fetch failed for %s: %s", url, exc)
        return None
