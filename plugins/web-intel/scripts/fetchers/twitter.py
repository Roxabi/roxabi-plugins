#!/usr/bin/env python3
"""
Twitter/X content extraction module.

Supports:
- Regular tweets via cdn.syndication.twimg.com
- Note tweets (long tweets > 280 chars) via FxTwitter API fallback
- X Articles via Playwright (headless browser)

Security:
- SSRF protection via validate_url_ssrf
- Content size limits via fetch_with_size_limit
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

# Add paths for imports (needed when running as script or from tests)
SHARED_DIR = Path(__file__).resolve().parents[1] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parent
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import (
    BaseFetcher,
    DEFAULT_MAX_CONTENT_SIZE,
    sanitize_content,
    safe_fetch,
    extract_id_from_url,
)
from resolve_redirects import resolve_redirects, is_twitter_domain

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


def extract_tweet_id(url: str) -> Optional[str]:
    """Extract tweet ID from various Twitter/X URL formats."""
    # Clean URL
    url = url.split("?")[0]

    return extract_id_from_url(
        url,
        [
            r"/status/(\d+)",
            r"/i/article/(\d+)",
        ],
    )


def is_article_url(url: str) -> bool:
    """Check if URL is an X Article."""
    return "/i/article/" in url


def is_tco_only_tweet(text: str) -> Optional[str]:
    """Check if tweet is primarily a t.co link share.

    Detects tweets where the main content is a t.co shortened URL,
    even if they contain hashtags, mentions, or emoji.

    Args:
        text: Tweet text content

    Returns:
        The t.co URL if tweet is primarily a link share, None otherwise
    """
    if not text:
        return None

    # Find t.co link in the text
    match = re.search(r"(https?://t\.co/\w+)", text)
    if not match:
        return None

    tco_url = match.group(1)

    # Remove the t.co URL and check what's left
    remaining = text.replace(tco_url, "").strip()

    # Remove hashtags, mentions, and common punctuation
    remaining = re.sub(r"[#@]\w+", "", remaining)  # Remove hashtags and mentions
    remaining = re.sub(
        r"[\s\u200d\ufe0f\u2764\U0001F300-\U0001F9FF]+", "", remaining
    )  # Whitespace + emoji
    remaining = re.sub(r"[.,!?:;\-–—…]+", "", remaining)  # Punctuation

    # If remaining content is minimal (< 20 chars), it's primarily a link share
    if len(remaining) < 20:
        return tco_url

    return None


def resolve_tco_link(tco_url: str, timeout: float = 10.0) -> Optional[dict[str, Any]]:
    """Resolve a t.co shortened URL to its final destination.

    Uses the shared resolve_redirects utility with SSRF protection.

    Args:
        tco_url: URL like https://t.co/abc123
        timeout: Request timeout in seconds

    Returns:
        Dict with:
        - success: bool
        - resolved_url: str (final URL after redirects)
        - is_twitter: bool (True if resolved to x.com/twitter.com)
        - error: str (only if success=False)

        Returns None if resolution fails completely.
    """
    result = resolve_redirects(tco_url, timeout=timeout)

    if not result["success"]:
        logger.warning("Failed to resolve t.co link %s: %s", tco_url, result.get("error"))
        return None

    resolved_url = result["resolved_url"]
    is_twitter = is_twitter_domain(resolved_url)

    return {
        "success": True,
        "resolved_url": resolved_url,
        "is_twitter": is_twitter,
        "was_shortened": result["was_shortened"],
    }


def fetch_tweet_syndication(
    tweet_id: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch tweet data via syndication API.

    Args:
        tweet_id: Twitter/X tweet ID
        max_content_size: Maximum response size in bytes (default: 5MB)

    Returns:
        Dict with tweet data or error
    """
    url = f"https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&token=1"

    result = safe_fetch(url, max_size=max_content_size, fetcher_name="twitter")

    if not result["success"]:
        return {"success": False, "error": result["error"]}

    status_code = result["status_code"]

    if status_code == 200:
        data = json.loads(result["content"].decode("utf-8"))
        is_note_tweet = "note_tweet" in data

        # Extract in_reply_to for thread reconstruction
        in_reply_to = data.get("in_reply_to_status_id_str") or data.get("in_reply_to_status_id")
        parent_data = data.get("parent", {})
        if not in_reply_to and parent_data:
            in_reply_to = parent_data.get("id_str")

        return {
            "success": True,
            "type": "tweet",
            "id": tweet_id,
            "text": sanitize_content(data.get("text", "")),
            "author": f"@{data.get('user', {}).get('screen_name', 'unknown')}",
            "author_name": data.get("user", {}).get("name", ""),
            "created_at": data.get("created_at", ""),
            "likes": data.get("favorite_count", 0),
            "retweets": data.get("conversation_count", 0),
            "media": [m.get("media_url_https") for m in data.get("mediaDetails", [])],
            "is_note_tweet": is_note_tweet,
            "in_reply_to_status_id": in_reply_to,
        }
    elif status_code == 404:
        return {"success": False, "error": "Tweet not found or is an article"}
    else:
        return {"success": False, "error": f"HTTP {status_code}"}


