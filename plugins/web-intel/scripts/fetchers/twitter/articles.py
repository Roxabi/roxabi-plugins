"""X Article extraction via headless Playwright + playwright-stealth."""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Optional

import requests

# Add paths for imports
SHARED_DIR = Path(__file__).resolve().parents[2] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parents[1]
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import sanitize_content
from roxabi_sdk.browser import (
    PlaywrightNotAvailableError,
    close_stealth,
    launch_stealth_sync,
)

logger = logging.getLogger(__name__)

# Selectors for X Article content extraction (ordered by preference)
ARTICLE_CONTENT_SELECTORS: tuple[str, ...] = (
    "main",  # Main content area usually has the full article
    "article",
    '[data-testid="article"]',
    '[role="article"]',
    '[data-testid="primaryColumn"]',
    "body",
)

# Wait time for dynamic content to load (ms)
ARTICLE_CONTENT_WAIT_MS = 5000

# Module-level pre-flight flag for callers that gate on availability
# before calling fetch_article_playwright.
try:
    import playwright  # noqa: F401

    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


def load_x_cookies(cookies_path: Optional[str] = None) -> list:
    """Load X cookies from file or environment."""
    import os

    # Default path
    if not cookies_path:
        cookies_path = os.path.expanduser("~/.config/x_cookies.json")

    # Try to load from file
    if os.path.exists(cookies_path):
        with open(cookies_path, "r") as f:
            cookies = json.load(f)
            # Convert EditThisCookie format to Playwright format if needed
            playwright_cookies = []
            for c in cookies:
                cookie = {
                    "name": c.get("name"),
                    "value": c.get("value"),
                    "domain": c.get("domain", ".x.com"),
                    "path": c.get("path", "/"),
                }
                if c.get("expirationDate"):
                    cookie["expires"] = c.get("expirationDate")
                if c.get("secure"):
                    cookie["secure"] = c.get("secure")
                if c.get("sameSite"):
                    cookie["sameSite"] = c.get("sameSite", "Lax")
                playwright_cookies.append(cookie)
            return playwright_cookies

    # Try environment variables for minimal auth
    auth_token = os.environ.get("X_AUTH_TOKEN")
    ct0 = os.environ.get("X_CT0")

    if auth_token and ct0:
        return [
            {"name": "auth_token", "value": auth_token, "domain": ".x.com", "path": "/"},
            {"name": "ct0", "value": ct0, "domain": ".x.com", "path": "/"},
        ]

    return []


# Twitter/X public web-client bearer token (used by the x.com SPA itself)
_TWITTER_BEARER = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs"
    "%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)

# GraphQL Viewer endpoint — returns 403 when no auth cookies are present,
# any other status (200/422) when the bearer+cookie layer was accepted.
# Used as a lightweight "is the session recognised at all?" probe.
_VIEWER_ENDPOINT = (
    "https://x.com/i/api/graphql/NimuplG1OB7Fd2btCLdBOw/Viewer"
    "?variables=%7B%7D&features=%7B%7D"
)

_COOKIE_REFRESH_GUIDE = (
    "To refresh your cookies:\n"
    "  1. Log into x.com in your browser\n"
    "  2. Export cookies with Cookie-Editor or EditThisCookie\n"
    "  3. Save as ~/.config/x_cookies.json"
)


