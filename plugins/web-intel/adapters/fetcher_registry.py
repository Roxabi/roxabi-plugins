"""FetcherRegistry — selects the right fetcher for a URL from registered FetcherPort instances."""
from __future__ import annotations

import sys
from pathlib import Path

_plugin_root = str(Path(__file__).resolve().parents[1])
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

from domain.models import FetchResult
from ports.fetcher import FetcherPort


class FetcherRegistry:
    """Registry of FetcherPort implementations. Selects by URL pattern."""

    def __init__(self, fetchers: list[FetcherPort]):
        self._fetchers = fetchers

    def get_fetcher(self, url: str) -> FetcherPort | None:
        """Return the first fetcher that supports the given URL, or None."""
        for f in self._fetchers:
            if f.supports(url):
                return f
        return None

    def fetch(self, url: str) -> FetchResult:
        """Fetch content from URL using the appropriate fetcher."""
        fetcher = self.get_fetcher(url)
        if fetcher is None:
            return FetchResult(
                success=False,
                content_type='unknown',
                url=url,
                error='No fetcher supports this URL',
            )
        return fetcher.fetch(url)
