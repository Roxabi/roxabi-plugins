"""FTS5 adapter for SearchPort — thin wrapper over roxabi_memory.fts."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from roxabi_memory.db import MemoryDB
from roxabi_memory.fts import search_fts

from domain.exceptions import StorageError
from domain.models import SearchResult, VaultEntry
from ports.search import SearchPort


class Fts5SearchAdapter(SearchPort):
    """Concrete SearchPort backed by roxabi_memory FTS5 search."""

    def __init__(self, db_path: Path, conn: sqlite3.Connection | None = None):
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = conn
        self._owns_conn = conn is None
        self._db: MemoryDB | None = None

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._db = MemoryDB(self._db_path)
            self._db.connect()
            self._conn = self._db.connection
            self._owns_conn = True
        return self._conn

    def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        try:
            conn = self._get_conn()
            rows = search_fts(conn, query, namespace='vault', limit=limit)
            return [
                SearchResult(
                    entry=VaultEntry(
                        id=row['id'],
                        category=row['category'],
                        type=row['type'],
                        title=row['title'],
                        content=row['content'],
                        created_at=row['created_at'],
                        updated_at=row['updated_at'],
                        metadata=row['metadata'],
                    ),
                    rank=row['rank'],
                )
                for row in rows
            ]
        except sqlite3.Error as e:
            raise StorageError(str(e)) from e

    def close(self) -> None:
        if self._db and self._owns_conn:
            self._db.close()
            self._conn = None
            self._db = None
        elif self._conn and self._owns_conn:
            self._conn.close()
            self._conn = None