def validate_x_session(cookies_path: Optional[str] = None) -> tuple[bool, Optional[str]]:
    """Validate X session cookies before attempting any authenticated fetch.

    Runs two checks in order:
      1. Structural — file exists and contains auth_token + ct0
      2. Live       — lightweight API call to verify the session is still active

    The live check uses a fast HTTP request (no browser overhead) and fails
    open on network errors so a transient DNS/timeout issue won't block fetches.

    Args:
        cookies_path: Optional override path to the cookies JSON file.

    Returns:
        ``(True, None)`` when the session is valid.
        ``(False, error_message)`` when cookies are missing, incomplete, or expired.
    """
    # 1. File existence
    path = cookies_path or os.path.expanduser("~/.config/x_cookies.json")
    if not os.path.exists(path):
        return False, f"No X cookies found at {path}\n{_COOKIE_REFRESH_GUIDE}"

    cookies = load_x_cookies(cookies_path)
    cookie_dict = {c["name"]: c["value"] for c in cookies}

    # 2. Structural check — required keys must be present and non-empty
    required = ["auth_token", "ct0"]
    missing = [k for k in required if not cookie_dict.get(k)]
    if missing:
        return False, (
            f"Missing required X cookies: {', '.join(missing)}\n{_COOKIE_REFRESH_GUIDE}"
        )

    # 3. Live session check — single HTTP call, no browser spin-up.
    #
    #    We probe the GraphQL Viewer endpoint with an intentionally minimal
    #    (malformed) query. X's auth layer runs before query validation:
    #      • HTTP 403  → bearer+cookie rejected outright → session invalid
    #      • HTTP 200  → valid session, query accepted
    #      • HTTP 4xx  → session was processed (auth ok), query malformed → treat as valid
    #      • HTTP 5xx / network error → X infra issue → fail open, don't block
    try:
        resp = requests.get(
            _VIEWER_ENDPOINT,
            cookies=cookie_dict,
            headers={
                "Authorization": f"Bearer {_TWITTER_BEARER}",
                "x-csrf-token": cookie_dict["ct0"],
                "x-twitter-active-user": "yes",
                "x-twitter-client-language": "en",
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
            },
            timeout=10,
        )
        if resp.status_code == 200:
            logger.debug("X session valid (Viewer → 200)")
            return True, None
        if resp.status_code == 403:
            # 403 is the unambiguous "auth rejected" signal from X's auth layer
            return False, (
                "X cookies are expired or invalid (HTTP 403).\n"
                f"{_COOKIE_REFRESH_GUIDE}"
            )
        # 4xx (e.g. 422 query-validation error) means auth was accepted, query rejected
        # 5xx means X infra is down — proceed optimistically in both cases
        logger.debug("X session check returned HTTP %s, proceeding", resp.status_code)
        return True, None
    except Exception as exc:
        # Network error — fail open so a transient issue doesn't block fetches
        logger.warning("X session validation request failed: %s — proceeding anyway", exc)
        return True, None


def _accept_x_cookies(page: Any, timeout: int = 5000) -> bool:
    """Accept X/Twitter cookies dialog if present.

    Args:
        page: Playwright page object
        timeout: Max time to wait for cookie button (ms)

    Returns:
        True if accepted or no dialog found, False on error
    """
    accept_selectors = [
        'button[data-testid="xMigrationBottomBar"] button',  # X migration banner
        '[data-testid="cookie-banner"] button',
        'button[aria-label*="Accept"]',
        'button[aria-label*="accept"]',
        '[role="button"]:has-text("Accept all")',
        '[role="button"]:has-text("Accept cookies")',
        '[role="button"]:has-text("Allow all")',
    ]
    for selector in accept_selectors:
        try:
            btn = page.query_selector(selector)
            if btn and btn.is_visible():
                btn.click()
                page.wait_for_timeout(1000)
                return True
        except Exception:
            pass
    return True  # No dialog found is OK


def _looks_like_cookie_banner(text: str) -> bool:
    """Detect if extracted text is primarily a cookie/consent banner.

    Args:
        text: Extracted page content

    Returns:
        True if text appears to be mostly cookie consent content
    """
    if not text or len(text) < 50:
        return True  # Too short to be real content

    text_lower = text.lower()
    banner_keywords = {
        "cookie",
        "consent",
        "gdpr",
        "privacy policy",
        "accept all",
        "reject all",
        "manage preferences",
        "advertising partners",
    }
    keyword_count = sum(1 for kw in banner_keywords if kw in text_lower)

    # If 3+ banner keywords and text is short, it's likely a banner
    if keyword_count >= 3 and len(text) < 500:
        return True

    # If banner keywords dominate the content
    if keyword_count >= 4:
        return True

    return False


def _extract_article_content(page: Any) -> str:
    """Extract the main article content from a Playwright page."""
    content = ""
    for selector in ARTICLE_CONTENT_SELECTORS:
        el = page.query_selector(selector)
        if el:
            text = el.inner_text()
            # Keep the longest content found
            if len(text) > len(content):
                content = text
    return content


def _extract_article_title(page: Any) -> str:
    """Extract article title from page title or h1."""
    title = page.title() or ""
    h1 = page.query_selector("h1")
    if h1:
        title = h1.inner_text()
    return title[:200] if title else ""


def _extract_article_author(page: Any) -> str:
    """Extract author from page content links."""
    author_links = page.query_selector_all('a[href^="/"]')
    for link in author_links[:10]:
        href = link.get_attribute("href")
        if href and href.count("/") == 1 and not href.startswith("/i/"):
            return "@" + href.strip("/")
    return ""


def _extract_article_date(page: Any) -> str:
    """Extract publication date from time element."""
    time_el = page.query_selector("time")
    if time_el:
        return time_el.get_attribute("datetime") or time_el.inner_text()
    return ""


