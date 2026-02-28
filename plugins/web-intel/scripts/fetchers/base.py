#!/usr/bin/env python3
"""
Base class for content fetchers.

Provides a standardized interface and common functionality for all
content fetchers (Twitter, Reddit, GitHub, YouTube).

The BaseFetcher abstract class handles:
- Standardized return format (success, content_type, url, data, error)
- Common URL validation
- CLI interface generation
- Error handling and transformation

Each subclass must implement:
- content_type: str - Platform identifier ("twitter", "reddit", etc.)
- _fetch_impl(url) - Core fetch implementation
- _transform_data(raw) - Transform raw result to standard data format

Security:
- SSRF protection delegated to safe_fetch() in fetch_base module
- Content size limits via fetch_base.safe_fetch()
"""

from __future__ import annotations

import json
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Optional

# Add _shared to path for imports (needed when running as script or from tests)
SHARED_DIR = Path(__file__).resolve().parents[1] / "_shared"
if str(SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_DIR))

# Add fetchers directory to path (for sibling imports when running as script)
FETCHERS_DIR = Path(__file__).resolve().parent
if str(FETCHERS_DIR) not in sys.path:
    sys.path.insert(0, str(FETCHERS_DIR))

# Re-export commonly used utilities for subclasses
from validators import DEFAULT_MAX_CONTENT_SIZE, sanitize_content  # noqa: E402, F401
from fetch_base import safe_fetch, extract_id_from_url, build_result  # noqa: E402, F401
from content_cache import cached_fetch  # noqa: E402, F401


