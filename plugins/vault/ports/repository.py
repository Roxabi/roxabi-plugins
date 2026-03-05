"""Vault repository port — abstract interface for entry storage."""
from __future__ import annotations

from abc import ABC, abstractmethod

from domain.models import VaultEntry, VaultStats


class EntryRepository(ABC):
    """Abstract interface for vault entry CRUD operations."""

    @abstractmethod
    def add(self, category: str, type: str, title: str, content: str,
            metadata: str = "") -> VaultEntry: ...

    @abstractmethod
    def get(self, entry_id: int) -> VaultEntry | None: ...

    @abstractmethod
    def delete(self, entry_id: int) -> bool: ...

    @abstractmethod
    def list(self, category: str | None = None, type: str | None = None,
             limit: int = 50) -> list[VaultEntry]: ...

    @abstractmethod
    def stats(self) -> VaultStats: ...

    @abstractmethod
    def export(self, category: str | None = None,
               type: str | None = None) -> list[VaultEntry]: ...

    @abstractmethod
    def close(self) -> None: ...
