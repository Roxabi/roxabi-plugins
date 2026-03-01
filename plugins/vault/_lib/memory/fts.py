"""FTS5 operations — index, search, remove."""

import sqlite3


def index_entry(conn: sqlite3.Connection, entry_id: int, title: str,
                content: str, category: str, entry_type: str) -> None:
    """Manually index an entry into FTS5 (used for migration/rebuild).

    For normal inserts, the AFTER INSERT trigger handles FTS indexing
    automatically. Use this only when populating FTS from existing rows.
    """
    conn.execute(
        'INSERT INTO entries_fts(rowid, title, content, category, type) '
        'VALUES (?, ?, ?, ?, ?)',
        (entry_id, title, content, category, entry_type)
    )


def search_entries(conn: sqlite3.Connection, query: str,
                   limit: int = 20) -> list[sqlite3.Row]:
    """Full-text search across title, content, category, type.

    Returns matching entries ordered by relevance (BM25).
    Wraps query in double-quotes to prevent FTS5 syntax errors on
    user input containing special characters (AND, OR, *, etc.).
    """
    sql = """
        SELECT e.*, rank
        FROM entries_fts fts
        JOIN entries e ON e.id = fts.rowid
        WHERE entries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
    """
    # Escape embedded double-quotes and wrap in quotes for literal matching
    safe_query = '"' + query.replace('"', '""') + '"'
    return conn.execute(sql, (safe_query, limit)).fetchall()


def remove_entry(conn: sqlite3.Connection, entry_id: int) -> None:
    """Remove an entry from FTS5 index (used for migration/rebuild).

    For normal deletes, the AFTER DELETE trigger handles FTS removal
    automatically. Use this only for manual FTS maintenance.
    """
    row = conn.execute(
        'SELECT title, content, category, type FROM entries WHERE id = ?',
        (entry_id,)
    ).fetchone()
    if row:
        conn.execute(
            'INSERT INTO entries_fts(entries_fts, rowid, title, content, category, type) '
            "VALUES ('delete', ?, ?, ?, ?, ?)",
            (entry_id, row['title'], row['content'], row['category'], row['type'])
        )
