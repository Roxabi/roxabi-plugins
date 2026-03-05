"""Use case: add an entry to the vault."""
from __future__ import annotations

import sys
from pathlib import Path

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for _p in [_plugin_root, _repo_root]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

from domain.models import VaultEntry
from ports.repository import EntryRepository


class AddEntryUseCase:
    """Add a new entry to the vault via the repository port."""

    def __init__(self, repo: EntryRepository):
        self._repo = repo

    def execute(self, category: str, type: str, title: str,
                content: str, metadata: str = '') -> VaultEntry:
        return self._repo.add(category, type, title, content, metadata)
