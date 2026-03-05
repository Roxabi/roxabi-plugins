"""Tests for web-intel FetcherRegistry."""
import sys
from pathlib import Path

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for p in [_plugin_root, _repo_root]:
    if p not in sys.path:
        sys.path.insert(0, p)

from adapters.fetcher_registry import FetcherRegistry
from domain.exceptions import UnsupportedURLError
from domain.models import FetchResult
from ports.fetcher import FetcherPort


class FakeFetcher(FetcherPort):
    """Test fetcher that supports a specific domain."""

    def __init__(self, domain: str, content_type: str = 'test'):
        self._domain = domain
        self._content_type = content_type

    def supports(self, url: str) -> bool:
        return self._domain in url

    def fetch(self, url: str) -> FetchResult:
        return FetchResult(
            success=True,
            content_type=self._content_type,
            url=url,
            data={'title': f'Test from {self._domain}'},
        )


class TestFetcherRegistry:

    def test_selects_matching_fetcher(self):
        github = FakeFetcher('github.com', 'github')
        generic = FakeFetcher('', 'generic')  # matches everything
        registry = FetcherRegistry([github, generic])

        fetcher = registry.get_fetcher('https://github.com/foo/bar')
        assert fetcher is github

    def test_falls_back_to_generic(self):
        github = FakeFetcher('github.com', 'github')
        generic = FakeFetcher('', 'generic')
        registry = FetcherRegistry([github, generic])

        fetcher = registry.get_fetcher('https://example.com')
        assert fetcher is generic

    def test_returns_none_when_no_match(self):
        github = FakeFetcher('github.com', 'github')
        registry = FetcherRegistry([github])

        assert registry.get_fetcher('https://example.com') is None

    def test_fetch_returns_result(self):
        generic = FakeFetcher('', 'generic')
        registry = FetcherRegistry([generic])

        result = registry.fetch('https://example.com')
        assert isinstance(result, FetchResult)
        assert result.success is True
        assert result.content_type == 'generic'

    def test_fetch_raises_unsupported_url_when_no_fetcher(self):
        registry = FetcherRegistry([])
        with pytest.raises(UnsupportedURLError):
            registry.fetch('https://example.com')
