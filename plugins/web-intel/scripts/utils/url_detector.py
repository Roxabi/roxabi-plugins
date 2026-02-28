#!/usr/bin/env python3
"""
URL type detection for routing to appropriate fetcher.
"""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlparse

ContentType = Literal["twitter", "github", "gist", "youtube", "reddit", "webpage", "unknown"]


def detect_url_type(url: str) -> ContentType:
    """
    Detect the content type from a URL.

    Args:
        url: URL to analyze

    Returns:
        Content type: "twitter", "github", "youtube", "reddit", "webpage", or "unknown"

    Example:
        >>> detect_url_type("https://x.com/user/status/123")
        'twitter'
        >>> detect_url_type("https://github.com/owner/repo")
        'github'
        >>> detect_url_type("https://blog.example.com/article")
        'webpage'
    """
    if not url or not isinstance(url, str):
        return "unknown"

    url_lower = url.lower()

    if "x.com" in url_lower or "twitter.com" in url_lower:
        return "twitter"
    elif "gist.github.com" in url_lower:
        return "gist"
    elif "github.com" in url_lower:
        return "github"
    elif "youtube.com" in url_lower or "youtu.be" in url_lower:
        return "youtube"
    elif "reddit.com" in url_lower or "redd.it" in url_lower:
        return "reddit"

    # Check if it's a valid HTTP(S) URL for generic webpage scraping
    if _is_valid_webpage_url(url):
        return "webpage"

    return "unknown"


def _is_valid_webpage_url(url: str) -> bool:
    """Check if URL is a valid HTTP(S) webpage URL.

    Args:
        url: URL to check

    Returns:
        True if URL is valid for webpage scraping
    """
    try:
        parsed = urlparse(url)
        # Must have http or https scheme and a valid netloc
        if parsed.scheme not in ("http", "https"):
            return False
        if not parsed.netloc:
            return False
        # Must have a dot in the domain (basic validation)
        if "." not in parsed.netloc:
            return False
        return True
    except Exception:
        return False
