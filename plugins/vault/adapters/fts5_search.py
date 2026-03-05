"""FTS5 adapter for SearchPort."""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from domain.exceptions import StorageError
from domain.models import SearchResult, VaultEntry
from ports.search import SearchPort


class Fts5SearchAdapter(SearchPort):
    """Concrete SearchPort backed by SQLite FTS5."""

    def __init__(self, db_path: Path, conn: sqlite3.Connection | None = None):
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = conn
        self._owns_conn = conn is None

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(str(self._db_path))
            self._conn.row_factory = sqlite3.Row
            self._conn.execute('PRAGMA journal_mode=WAL')
            self._owns_conn = True
        return self._conn

    def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        try:
            conn = self._get_conn()
            sanitized = re.sub(r'[*^]', '', query).replace('"', '""')
            safe_query = '"' + sanitized + '"'
            sql = """
                SELECT e.*, rank
                FROM entries_fts fts
                JOIN entries e ON e.id = fts.rowid
                WHERE entries_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            """
            rows = conn.execute(sql, (safe_query, limit)).fetchall()
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
        if self._conn and self._owns_conn:
            self._conn.close()
            self._conn = None
