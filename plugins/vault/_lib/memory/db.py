"""VaultDB — SQLite+FTS5 database connection and schema management."""

import sqlite3
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from _lib.paths import get_vault_home


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


class VaultDB:
    """SQLite+FTS5 vault database connection."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or (get_vault_home() / 'vault.db')
        self.conn: sqlite3.Connection | None = None

    def connect(self) -> sqlite3.Connection:
        """Open connection with WAL mode enabled."""
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.execute('PRAGMA foreign_keys=ON')
        return self.conn

    def create_tables(self) -> None:
        """Create entries table and FTS5 index if not present."""
        if not self.conn:
            self.connect()
        self.conn.executescript(SCHEMA_SQL)
        self.conn.execute('PRAGMA user_version = 1')

    def close(self) -> None:
        """Close the database connection."""
        if self.conn:
            self.conn.close()
            self.conn = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False
