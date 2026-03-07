"""SQLite adapter for EntryRepository port — thin wrapper over roxabi_memory.MemoryDB."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from roxabi_memory.db import MemoryDB

from domain.exceptions import StorageError
from domain.models import VaultEntry, VaultStats
from ports.repository import EntryRepository


class SqliteEntryRepository(EntryRepository):
    """Concrete EntryRepository backed by roxabi_memory.MemoryDB."""

    def __init__(self, db_path: Path):
        self._db = MemoryDB(db_path)
        self._db.connect()

    def _get_conn(self) -> sqlite3.Connection:
        """Expose raw connection for shared-connection consumers (e.g. Fts5SearchAdapter)."""
        return self._db._conn_or_raise()

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
        try:
            entry = self._db.save_entry(
                content=content,
                type=type,
                title=title,
                category=category,
                namespace='vault',
                metadata=metadata or '{}',
            )
            return VaultEntry(
                id=entry.id,
                category=entry.category,
                type=entry.type,
                title=entry.title,
                content=entry.content,
                created_at=entry.created_at,
                updated_at=entry.updated_at,
                metadata=entry.metadata,
            )
        except sqlite3.Error as e:
            raise StorageError(str(e)) from e

    def get(self, entry_id: int) -> VaultEntry | None:
        try:
            conn = self._get_conn()
            row = conn.execute('SELECT * FROM entries WHERE id = ?',
                               (entry_id,)).fetchone()
            return self._row_to_entry(row) if row else None
        except sqlite3.Error as e:
            raise StorageError(str(e)) from e

    def delete(self, entry_id: int) -> bool:
        try:
            conn = self._get_conn()
            cursor = conn.execute('DELETE FROM entries WHERE id = ?', (entry_id,))
            conn.commit()
            return cursor.rowcount > 0
        except sqlite3.Error as e:
            raise StorageError(str(e)) from e

    def list(self, category: str | None = None, type: str | None = None,
             limit: int = 50) -> list[VaultEntry]:
        try:
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
        except sqlite3.Error as e:
            raise StorageError(str(e)) from e

    def stats(self) -> VaultStats:
        try:
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
            return VaultStats(
                total_entries=total,
                by_category={row['category']: row['count'] for row in by_category},
                by_type={row['type']: row['count'] for row in by_type},
                oldest_entry=oldest,
                newest_entry=newest,
            )
        except sqlite3.Error as e:
            raise StorageError(str(e)) from e

    def export(self, category: str | None = None,
               type: str | None = None) -> list[VaultEntry]:
        try:
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
        except sqlite3.Error as e:
            raise StorageError(str(e)) from e

    def close(self) -> None:
        self._db.close()
