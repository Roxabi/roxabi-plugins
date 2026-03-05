"""Use case: add an entry to the vault."""
from __future__ import annotations

import sys
from pathlib import Path

_plugin_root = str(Path(__file__).resolve().parents[1])
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

from domain.exceptions import VaultError
from domain.models import VaultEntry
from ports.repository import EntryRepository


class AddEntryUseCase:
    """Add a new entry to the vault via the repository port."""

    def __init__(self, repo: EntryRepository):
        self._repo = repo

    def execute(self, category: str, type: str, title: str,
                content: str, metadata: str = '') -> VaultEntry:
        if not category.strip():
            raise VaultError("category must not be empty")
        if not type.strip():
            raise VaultError("type must not be empty")
        if not title.strip():
            raise VaultError("title must not be empty")
        return self._repo.add(category, type, title, content, metadata)
