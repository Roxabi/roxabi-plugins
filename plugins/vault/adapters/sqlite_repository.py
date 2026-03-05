"""SQLite adapter for EntryRepository port."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from domain.models import VaultEntry
from ports.repository import EntryRepository

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, category, type,
    content=entries, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content, category, type)
    VALUES (new.id, new.title, new.content, new.category, new.type);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, category, type)
    VALUES ('delete', old.id, old.title, old.content, old.category, old.type);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, category, type)
    VALUES ('delete', old.id, old.title, old.content, old.category, old.type);
    INSERT INTO entries_fts(rowid, title, content, category, type)
    VALUES (new.id, new.title, new.content, new.category, new.type);
END;
"""


class SqliteEntryRepository(EntryRepository):
    """Concrete EntryRepository backed by SQLite + FTS5."""

    def __init__(self, db_path: Path):
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = None

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(str(self._db_path))
            self._conn.row_factory = sqlite3.Row
            self._conn.execute('PRAGMA journal_mode=WAL')
            self._conn.execute('PRAGMA foreign_keys=ON')
            self._conn.executescript(SCHEMA_SQL)
            self._conn.execute('PRAGMA user_version = 1')
        return self._conn

    def _row_to_entry(self, row: sqlite3.Row) -> VaultEntry:
        return VaultEntry(
            id=row['id'],
            category=row['category'],
            type=row['type'],
            title=row['title'],
            content=row['content'],
            created_at=row['created_at'],
            updated_at=row['updated_at'],
            metadata=row['metadata'],
        )

    def add(self, category: str, type: str, title: str, content: str,
            metadata: str = "") -> VaultEntry:
        conn = self._get_conn()
        cursor = conn.execute(
            'INSERT INTO entries (category, type, title, content, metadata) '
            'VALUES (?, ?, ?, ?, ?)',
            (category, type, title, content, metadata or '{}')
        )
        conn.commit()
        row = conn.execute('SELECT * FROM entries WHERE id = ?',
                           (cursor.lastrowid,)).fetchone()
        return self._row_to_entry(row)

    def get(self, entry_id: int) -> VaultEntry | None:
        conn = self._get_conn()
        row = conn.execute('SELECT * FROM entries WHERE id = ?',
                           (entry_id,)).fetchone()
        return self._row_to_entry(row) if row else None

    def delete(self, entry_id: int) -> bool:
        conn = self._get_conn()
        cursor = conn.execute('DELETE FROM entries WHERE id = ?', (entry_id,))
        conn.commit()
        return cursor.rowcount > 0

    def list(self, category: str | None = None, type: str | None = None,
             limit: int = 50) -> list[VaultEntry]:
        conn = self._get_conn()
        conditions, params = [], []
        if category:
            conditions.append('category = ?')
            params.append(category)
        if type:
            conditions.append('type = ?')
            params.append(type)
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
        sql = f'SELECT * FROM entries{where} ORDER BY updated_at DESC LIMIT ?'
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def stats(self) -> dict:
        conn = self._get_conn()
        by_category = conn.execute(
            'SELECT category, COUNT(*) as count FROM entries '
            'GROUP BY category ORDER BY count DESC'
        ).fetchall()
        by_type = conn.execute(
            'SELECT type, COUNT(*) as count FROM entries '
            'GROUP BY type ORDER BY count DESC'
        ).fetchall()
        total = sum(row['count'] for row in by_category)
        oldest, newest = conn.execute(
            'SELECT MIN(created_at), MAX(created_at) FROM entries'
        ).fetchone()
        return {
            'total_entries': total,
            'by_category': {row['category']: row['count'] for row in by_category},
            'by_type': {row['type']: row['count'] for row in by_type},
            'oldest_entry': oldest,
            'newest_entry': newest,
        }

    def export(self, category: str | None = None,
               type: str | None = None) -> list[VaultEntry]:
        conn = self._get_conn()
        conditions, params = [], []
        if category:
            conditions.append('category = ?')
            params.append(category)
        if type:
            conditions.append('type = ?')
            params.append(type)
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
        sql = f'SELECT * FROM entries{where} ORDER BY created_at ASC'
        rows = conn.execute(sql, params).fetchall()
        return [self._row_to_entry(r) for r in rows]

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
