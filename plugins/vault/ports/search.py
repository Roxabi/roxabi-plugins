"""Vault search port — abstract interface for full-text search."""
from __future__ import annotations

from abc import ABC, abstractmethod

from domain.models import SearchResult


class SearchPort(ABC):
    """Abstract interface for FTS5-backed search operations."""

    @abstractmethod
    def search(self, query: str, limit: int = 20) -> list[SearchResult]: ...

    @abstractmethod
    def close(self) -> None: ...
