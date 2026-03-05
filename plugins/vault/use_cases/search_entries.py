"""Use case: search vault entries via full-text search."""
from __future__ import annotations

import sys
from pathlib import Path

_plugin_root = str(Path(__file__).resolve().parents[1])
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

from domain.exceptions import VaultError
from domain.models import SearchResult
from ports.search import SearchPort


class SearchEntriesUseCase:
    """Search vault entries via the search port."""

    def __init__(self, search: SearchPort):
        self._search = search

    def execute(self, query: str, limit: int = 20) -> list[SearchResult]:
        if not query.strip():
            raise VaultError("query must not be empty")
        return self._search.search(query, limit=limit)