class BaseFetcher(ABC):
    """Abstract base class for content fetchers.

    Subclasses must define:
    - content_type: Class attribute identifying the platform
    - _fetch_impl(): Core implementation returning raw result dict
    - _transform_data(): Transform raw result to standardized data dict

    Example usage::

        class TwitterFetcher(BaseFetcher):
            content_type = "twitter"

            def _fetch_impl(self, url: str) -> dict:
                # Platform-specific implementation
                return {"success": True, "text": "...", ...}

            def _transform_data(self, raw_result: dict) -> dict:
                return {
                    "text": raw_result.get("text", ""),
                    "author": raw_result.get("author", ""),
                    ...
                }

        # Use via class method
        result = TwitterFetcher.fetch("https://x.com/user/status/123")

        # Or instantiate
        fetcher = TwitterFetcher()
        result = fetcher("https://x.com/user/status/123")
    """

    content_type: str = ""  # Must be overridden by subclasses

    def __init__(self) -> None:
        """Initialize fetcher instance."""
        if not self.content_type:
            raise NotImplementedError(
                f"{self.__class__.__name__} must define content_type class attribute"
            )

    @abstractmethod
    def _fetch_impl(self, url: str) -> dict[str, Any]:
        """Core fetch implementation.

        Must be implemented by subclasses. Should return a dict with:
        - success: bool
        - error: str (if success=False)
        - type: str (content type)
        - url: str
        - ... platform-specific fields

        Args:
            url: URL to fetch

        Returns:
            Raw result dict from platform-specific implementation
        """
        pass

    @abstractmethod
    def _transform_data(self, raw_result: dict[str, Any]) -> dict[str, Any]:
        """Transform raw result to standardized data dict.

        Must be implemented by subclasses. Extracts and formats
        relevant fields from the raw implementation result.

        Args:
            raw_result: Raw dict from _fetch_impl()

        Returns:
            Standardized data dict for the "data" field of fetch() result
        """
        pass

    def _validate_url(self, url: str) -> tuple[bool, Optional[str]]:
        """Basic URL validation.

        Can be overridden by subclasses for platform-specific validation.

        Args:
            url: URL to validate

        Returns:
            Tuple of (is_valid, error_message)
        """
        if not url or not isinstance(url, str):
            return False, "Invalid URL provided"
        return True, None

    def __call__(self, url: str) -> dict[str, Any]:
        """Allow calling fetcher instance directly.

        Args:
            url: URL to fetch

        Returns:
            Standardized result dict
        """
        return self.fetch(url)

    def fetch(self, url: str) -> dict[str, Any]:
        """Fetch content from URL and return standardized result.

        This is the main public API. It:
        1. Validates the URL
        2. Checks cache for existing result
        3. Calls the implementation (_fetch_impl)
        4. Caches successful results
        5. Transforms and wraps the result in standard format

        Args:
            url: URL to fetch content from

        Returns:
            Dict with standardized structure:
            - success: bool
            - content_type: str (platform identifier)
            - url: str (original URL)
            - data: dict (transformed content, only if success)
            - raw: dict (raw implementation result, only if success)
            - error: str (only if success=False)

        Example:
            >>> fetcher = TwitterFetcher()
            >>> result = fetcher.fetch("https://x.com/user/status/123")
            >>> if result["success"]:
            ...     print(result["data"]["text"])
        """
        # Basic URL validation
        is_valid, error = self._validate_url(url)
        if not is_valid:
            return {
                "success": False,
                "content_type": self.content_type,
                "url": url,
                "error": error or "Invalid URL",
            }

        # Check cache first
        from content_cache import get_cache

        cache = get_cache()
        cached = cache.get(url)
        if cached is not None:
            # Return cached result with transformed data
            cached["_from_cache"] = True
            return {
                "success": True,
                "content_type": self.content_type,
                "url": url,
                "data": self._transform_data(cached),
                "raw": cached,
            }

        # Call implementation
        raw_result = self._fetch_impl(url)

        # Handle errors
        if not raw_result.get("success"):
            return {
                "success": False,
                "content_type": self.content_type,
                "url": url,
                "error": raw_result.get("error", "Unknown error"),
            }

        # Cache successful result (unless explicitly marked as non-cacheable)
        if not raw_result.get("_do_not_cache"):
            cache.set(url, raw_result, ttl_type="content", fetcher=self.content_type)

        # Transform and return
        return {
            "success": True,
            "content_type": self.content_type,
            "url": url,
            "data": self._transform_data(raw_result),
            "raw": raw_result,
        }

    @classmethod
    def create_fetch_function(cls) -> "FetchFunction":
        """Create a module-level fetch function for backward compatibility.

        Returns a callable that instantiates the fetcher and calls fetch().
        Useful for maintaining backward-compatible APIs.

        Example::

            # In twitter.py
            class TwitterFetcher(BaseFetcher):
                ...

            fetch_twitter = TwitterFetcher.create_fetch_function()

        Returns:
            Callable that fetches content from URL
        """
        instance = cls()
        return FetchFunction(instance)

    @classmethod
    def run_cli(cls, args: Optional[list[str]] = None) -> None:
        """Run CLI interface for this fetcher.

        Provides a standard CLI interface for testing:
        - Accepts URL as first argument
        - Prints JSON result to stdout

        Args:
            args: Command-line arguments (defaults to sys.argv[1:])

        Example:
            if __name__ == "__main__":
                TwitterFetcher.run_cli()
        """
        args = args if args is not None else sys.argv[1:]

        if not args:
            print(f"Usage: python {cls.content_type}.py <url>")
            print(f"Example: python {cls.content_type}.py https://example.com/...")
            sys.exit(1)

        url = args[0]
        fetcher = cls()
        result = fetcher.fetch(url)
        print(json.dumps(result, indent=2, ensure_ascii=False))


class FetchFunction:
    """Callable wrapper for backward-compatible module-level functions.

    Wraps a BaseFetcher instance to provide a simple callable interface
    that maintains backward compatibility with existing code using
    `fetch_twitter(url)` style calls.
    """

    def __init__(self, fetcher: BaseFetcher) -> None:
        """Initialize with fetcher instance.

        Args:
            fetcher: BaseFetcher instance to wrap
        """
        self._fetcher = fetcher
        # Copy docstring from fetcher's fetch method
        self.__doc__ = fetcher.fetch.__doc__

    def __call__(self, url: str) -> dict[str, Any]:
        """Fetch content from URL.

        Args:
            url: URL to fetch

        Returns:
            Standardized result dict
        """
        return self._fetcher.fetch(url)

    def __repr__(self) -> str:
        """Return string representation."""
        return f"<FetchFunction({self._fetcher.__class__.__name__})>"
