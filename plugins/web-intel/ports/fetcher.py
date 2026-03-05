"""Web-intel fetcher port — thin abstract interface for content fetching."""
from __future__ import annotations

from abc import ABC, abstractmethod

from domain.models import FetchResult


class FetcherPort(ABC):
    """Abstract interface for content fetchers.

    This is a new thin interface, not a rename of BaseFetcher.
    BaseFetcher remains as the internal implementation base class.
    """

    @abstractmethod
    def supports(self, url: str) -> bool: ...

    @abstractmethod
    def fetch(self, url: str) -> FetchResult: ...