def fetch_tweet_fxtwitter(
    tweet_id: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch full tweet data via FxTwitter API.

    FxTwitter returns the complete text for note tweets (> 280 chars)
    that the syndication API truncates.

    Args:
        tweet_id: Twitter/X tweet ID
        max_content_size: Maximum response size in bytes

    Returns:
        Dict with tweet data or error
    """
    url = f"https://api.fxtwitter.com/status/{tweet_id}"

    result = safe_fetch(
        url,
        headers={"User-Agent": "RoxabiWebIntel/1.0"},
        max_size=max_content_size,
        fetcher_name="twitter",
    )

    if not result["success"]:
        return {"success": False, "error": f"FxTwitter: {result['error']}"}

    if result["status_code"] != 200:
        return {"success": False, "error": f"FxTwitter HTTP {result['status_code']}"}

    try:
        data = json.loads(result["content"].decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return {"success": False, "error": f"FxTwitter parse error: {e}"}

    tweet = data.get("tweet")
    if not tweet:
        return {"success": False, "error": "FxTwitter: no tweet data in response"}

    author = tweet.get("author", {})
    return {
        "success": True,
        "type": "tweet",
        "id": tweet_id,
        "text": sanitize_content(tweet.get("text", "")),
        "author": f"@{author.get('screen_name', 'unknown')}",
        "author_name": author.get("name", ""),
        "created_at": tweet.get("created_at", ""),
        "likes": tweet.get("likes", 0),
        "retweets": tweet.get("retweets", 0),
        "media": [p.get("url", "") for p in (tweet.get("media", {}) or {}).get("photos", [])],
        "is_note_tweet": tweet.get("is_note_tweet", False),
    }


def fetch_thread_fxtwitter(
    tweet_id: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> Optional[dict[str, Any]]:
    """Fetch full thread via FxTwitter API.

    FxTwitter provides a thread endpoint that returns the full conversation.

    Args:
        tweet_id: Any tweet ID in the thread
        max_content_size: Maximum response size in bytes

    Returns:
        Dict with thread data or None if failed
    """
    url = f"https://api.fxtwitter.com/status/{tweet_id}"

    result = safe_fetch(
        url,
        headers={"User-Agent": "RoxabiWebIntel/1.0"},
        max_size=max_content_size,
        fetcher_name="twitter",
    )

    if not result["success"] or result["status_code"] != 200:
        return None

    try:
        data = json.loads(result["content"].decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None

    tweet = data.get("tweet")
    if not tweet:
        return None

    # Check if FxTwitter returned thread info
    thread_tweets = tweet.get("thread", [])
    if not thread_tweets:
        return None

    # Build thread from FxTwitter data
    tweets = []
    author = tweet.get("author", {})
    thread_author = f"@{author.get('screen_name', 'unknown')}"

    for t in thread_tweets:
        t_author = t.get("author", {})
        tweets.append(
            {
                "success": True,
                "type": "tweet",
                "id": t.get("id", ""),
                "text": sanitize_content(t.get("text", "")),
                "author": f"@{t_author.get('screen_name', 'unknown')}",
                "author_name": t_author.get("name", ""),
                "created_at": t.get("created_at", ""),
                "likes": t.get("likes", 0),
                "retweets": t.get("retweets", 0),
            }
        )

    if len(tweets) < 2:
        return None

    # Build combined thread result
    first_tweet = tweets[0]
    combined_text = "\n\n---\n\n".join(
        f"[{i + 1}/{len(tweets)}] {t.get('text', '')}" for i, t in enumerate(tweets)
    )

    return {
        "success": True,
        "type": "thread",
        "thread_size": len(tweets),
        "tweets": tweets,
        "text": sanitize_content(combined_text),
        "author": thread_author,
        "author_name": author.get("name", ""),
        "created_at": first_tweet.get("created_at", ""),
        "id": tweet_id,
        "first_tweet_id": first_tweet.get("id", ""),
    }


def fetch_thread_reconstruction(
    tweet_id: str,
    thread_author: str,
    max_depth: int = 20,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Reconstruct a Twitter thread by traversing in both directions.

    First traverses upward (via in_reply_to) to find the thread root,
    then collects all tweets from the same author.

    Args:
        tweet_id: Starting tweet ID (any position in thread)
        thread_author: Author handle (e.g., "@user") - only includes tweets from this author
        max_depth: Maximum number of tweets to fetch (default: 20)
        max_content_size: Maximum content size per request

    Returns:
        Dict with:
        - success: bool
        - type: "thread" if multiple tweets, "tweet" if single
        - thread_size: number of tweets in thread
        - tweets: list of tweet dicts in chronological order
        - text: combined text of all tweets (separated by newlines)
        - author: thread author (from first tweet)
        - error: str (only if success=False)

    Note:
        This makes N API calls for N tweets in the thread (~500ms each).
        Only includes tweets from the same author (self-thread).
        Deleted tweets in the chain will stop reconstruction.
    """
    # Try FxTwitter first for full thread support
    fx_thread = fetch_thread_fxtwitter(tweet_id, max_content_size)
    if fx_thread:
        logger.info("Got full thread from FxTwitter API")
        return fx_thread

    # Fallback: manual traversal upward
    logger.info("FxTwitter thread not available, traversing upward manually")

    tweets: list[dict[str, Any]] = []
    current_id: Optional[str] = tweet_id
    seen_ids: set[str] = set()

    while current_id and len(tweets) < max_depth:
        # Prevent infinite loops
        if current_id in seen_ids:
            logger.warning("Thread loop detected at tweet %s", current_id)
            break
        seen_ids.add(current_id)

        # Fetch current tweet
        result = fetch_tweet_syndication(current_id, max_content_size=max_content_size)
        if not result.get("success"):
            logger.warning(
                "Failed to fetch tweet %s in thread: %s", current_id, result.get("error")
            )
            break

        # Check if this tweet is from the same author
        tweet_author = result.get("author", "")
        if tweet_author.lower() != thread_author.lower():
            logger.info(
                "Tweet %s is from %s, not %s - stopping thread reconstruction",
                current_id,
                tweet_author,
                thread_author,
            )
            break

        # Insert at beginning for chronological order
        tweets.insert(0, result)

        # Get parent tweet ID
        current_id = result.get("in_reply_to_status_id")
        if current_id:
            current_id = str(current_id)

    if not tweets:
        return {"success": False, "error": "No tweets found in thread"}

    # If only one tweet, return as regular tweet
    if len(tweets) == 1:
        return tweets[0]

    # Build combined thread result
    first_tweet = tweets[0]
    combined_text = "\n\n---\n\n".join(
        f"[{i + 1}/{len(tweets)}] {t.get('text', '')}" for i, t in enumerate(tweets)
    )

    return {
        "success": True,
        "type": "thread",
        "thread_size": len(tweets),
        "tweets": tweets,
        "text": sanitize_content(combined_text),
        "author": first_tweet.get("author", ""),
        "author_name": first_tweet.get("author_name", ""),
        "created_at": first_tweet.get("created_at", ""),
        "id": tweet_id,  # Original requested tweet ID
        "first_tweet_id": first_tweet.get("id", ""),
    }


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


class TwitterFetcher(BaseFetcher):
    """Twitter/X content fetcher.

    Supports regular tweets, note tweets (> 280 chars), and X Articles.
    Uses multiple APIs for best content extraction.

    Example:
        >>> fetcher = TwitterFetcher()
        >>> result = fetcher.fetch("https://x.com/user/status/123")
        >>> if result["success"]:
        ...     print(result["data"]["text"])
    """

    content_type = "twitter"

    def _fetch_impl(
        self,
        url: str,
        max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
    ) -> dict:
        """
        Core implementation: fetch content from any Twitter/X URL.

        Automatically detects if URL is a tweet or article and uses
        the appropriate method.

        Args:
            url: Twitter/X URL to fetch
            max_content_size: Maximum content size in bytes (default: 5MB)

        Returns:
            Dict with content data or error

        Security:
            - Validates URL against SSRF attacks
            - Limits response size to prevent memory exhaustion
        """
        # Normalize URL
        url = url.replace("twitter.com", "x.com")

        # Check if it's an article
        if is_article_url(url):
            article_id = extract_tweet_id(url)
            if not article_id:
                return {"success": False, "error": "Could not extract article ID from URL"}
            article_res = fetch_article(article_id)
            return (
                article_res if article_res else {"success": False, "error": "Article fetch failed"}
            )

        # Regular tweet
        tweet_id = extract_tweet_id(url)
        if not tweet_id:
            return {"success": False, "error": "Could not extract tweet ID from URL"}

        # Try syndication API first
        result = fetch_tweet_syndication(tweet_id, max_content_size=max_content_size)

        # If syndication fails with 404, it might be an article linked from a tweet
        # Try to fetch as article
        if not result.get("success") and "not found" in result.get("error", "").lower():
            # The tweet might contain an article link - try article extraction
            article_result = fetch_article(tweet_id)
            if article_result and article_result.get("success"):
                return article_result

        # If syndication succeeded but tweet is a note tweet (> 280 chars, truncated),
        # use FxTwitter to get the full text
        if result.get("success") and result.get("is_note_tweet"):
            logger.info("Note tweet detected (id=%s), fetching full text via FxTwitter", tweet_id)
            fx_result = fetch_tweet_fxtwitter(tweet_id, max_content_size=max_content_size)
            if fx_result.get("success"):
                return fx_result
            logger.warning(
                "FxTwitter fallback failed: %s, using truncated syndication text",
                fx_result.get("error"),
            )

        # Check if tweet is part of a self-thread (reply to same author)
        if result.get("success") and result.get("in_reply_to_status_id"):
            parent_id = str(result.get("in_reply_to_status_id"))
            tweet_author = result.get("author", "")

            # Fetch parent to check if it's a self-thread
            parent_result = fetch_tweet_syndication(parent_id, max_content_size=max_content_size)
            parent_author = parent_result.get("author", "") if parent_result.get("success") else ""

            if parent_author.lower() == tweet_author.lower():
                # Self-thread detected, reconstruct
                logger.info(
                    "Tweet %s is a self-thread (same author: %s), reconstructing",
                    tweet_id,
                    tweet_author,
                )
                thread_result = fetch_thread_reconstruction(
                    tweet_id,
                    thread_author=tweet_author,
                    max_content_size=max_content_size,
                )
                if thread_result.get("success") and thread_result.get("type") == "thread":
                    return thread_result
                # If thread reconstruction failed or returned single tweet, continue with original
            else:
                logger.info(
                    "Tweet %s is a reply to %s (different author: %s), not a self-thread",
                    tweet_id,
                    parent_id,
                    parent_author,
                )

        # Check if tweet is primarily sharing a link (t.co)
        if result.get("success"):
            tco_url = is_tco_only_tweet(result.get("text", ""))
            if tco_url:
                logger.info("Tweet is primarily a t.co link share, resolving: %s", tco_url)
                resolved = resolve_tco_link(tco_url)

                if resolved and resolved.get("success"):
                    resolved_url = resolved["resolved_url"]

                    # Case 1: t.co → Twitter Article
                    if resolved.get("is_twitter") and is_article_url(resolved_url):
                        logger.info("t.co resolved to X Article: %s", resolved_url)
                        article_id = extract_tweet_id(resolved_url)
                        if article_id:
                            article_result = fetch_article(article_id)
                            if article_result and article_result.get("success"):
                                # Add reference to original tweet
                                article_result["shared_via_tweet"] = url
                                return article_result
                            # Article fetch failed — propagate error instead of
                            # returning useless tweet with only t.co URL
                            if article_result:
                                article_result["shared_via_tweet"] = url
                                return article_result
                            return {
                                "success": False,
                                "error": "Article fetch failed",
                                "shared_via_tweet": url,
                            }

                    # Case 2: t.co → Another Twitter/X URL (not article)
                    elif resolved.get("is_twitter"):
                        logger.info(
                            "t.co resolved to Twitter URL (not article): %s, returning redirect",
                            resolved_url,
                        )
                        return {
                            "success": True,
                            "redirect": True,
                            "resolved_url": resolved_url,
                            "original_tweet_url": url,
                            "original_tweet_text": result.get("text", ""),
                            "original_tweet_author": result.get("author", ""),
                            "_do_not_cache": True,  # Don't cache redirects to Twitter
                        }

                    # Case 3: t.co → External URL
                    else:
                        logger.info(
                            "t.co resolved to external domain: %s, returning redirect",
                            resolved_url,
                        )
                        return {
                            "success": True,
                            "redirect": True,
                            "resolved_url": resolved_url,
                            "original_tweet_url": url,
                            "original_tweet_text": result.get("text", ""),
                            "original_tweet_author": result.get("author", ""),
                        }

                # t.co resolution failed - don't cache incomplete result
                result["_do_not_cache"] = True
                logger.info("Tweet is t.co-only but resolution failed, marking as non-cacheable")

        return result

    def _transform_data(self, raw_result: dict[str, Any]) -> dict[str, Any]:
        """Transform raw Twitter result to standardized data dict."""
        text = raw_result.get("text", "")
        author = raw_result.get("author", "")
        author_name = raw_result.get("author_name", "")
        title = raw_result.get("title", "")
        tweet_type = raw_result.get("type", "tweet")

        # Build formatted text for easy consumption
        formatted_text = text
        if author or author_name:
            type_label = tweet_type
            if tweet_type == "thread":
                type_label = f"thread ({raw_result.get('thread_size', 1)} tweets)"
            formatted_text = f"Auteur: {author} ({author_name})\nType: {type_label}\nTitre: {title}\n\nContenu:\n{text}"

        result = {
            "text": formatted_text,
            "raw_text": text,
            "author": author,
            "author_name": author_name,
            "title": title,
            "type": tweet_type,
            "created_at": raw_result.get("created_at", ""),
            "likes": raw_result.get("likes", 0),
            "retweets": raw_result.get("retweets", 0),
            "media": raw_result.get("media", []),
            "is_note_tweet": raw_result.get("is_note_tweet", False),
        }

        # Add thread-specific fields
        if tweet_type == "thread":
            result["thread_size"] = raw_result.get("thread_size", 1)
            result["tweets"] = raw_result.get("tweets", [])
            result["first_tweet_id"] = raw_result.get("first_tweet_id", "")

        return result


# Backward-compatible module-level function
def fetch_twitter(url: str) -> dict[str, Any]:
    """
    Fetch content from a Twitter/X URL.

    Args:
        url: Twitter/X URL (tweet, article, or note)

    Returns:
        Dict with:
        - success: bool
        - content_type: "twitter"
        - url: original URL
        - data: dict with text, author, author_name, title, type, created_at
        - error: str (only if success=False)

    Example:
        >>> result = fetch_twitter("https://x.com/user/status/123")
        >>> if result["success"]:
        ...     print(result["data"]["text"])
    """
    return TwitterFetcher().fetch(url)


def main():
    """CLI interface for testing."""
    TwitterFetcher.run_cli()


if __name__ == "__main__":
    main()
