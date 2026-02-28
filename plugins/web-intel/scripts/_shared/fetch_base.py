#!/usr/bin/env python3
"""
Shared base utilities for content fetcher modules.

Provides common functions used across fetch_twitter, fetch_youtube,
fetch_reddit, and fetch_github to reduce code duplication:

- safe_fetch(): SSRF validation + size-limited streaming HTTP fetch
- extract_id_from_url(): Regex-based ID extraction from URLs
- build_result(): Consistent result dict builder

Security:
- SSRF protection via validate_url_ssrf_strict
- Content size limits via streaming download
"""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path
from typing import Any, Optional, Union

import requests

# Add _shared to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from validators import (
    validate_url_ssrf_strict,
    SSRFError,
    ContentSizeError,
    DEFAULT_MAX_CONTENT_SIZE,
)
from timeouts import get_fetcher_timeout
from retry import retry_call, TRANSIENT_STATUS_CODES  # type: ignore[import-untyped]

logger = logging.getLogger(__name__)


def safe_fetch(
    url: str,
    headers: Optional[dict[str, str]] = None,
    max_size: int = DEFAULT_MAX_CONTENT_SIZE,
    timeout: Union[int, tuple[int, int]] = 30,
    fetcher_name: Optional[str] = None,
    retry: bool = True,
    max_retries: int = 3,
) -> dict[str, Any]:
    """Perform an HTTP GET with SSRF validation and size-limited streaming.

    This function encapsulates the common fetch pattern shared by all
    content fetchers: SSRF check, streaming download, Content-Length
    pre-check, and chunk-level size enforcement.

    Integrates retry with exponential backoff for transient errors
    (429, 5xx, ConnectionError, Timeout) and configurable per-fetcher
    timeouts.

    Args:
        url: URL to fetch (will be validated against SSRF).
        headers: Optional HTTP headers for the request.
        max_size: Maximum response size in bytes (default: 5 MB).
        timeout: Request timeout in seconds (default: 30). Ignored if
            ``fetcher_name`` is provided (uses configured timeouts).
        fetcher_name: Optional fetcher name (e.g. "twitter", "youtube").
            If provided, uses ``get_fetcher_timeout(fetcher_name)`` to
            obtain a ``(connect, read)`` timeout tuple.
        retry: Whether to retry on transient errors (default: True).
        max_retries: Maximum number of retries (default: 3).

    Returns:
        Dict with either:
        - ``{"success": True, "status_code": int, "content": bytes}``
        - ``{"success": False, "status_code": int | None, "error": str}``

    Security:
        - Validates URL against SSRF attacks before making any request.
        - Limits response size to prevent memory exhaustion.
    """
    # SSRF validation (permanent error — never retry)
    try:
        validate_url_ssrf_strict(url)
    except SSRFError as e:
        return {"success": False, "status_code": None, "error": f"SSRF protection: {e}"}

    # Resolve timeout
    effective_timeout: Union[int, tuple[int, int]] = timeout
    if fetcher_name:
        effective_timeout = get_fetcher_timeout(fetcher_name)

    def _do_fetch() -> dict[str, Any]:
        """Inner fetch wrapped by retry_call."""
        response = requests.get(
            url,
            headers=headers or {},
            timeout=effective_timeout,
            stream=True,
        )

        # Raise on transient HTTP status codes so retry_call can catch them
        if response.status_code in TRANSIENT_STATUS_CODES:
            response.raise_for_status()

        # Check Content-Length before downloading
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > max_size:
            return {
                "success": False,
                "status_code": response.status_code,
                "error": f"Response too large: {content_length} bytes (max: {max_size})",
            }

        # Stream content with size check
        chunks: list[bytes] = []
        total_size = 0
        for chunk in response.iter_content(chunk_size=8192):
            total_size += len(chunk)
            if total_size > max_size:
                return {
                    "success": False,
                    "status_code": response.status_code,
                    "error": f"Response exceeded size limit ({max_size} bytes)",
                }
            chunks.append(chunk)

        content = b"".join(chunks)
        return {
            "success": True,
            "status_code": response.status_code,
            "content": content,
        }

    try:
        if retry:
            return retry_call(_do_fetch, max_retries=max_retries)
        else:
            return _do_fetch()

    except ContentSizeError as e:
        return {"success": False, "status_code": None, "error": str(e)}
    except requests.exceptions.Timeout:
        return {"success": False, "status_code": None, "error": "Request timeout"}
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        return {"success": False, "status_code": status, "error": f"HTTP {status}"}
    except Exception as e:
        return {"success": False, "status_code": None, "error": str(e)}


def extract_id_from_url(url: str, patterns: list[str]) -> Optional[str]:
    """Extract an identifier from a URL using a list of regex patterns.

    Each pattern should contain exactly one capture group that matches
    the desired identifier.

    Args:
        url: URL string to search.
        patterns: List of regex patterns, tried in order. The first
            match wins.

    Returns:
        The captured group from the first matching pattern, or None.
    """
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def build_result(
    title: str,
    description: str,
    url: str,
    type_name: str,
    **extra: Any,
) -> dict[str, Any]:
    """Build a standardized success result dict.

    All fetcher modules return dicts with a common shape. This helper
    ensures consistency and reduces boilerplate.

    Args:
        title: Content title / headline.
        description: Short description or summary text.
        url: Original source URL.
        type_name: Content type identifier (e.g. "tweet", "youtube",
            "reddit_post", "github").
        **extra: Additional key-value pairs merged into the result.

    Returns:
        Dict with ``success=True`` and the provided fields.
    """
    result: dict[str, Any] = {
        "success": True,
        "type": type_name,
        "url": url,
        "title": title,
        "description": description,
    }
    result.update(extra)
    return result
