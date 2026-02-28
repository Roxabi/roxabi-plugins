#!/usr/bin/env python3
"""
Unified content scraper for various URL types.

Main entry point for the scraper skill. Provides a single function that
detects URL type and routes to the appropriate fetcher.

Usage:
    from scraper import scrape_content

    result = scrape_content("https://x.com/user/status/123")
    if result["success"]:
        print(result["content_type"])  # "twitter"
        print(result["data"]["text"])   # Content

CLI:
    uv run python scraper.py <url>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Ensure local imports work
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from utils.url_detector import detect_url_type, ContentType
from fetchers.twitter import fetch_twitter
from fetchers.github import fetch_github
from fetchers.gist import fetch_gist
from fetchers.youtube import fetch_youtube
from fetchers.reddit import fetch_reddit
from fetchers.generic import fetch_generic

# Add shared modules to path for resolve_redirects
import sys

SHARED_DIR = Path(__file__).resolve().parent / "_shared"
if str(SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_DIR))

from resolve_redirects import resolve_redirects, is_shortener


def scrape_content(url: str, _redirect_depth: int = 0) -> dict[str, Any]:
    """
    Extract content from a URL.

    Automatically detects the URL type (Twitter, GitHub, YouTube, Reddit)
    and routes to the appropriate fetcher. Resolves URL shorteners (t.co,
    bit.ly, etc.) before routing.

    Args:
        url: URL to scrape
        _redirect_depth: Internal counter to prevent infinite redirect loops

    Returns:
        Dict with:
        - success: bool - True if extraction succeeded
        - content_type: str - "twitter", "github", "youtube", "reddit", or "unknown"
        - url: str - Original URL
        - resolved_url: str - Final URL after shortener resolution (if different)
        - data: dict - Type-specific extracted data (on success)
            - text: str - Main content (always present on success)
            - ... other type-specific fields
        - error: str - Error message (only if success=False)
        - raw: dict - Raw fetcher response (for debugging, on success)

    Example:
        >>> result = scrape_content("https://x.com/user/status/123")
        >>> if result["success"]:
        ...     print(result["content_type"])  # "twitter"
        ...     print(result["data"]["text"])   # Tweet content

        >>> result = scrape_content("https://github.com/anthropics/claude-code")
        >>> if result["success"]:
        ...     print(result["data"]["stars"])  # Repository stars

        >>> # Shorteners are resolved automatically
        >>> result = scrape_content("https://t.co/abc123")
        >>> # Routes to appropriate scraper based on resolved URL
    """
    if not url or not isinstance(url, str):
        return {
            "success": False,
            "content_type": "unknown",
            "url": url or "",
            "error": "Invalid URL provided",
        }

    # Prevent infinite redirect loops
    max_redirect_depth = 3
    if _redirect_depth >= max_redirect_depth:
        return {
            "success": False,
            "content_type": "unknown",
            "url": url,
            "error": f"Too many redirects (max depth: {max_redirect_depth})",
        }

    original_url = url.strip()
    url = original_url

    # Resolve URL shorteners before routing
    if is_shortener(url):
        redirect_result = resolve_redirects(url)
        if not redirect_result["success"]:
            return {
                "success": False,
                "content_type": "unknown",
                "url": original_url,
                "error": f"Failed to resolve shortened URL: {redirect_result.get('error', 'unknown error')}",
            }
        if redirect_result["was_shortened"]:
            url = redirect_result["resolved_url"]

    content_type = detect_url_type(url)

    # Route to appropriate fetcher
    if content_type == "twitter":
        result = fetch_twitter(url)
    elif content_type == "github":
        result = fetch_github(url)
    elif content_type == "gist":
        result = fetch_gist(url)
    elif content_type == "youtube":
        result = fetch_youtube(url)
    elif content_type == "reddit":
        result = fetch_reddit(url)
    elif content_type == "webpage":
        result = fetch_generic(url)
    else:
        return {
            "success": False,
            "content_type": "unknown",
            "url": original_url,
            "resolved_url": url if url != original_url else None,
            "error": "Unsupported URL type. Supported: Twitter/X, GitHub, YouTube, Reddit, or any webpage",
        }

    # Handle redirect response from Twitter fetcher (t.co pointing to external URL)
    if result.get("redirect") and result.get("resolved_url"):
        # Re-route to appropriate scraper with resolved URL
        return scrape_content(result["resolved_url"], _redirect_depth=_redirect_depth + 1)

    # Add resolved_url to result if different from original
    if url != original_url:
        result["resolved_url"] = url

    return result


def main():
    """CLI interface for testing."""
    if len(sys.argv) < 2:
        print("Usage: python scraper.py <url>")
        print()
        print("Supported URLs:")
        print("  - Twitter/X: https://x.com/user/status/123")
        print("  - GitHub:    https://github.com/owner/repo")
        print("  - YouTube:   https://youtube.com/watch?v=...")
        print("  - Reddit:    https://reddit.com/r/sub/comments/...")
        print("  - Any webpage: https://blog.example.com/article")
        sys.exit(1)

    url = sys.argv[1]
    result = scrape_content(url)
    print(json.dumps(result, indent=2, ensure_ascii=False))


# Re-export for external use
__all__ = ["scrape_content", "detect_url_type", "ContentType"]

if __name__ == "__main__":
    main()
