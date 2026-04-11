#!/usr/bin/env python3
"""
Generic webpage content extraction module.

Uses Trafilatura for robust article extraction from any website.
Fallback scraper when URL doesn't match a specialized fetcher.

Fetch strategy:
  1. Fast path — plain HTTP via ``safe_fetch`` + Trafilatura extraction
  2. Stealth fallback — if the fast path returns an anti-bot signature
     (HTTP 403/429/503, Cloudflare challenge markers, or < 50 chars
     extracted), retry via headless Chromium + playwright-stealth and
     re-run Trafilatura on the rendered HTML.

The stealth fallback reuses the Playwright stack already required for
Twitter/X articles — no new dependencies.

Security:
- SSRF protection via validate_url_ssrf (safe_fetch + stealth pre-flight)
- Content size limits via safe_fetch
"""

from __future__ import annotations

import logging
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
)
from stealth import fetch_html_stealth, has_antibot_signature

logger = logging.getLogger(__name__)

# Optional - graceful handling if not installed
try:
    import trafilatura
    from trafilatura import extract
    from trafilatura.settings import use_config

    TRAFILATURA_AVAILABLE = True
except ImportError:
    TRAFILATURA_AVAILABLE = False


def _extract_with_trafilatura(html: str, url: str) -> Optional[str]:
    """Run Trafilatura article extraction on an HTML string."""
    config = use_config()
    config.set("DEFAULT", "EXTRACTION_TIMEOUT", "30")
    return extract(
        html,
        url=url,
        include_comments=False,
        include_tables=True,
        include_images=False,
        include_links=False,
        output_format="txt",
        config=config,
    )


def fetch_webpage_content(
    url: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch and extract content from a webpage.

    Fast path (plain HTTP) first; if it trips an anti-bot signature, retry
    via stealth browser and re-run Trafilatura on the rendered HTML.

    Args:
        url: Webpage URL to fetch
        max_content_size: Maximum response size in bytes (default: 5MB)

    Returns:
        Dict with extracted content or error

    Security:
        - Validates URL against SSRF attacks (fast path + stealth pre-flight)
        - Limits fast-path response size to prevent memory exhaustion
    """
    if not TRAFILATURA_AVAILABLE:
        return {
            "success": False,
            "error": "trafilatura not installed. Run: uv add trafilatura",
            "_do_not_cache": True,
        }

    # ---- Fast path: plain HTTP fetch ----
    result = safe_fetch(url, max_size=max_content_size, fetcher_name="generic")

    html_content: Optional[str] = None
    fast_path_status: Optional[int] = None
    fast_path_error: Optional[str] = None

    if result["success"]:
        fast_path_status = result.get("status_code")
        if fast_path_status == 200:
            try:
                html_content = result["content"].decode("utf-8", errors="replace")
            except Exception as e:
                fast_path_error = f"Failed to decode content: {e}"
        else:
            fast_path_error = f"HTTP {fast_path_status}"
    else:
        fast_path_error = result.get("error", "fetch failed")

    # Try extraction on whatever fast-path HTML we got
    extracted: Optional[str] = (
        _extract_with_trafilatura(html_content, url) if html_content else None
    )
    text_len = len(extracted.strip()) if extracted else 0

    # ---- Stealth fallback trigger ----
    if has_antibot_signature(
        status_code=fast_path_status,
        html=html_content,
        text_length=text_len if html_content is not None else None,
    ):
        logger.info(
            "Anti-bot signature for %s (status=%s, text_len=%d) — retrying via stealth browser",
            url,
            fast_path_status,
            text_len,
        )
        stealth_html = fetch_html_stealth(url)
        if stealth_html:
            html_content = stealth_html
            extracted = _extract_with_trafilatura(html_content, url)

    # ---- Metadata (used for both normal path and SPA fallback) ----
    metadata = trafilatura.extract_metadata(html_content, default_url=url) if html_content else None

    # ---- Final validity check + metadata fallback ----
    # Many SPAs (React/Vue product pages, marketing sites) have empty
    # HTML bodies but rich Open Graph / Twitter Card tags. When trafilatura
    # finds no body, synthesize text from metadata instead of failing.
    meta_fallback = False
    if not extracted or len(extracted.strip()) < 50:
        if metadata and (metadata.title or metadata.description):
            synth_parts = [
                p for p in [metadata.title, metadata.description] if p
            ]
            synth_text = "\n\n".join(synth_parts)
            if len(synth_text) >= 30:
                logger.info("Generic fetcher: metadata-only fallback for %s", url)
                extracted = synth_text
                meta_fallback = True
        if not extracted or len(extracted.strip()) < 30:
            return {
                "success": False,
                "error": fast_path_error or "Could not extract meaningful content from page",
            }

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

    result_dict: dict[str, Any] = {
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
    if meta_fallback:
        result_dict["_meta_fallback"] = True
    return result_dict


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
