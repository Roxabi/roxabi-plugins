#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
URL redirect resolution for shorteners.

Resolves shortened URLs (t.co, bit.ly, etc.) to their final destination
before routing to scrapers. This enables:
- Better duplicate detection (t.co/xyz and example.com/article detected as same)
- Correct scraper routing based on final URL
- Storing the resolved URL in the database

Security:
- Only resolves known shortener domains (avoids unnecessary network requests)
- SSRF protection on final resolved URL
- Timeout and redirect limits to prevent abuse
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from validators_ssrf import validate_url_ssrf

logger = logging.getLogger(__name__)

# Known URL shortener domains
# Only URLs from these domains trigger network requests for resolution
DEFAULT_SHORTENERS: frozenset[str] = frozenset(
    [
        "t.co",
        "bit.ly",
        "tinyurl.com",
        "goo.gl",
        "ow.ly",
        "is.gd",
        "buff.ly",
        "j.mp",
        "rb.gy",
        "cutt.ly",
        "youtu.be",  # YouTube short URLs
        "redd.it",  # Reddit short URLs
        "fb.me",  # Facebook
        "lnkd.in",  # LinkedIn
        "amzn.to",  # Amazon
        "amzn.eu",
        "shorturl.at",
        "trib.al",
        "dlvr.it",
        "spr.ly",
        "soo.gd",
        "s.id",
        "rebrand.ly",
        "tiny.cc",
        "v.gd",
        "shortlink.com",
    ]
)


def resolve_redirects(
    url: str,
    max_redirects: int = 10,
    timeout: float = 10.0,
    validate_final: bool = True,
    shorteners: Optional[frozenset[str]] = None,
) -> dict[str, Any]:
    """
    Resolve redirections for known URL shorteners.

    Only performs network requests for URLs from known shortener domains.
    Regular URLs are returned unchanged without any network activity.

    Args:
        url: URL to potentially resolve
        max_redirects: Maximum number of redirects to follow (default: 10)
        timeout: Request timeout in seconds (default: 10.0)
        validate_final: Whether to validate final URL for SSRF (default: True)
        shorteners: Custom set of shortener domains (default: DEFAULT_SHORTENERS)

    Returns:
        Dict with:
        - success: bool - True if resolution succeeded (or wasn't needed)
        - original_url: str - Input URL
        - resolved_url: str - Final URL after redirects (same as original if not a shortener)
        - was_shortened: bool - True if URL was from a shortener and got resolved
        - redirects_followed: int - Number of redirects followed (0 if not a shortener)
        - error: str - Error message (only if success=False)

    Example:
        >>> result = resolve_redirects("https://t.co/abc123")
        >>> if result["success"]:
        ...     print(result["resolved_url"])  # e.g., "https://example.com/article"

        >>> result = resolve_redirects("https://example.com/page")
        >>> result["was_shortened"]  # False - not a shortener, no network request
    """
    if not url or not isinstance(url, str):
        return {
            "success": False,
            "original_url": url or "",
            "resolved_url": url or "",
            "was_shortened": False,
            "redirects_followed": 0,
            "error": "Invalid URL provided",
        }

    url = url.strip()
    domains = shorteners or DEFAULT_SHORTENERS

    # Check if this is a shortener domain
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]

        if domain not in domains:
            # Not a shortener - return unchanged without network request
            return {
                "success": True,
                "original_url": url,
                "resolved_url": url,
                "was_shortened": False,
                "redirects_followed": 0,
            }
    except Exception as e:
        return {
            "success": False,
            "original_url": url,
            "resolved_url": url,
            "was_shortened": False,
            "redirects_followed": 0,
            "error": f"Failed to parse URL: {e}",
        }

    # Resolve shortener URL
    try:
        with httpx.Client(
            follow_redirects=True,
            max_redirects=max_redirects,
            timeout=timeout,
        ) as client:
            # Use HEAD request to avoid downloading content
            response = client.head(url)
            resolved_url = str(response.url)
            redirects_followed = len(response.history)

            # Validate final URL for SSRF if requested
            if validate_final:
                is_safe, ssrf_error = validate_url_ssrf(resolved_url, resolve_hostname=True)
                if not is_safe:
                    logger.warning(
                        "Resolved URL failed SSRF validation: %s -> %s (%s)",
                        url,
                        resolved_url,
                        ssrf_error,
                    )
                    return {
                        "success": False,
                        "original_url": url,
                        "resolved_url": resolved_url,
                        "was_shortened": True,
                        "redirects_followed": redirects_followed,
                        "error": f"Resolved URL failed security validation: {ssrf_error}",
                    }

            logger.debug(
                "Resolved shortener: %s -> %s (%d redirects)",
                url,
                resolved_url,
                redirects_followed,
            )

            return {
                "success": True,
                "original_url": url,
                "resolved_url": resolved_url,
                "was_shortened": True,
                "redirects_followed": redirects_followed,
            }

    except httpx.TooManyRedirects:
        return {
            "success": False,
            "original_url": url,
            "resolved_url": url,
            "was_shortened": True,
            "redirects_followed": max_redirects,
            "error": f"Too many redirects (max: {max_redirects})",
        }
    except httpx.TimeoutException:
        return {
            "success": False,
            "original_url": url,
            "resolved_url": url,
            "was_shortened": True,
            "redirects_followed": 0,
            "error": f"Request timeout ({timeout}s)",
        }
    except httpx.RequestError as e:
        return {
            "success": False,
            "original_url": url,
            "resolved_url": url,
            "was_shortened": True,
            "redirects_followed": 0,
            "error": f"Request failed: {e}",
        }
    except Exception as e:
        return {
            "success": False,
            "original_url": url,
            "resolved_url": url,
            "was_shortened": True,
            "redirects_followed": 0,
            "error": f"Unexpected error: {e}",
        }


def is_twitter_domain(url: str) -> bool:
    """
    Check if URL is from Twitter/X domain.

    Args:
        url: URL to check

    Returns:
        True if URL is from x.com or twitter.com
    """
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        return domain in ("x.com", "twitter.com", "www.x.com", "www.twitter.com")
    except Exception:
        return False


# Module-level convenience function for checking shorteners
def is_shortener(url: str, shorteners: Optional[frozenset[str]] = None) -> bool:
    """
    Check if URL is from a known shortener domain.

    Args:
        url: URL to check
        shorteners: Custom set of shortener domains (default: DEFAULT_SHORTENERS)

    Returns:
        True if URL is from a known shortener
    """
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]
        return domain in (shorteners or DEFAULT_SHORTENERS)
    except Exception:
        return False