def fetch_article_playwright(
    article_id: str, timeout: int = 60000, debug: bool = False, cookies_path: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Fetch X Article content via Playwright headless browser."""
    if not PLAYWRIGHT_AVAILABLE:
        return {
            "success": False,
            "error": "Playwright not installed. Run: uv sync --extra twitter && playwright install chromium",
        }

    url = f"https://x.com/i/article/{article_id}"
    cookies = load_x_cookies(cookies_path)

    pw = ctx = None
    try:
        try:
            pw, ctx, page = launch_stealth_sync(
                viewport={"width": 1280, "height": 2000},  # Taller viewport for articles
            )
        except PlaywrightNotAvailableError as exc:
            return {"success": False, "error": str(exc)}

        if cookies:
            ctx.add_cookies(cookies)

        page.goto(url, timeout=timeout, wait_until="domcontentloaded")

        # Dismiss cookie consent banner if present
        _accept_x_cookies(page)

        page.wait_for_timeout(ARTICLE_CONTENT_WAIT_MS)

        # Wait for article content to appear
        try:
            page.wait_for_selector("article", timeout=15000)
        except Exception:
            pass  # Continue even if selector not found

        page.wait_for_timeout(ARTICLE_CONTENT_WAIT_MS)

        if debug:
            page.screenshot(path="/tmp/x_article_debug.png", full_page=True)

        # Extract all metadata
        content = _extract_article_content(page)
        title = _extract_article_title(page)
        author = _extract_article_author(page)
        date = _extract_article_date(page)

        # Detect X's "This page is down" error before closing the browser so
        # we can navigate to /home and disambiguate auth failure from article
        # downtime without spinning up a second browser instance.
        if "this page is down" in content.lower():
            auth_ok = True
            try:
                page.goto("https://x.com/home", timeout=10000, wait_until="domcontentloaded")
                page.wait_for_timeout(2000)
                home_url = page.url
                auth_ok = "login" not in home_url and "/flow/" not in home_url
            except Exception:
                pass  # Can't determine — don't falsely flag as auth issue
            close_stealth(pw, ctx)
            pw = ctx = None
            if not auth_ok:
                return {
                    "success": False,
                    "error": (
                        "X cookies are expired or invalid "
                        "(session check redirected to login).\n"
                        f"{_COOKIE_REFRESH_GUIDE}"
                    ),
                }
            return {
                "success": False,
                "error": (
                    "X Article is unavailable. "
                    "The article may have been deleted or is temporarily offline."
                ),
            }

        # Check if we got cookie banner instead of real content
        if _looks_like_cookie_banner(content):
            return {
                "success": False,
                "error": "Could not dismiss cookie banner. Content extraction failed.",
                "debug_screenshot": "/tmp/x_article_debug.png" if debug else None,
            }

        if not content or len(content) < 50:
            return {
                "success": False,
                "error": "Could not extract article content. X may require login.",
                "debug_screenshot": "/tmp/x_article_debug.png" if debug else None,
            }

        return {
            "success": True,
            "type": "article",
            "id": article_id,
            "title": title,
            "text": sanitize_content(content),
            "author": author,
            "created_at": date,
            "url": url,
        }

    except Exception as e:
        return {"success": False, "error": f"Playwright error: {str(e)}"}
    finally:
        if pw is not None and ctx is not None:
            try:
                close_stealth(pw, ctx)
            except Exception:
                logger.debug("close_stealth raised during cleanup", exc_info=True)


def fetch_article(
    article_id: str, timeout: int = 60, cookies_path: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Fetch X Article via headless Playwright.

    Validates the X session via a lightweight API call before spinning up
    the browser, and returns a clear actionable error if cookies are missing
    or expired.

    Args:
        article_id: X Article ID
        timeout: Timeout in seconds
        cookies_path: Optional path to X cookies JSON

    Returns:
        Dict with article data or error
    """
    # Pre-flight: validate session before spinning up the browser
    is_valid, session_error = validate_x_session(cookies_path)
    if not is_valid:
        return {"success": False, "error": session_error}

    if not PLAYWRIGHT_AVAILABLE:
        return {
            "success": False,
            "error": (
                "Playwright not installed. "
                "Run: uv sync --extra twitter && uv run playwright install chromium"
            ),
        }

    logger.info("Fetching article %s via Playwright", article_id)
    return fetch_article_playwright(
        article_id, timeout=timeout * 1000, cookies_path=cookies_path
    )
