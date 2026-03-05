"""Vault domain models — typed, frozen dataclasses for vault entries and search results."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class VaultEntry:
    """A single vault entry with category, type, and content."""
    id: int
    category: str
    type: str
    title: str
    content: str
    created_at: str
    updated_at: str
    metadata: str = "{}"


@dataclass(frozen=True)
class SearchResult:
    """A search result pairing a vault entry with its relevance rank."""
    entry: VaultEntry
    rank: float
