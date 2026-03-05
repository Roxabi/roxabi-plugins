"""Use case: search vault entries via full-text search."""
from __future__ import annotations

import sys
from pathlib import Path

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for _p in [_plugin_root, _repo_root]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

from domain.models import SearchResult
from ports.search import SearchPort


class SearchEntriesUseCase:
    """Search vault entries via the search port."""

    def __init__(self, search: SearchPort):
        self._search = search

    def execute(self, query: str, limit: int = 20) -> list[SearchResult]:
        return self._search.search(query, limit=limit)
