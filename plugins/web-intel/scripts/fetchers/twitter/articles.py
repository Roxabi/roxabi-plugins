"""X Article extraction via agent-browser and Playwright."""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

# Add paths for imports
SHARED_DIR = Path(__file__).resolve().parents[2] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parents[1]
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import sanitize_content

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

# Browser automation: agent-browser (primary) or Playwright (fallback)
AGENT_BROWSER_AVAILABLE = shutil.which("agent-browser") is not None

try:
    from playwright.sync_api import sync_playwright

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


def _run_agent_browser(*args: str, timeout: int = 30) -> Optional[str]:
    """Run an agent-browser CLI command and return stdout.

    Args:
        *args: CLI arguments (e.g., "open", url)
        timeout: Command timeout in seconds

    Returns:
        stdout string on success, None on failure
    """
    try:
        result = subprocess.run(
            ["agent-browser", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            logger.debug("agent-browser %s failed: %s", args[0], result.stderr.strip())
            return None
        return result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        logger.debug("agent-browser %s error: %s", args[0], e)
        return None


def _agent_browser_close() -> None:
    """Close agent-browser, ignoring errors."""
    try:
        subprocess.run(
            ["agent-browser", "close"],
            capture_output=True,
            timeout=5,
        )
    except Exception:
        pass


def fetch_article_agent_browser(
    article_id: str,
    timeout: int = 60,
    cookies_path: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Fetch X Article content via agent-browser CLI.

    Primary method for article extraction. Falls back to None if
    agent-browser is not installed.

    Args:
        article_id: X Article ID
        timeout: Navigation timeout in seconds
        cookies_path: Optional path to X cookies JSON file

    Returns:
        Dict with article data, or None if agent-browser unavailable
    """
    if not AGENT_BROWSER_AVAILABLE:
        return None

    url = f"https://x.com/i/article/{article_id}"

    try:
        # Navigate to article
        nav_result = _run_agent_browser("open", url, timeout=timeout)
        if nav_result is None:
            _agent_browser_close()
            return {"success": False, "error": "agent-browser: failed to open URL"}

        # Load cookies if available
        cookies = load_x_cookies(cookies_path)
        if cookies:
            for cookie in cookies:
                _run_agent_browser(
                    "cookie", "set",
                    cookie["name"], cookie["value"],
                    "--domain", cookie.get("domain", ".x.com"),
                    "--path", cookie.get("path", "/"),
                    timeout=5,
                )
            # Reload with cookies applied
            _run_agent_browser("open", url, timeout=timeout)

        # Try to dismiss cookie banner
        for btn_text in ["Accept all cookies", "Accept all", "Allow all"]:
            result = _run_agent_browser("find", "text", btn_text, "click", timeout=3)
            if result is not None:
                import time
                time.sleep(1)
                break

        # Wait for dynamic content to load
        import time
        time.sleep(ARTICLE_CONTENT_WAIT_MS / 1000)

        # Extract content using CSS selectors (same as Playwright version)
        content = ""
        for selector in ARTICLE_CONTENT_SELECTORS:
            text = _run_agent_browser("get", "text", selector, timeout=10)
            if text and len(text.strip()) > len(content):
                content = text.strip()

        # Extract title (h1, then page title)
        title_js = (
            "(() => {"
            'const h1 = document.querySelector("h1");'
            "if (h1 && h1.innerText.trim()) return h1.innerText.trim();"
            "return document.title || '';"
            "})()"
        )
        title = (_run_agent_browser("eval", title_js, timeout=5) or "").strip()[:200]

        # Extract author from links
        author_js = (
            "(() => {"
            'const links = document.querySelectorAll(\'a[href^="/"]\');'
            "for (const link of [...links].slice(0, 10)) {"
            '  const href = link.getAttribute("href");'
            '  if (href && href.split("/").length === 2 && !href.startsWith("/i/")) {'
            '    return "@" + href.replace("/", "");'
            "  }"
            '} return "";})()'
        )
        author = (_run_agent_browser("eval", author_js, timeout=5) or "").strip()

        # Extract date
        date_js = (
            "(() => {"
            'const t = document.querySelector("time");'
            'return t ? (t.getAttribute("datetime") || t.innerText) : "";'
            "})()"
        )
        date = (_run_agent_browser("eval", date_js, timeout=5) or "").strip()

        _agent_browser_close()

        # Validate content
        if _looks_like_cookie_banner(content):
            return {
                "success": False,
                "error": "Could not dismiss cookie banner. Content extraction failed.",
            }

        if not content or len(content) < 50:
            return {
                "success": False,
                "error": "Could not extract article content. X may require login.",
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
        _agent_browser_close()
        return {"success": False, "error": f"agent-browser error: {str(e)}"}


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

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                viewport={"width": 1280, "height": 2000},  # Taller viewport for articles
            )

            if cookies:
                context.add_cookies(cookies)

            page = context.new_page()
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

            browser.close()

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


def fetch_article(
    article_id: str, timeout: int = 60, cookies_path: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Fetch X Article using agent-browser (primary) or Playwright (fallback).

    Args:
        article_id: X Article ID
        timeout: Timeout in seconds
        cookies_path: Optional path to X cookies JSON

    Returns:
        Dict with article data or error
    """
    # Try agent-browser first (fast Rust CLI)
    if AGENT_BROWSER_AVAILABLE:
        logger.info("Fetching article %s via agent-browser", article_id)
        result = fetch_article_agent_browser(article_id, timeout=timeout, cookies_path=cookies_path)
        if result is not None and result.get("success"):
            return result
        if result is not None:
            logger.warning(
                "agent-browser failed for article %s: %s, trying Playwright",
                article_id,
                result.get("error", "unknown"),
            )

    # Fallback to Playwright
    if PLAYWRIGHT_AVAILABLE:
        logger.info("Fetching article %s via Playwright", article_id)
        return fetch_article_playwright(article_id, timeout=timeout * 1000, cookies_path=cookies_path)

    return {
        "success": False,
        "error": (
            "No browser automation available. Install one of:\n"
            "  - agent-browser: npm install -g agent-browser && agent-browser install\n"
            "  - Playwright: uv sync --extra twitter && uv run playwright install chromium"
        ),
    }
