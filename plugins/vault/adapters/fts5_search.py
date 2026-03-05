"""FTS5 adapter for SearchPort."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from domain.models import SearchResult, VaultEntry
from ports.search import SearchPort


class Fts5SearchAdapter(SearchPort):
    """Concrete SearchPort backed by SQLite FTS5."""

    def __init__(self, db_path: Path):
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = None

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(str(self._db_path))
            self._conn.row_factory = sqlite3.Row
        return self._conn

    def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        conn = self._get_conn()
        safe_query = '"' + query.replace('"', '""') + '"'
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

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
