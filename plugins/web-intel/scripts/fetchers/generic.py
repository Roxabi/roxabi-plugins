#!/usr/bin/env python3
"""
Generic webpage content extraction module.

Uses Trafilatura for robust article extraction from any website.
Fallback scraper when URL doesn't match a specialized fetcher.

Security:
- SSRF protection via validate_url_ssrf
- Content size limits via safe_fetch
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

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
)

# Optional - graceful handling if not installed
try:
    import trafilatura
    from trafilatura import extract
    from trafilatura.settings import use_config

    TRAFILATURA_AVAILABLE = True
except ImportError:
    TRAFILATURA_AVAILABLE = False


def fetch_webpage_content(
    url: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch and extract content from a webpage.

    Args:
        url: Webpage URL to fetch
        max_content_size: Maximum response size in bytes (default: 5MB)

    Returns:
        Dict with extracted content or error

    Security:
        - Validates URL against SSRF attacks
        - Limits response size to prevent memory exhaustion
    """
    if not TRAFILATURA_AVAILABLE:
        return {
            "success": False,
            "error": "trafilatura not installed. Run: uv add trafilatura",
            "_do_not_cache": True,
        }

    # Fetch HTML content with SSRF protection
    result = safe_fetch(url, max_size=max_content_size, fetcher_name="generic")

    if not result["success"]:
        return {"success": False, "error": result["error"]}

    if result["status_code"] != 200:
        return {"success": False, "error": f"HTTP {result['status_code']}"}

    try:
        html_content = result["content"].decode("utf-8", errors="replace")
    except Exception as e:
        return {"success": False, "error": f"Failed to decode content: {e}"}

    # Configure trafilatura for better extraction
    config = use_config()
    config.set("DEFAULT", "EXTRACTION_TIMEOUT", "30")

    # Extract content with metadata
    extracted = extract(
        html_content,
        url=url,
        include_comments=False,
        include_tables=True,
        include_images=False,
        include_links=False,
        output_format="txt",
        config=config,
    )

    if not extracted or len(extracted.strip()) < 50:
        return {
            "success": False,
            "error": "Could not extract meaningful content from page",
        }

    # Extract metadata separately
    metadata = trafilatura.extract_metadata(html_content, default_url=url)

    title = ""
    author = ""
    date = ""
    description = ""
    sitename = ""

    if metadata:
        title = metadata.title or ""
        author = metadata.author or ""
        date = metadata.date or ""
        description = metadata.description or ""
        sitename = metadata.sitename or ""

    return {
        "success": True,
        "type": "webpage",
        "url": url,
        "title": title,
        "author": author,
        "date": date,
        "description": description,
        "sitename": sitename,
        "text": sanitize_content(extracted),
        "text_length": len(extracted),
    }


class GenericWebFetcher(BaseFetcher):
    """Generic webpage content fetcher.

    Uses Trafilatura to extract article content from any webpage.
    Fallback scraper for URLs not matching specialized fetchers.

    Example:
        >>> fetcher = GenericWebFetcher()
        >>> result = fetcher.fetch("https://blog.example.com/article")
        >>> if result["success"]:
        ...     print(result["data"]["text"])
    """

    content_type = "webpage"

    def _fetch_impl(
        self,
        url: str,
        max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
    ) -> dict[str, Any]:
        """
        Core implementation: fetch and extract content from any webpage.

        Returns extracted article content with metadata.

        Args:
            url: Webpage URL to fetch
            max_content_size: Maximum content size in bytes (default: 5MB)

        Returns:
            Dict with extracted content and metadata

        Security:
            - Validates URL against SSRF attacks
            - Limits response size to prevent memory exhaustion
        """
        return fetch_webpage_content(url, max_content_size=max_content_size)

    def _transform_data(self, raw_result: dict[str, Any]) -> dict[str, Any]:
        """Transform raw webpage result to standardized data dict."""
        return {
            "text": raw_result.get("text", ""),
            "title": raw_result.get("title", ""),
            "author": raw_result.get("author", ""),
            "date": raw_result.get("date", ""),
            "description": raw_result.get("description", ""),
            "sitename": raw_result.get("sitename", ""),
            "text_length": raw_result.get("text_length", 0),
        }


# Backward-compatible module-level function
def fetch_generic(url: str) -> dict[str, Any]:
    """
    Fetch content from any webpage URL.

    Args:
        url: Webpage URL to scrape

    Returns:
        Dict with:
        - success: bool
        - content_type: "webpage"
        - url: original URL
        - data: dict with text, title, author, date, description, sitename
        - error: str (only if success=False)

    Example:
        >>> result = fetch_generic("https://blog.example.com/article")
        >>> if result["success"]:
        ...     print(result["data"]["title"])
    """
    return GenericWebFetcher().fetch(url)


def main():
    """CLI interface for testing."""
    GenericWebFetcher.run_cli()


if __name__ == "__main__":
    main()
