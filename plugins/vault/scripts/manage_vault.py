#!/usr/bin/env python3
"""Roxabi vault CLI — add, search, list, get, delete, stats, export."""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Resolve imports from plugin root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _lib.paths import get_vault_home, vault_available
from _lib.memory.db import VaultDB
from _lib.memory.fts import search_entries


def get_db() -> VaultDB:
    """Get a connected VaultDB instance."""
    db = VaultDB()
    db.connect()
    return db


def cmd_add(args):
    """Add an entry to the vault."""
    db = get_db()
    try:
        metadata = json.loads(args.metadata) if args.metadata else {}
        cursor = db.conn.execute(
            'INSERT INTO entries (category, type, title, content, metadata) '
            'VALUES (?, ?, ?, ?, ?)',
            (args.category, args.type, args.title, args.content,
             json.dumps(metadata))
        )
        db.conn.commit()
        entry_id = cursor.lastrowid
        print(json.dumps({'id': entry_id, 'status': 'added'}))
    finally:
        db.close()


def cmd_search(args):
    """Full-text search across vault entries."""
    db = get_db()
    try:
        rows = search_entries(db.conn, args.query, limit=args.limit)
        results = []
        for row in rows:
            results.append({
                'id': row['id'],
                'category': row['category'],
                'type': row['type'],
                'title': row['title'],
                'content': row['content'][:200] + ('...' if len(row['content']) > 200 else ''),
                'created_at': row['created_at']
            })
        print(json.dumps(results, indent=2))
    finally:
        db.close()


def build_filter(args) -> tuple[str, list]:
    """Build WHERE clause from --category/--type args."""
    conditions = []
    params = []
    if getattr(args, 'category', None):
        conditions.append('category = ?')
        params.append(args.category)
    if getattr(args, 'type', None):
        conditions.append('type = ?')
        params.append(args.type)
    where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
    return where, params


def cmd_list(args):
    """List vault entries, optionally filtered by category/type."""
    db = get_db()
    try:
        where, params = build_filter(args)
        sql = 'SELECT id, category, type, title, created_at, updated_at FROM entries' + where

        sql += ' ORDER BY updated_at DESC LIMIT ?'
        params.append(args.limit)

        rows = db.conn.execute(sql, params).fetchall()
        results = [dict(row) for row in rows]
        print(json.dumps(results, indent=2))
    finally:
        db.close()


def cmd_get(args):
    """Get a single entry by ID."""
    db = get_db()
    try:
        row = db.conn.execute(
            'SELECT * FROM entries WHERE id = ?', (args.id,)
        ).fetchone()
        if row:
            result = dict(row)
            result['metadata'] = json.loads(result['metadata'])
            print(json.dumps(result, indent=2))
        else:
            print(json.dumps({'error': f'Entry {args.id} not found'}),
                  file=sys.stderr)
            sys.exit(1)
    finally:
        db.close()


def cmd_delete(args):
    """Delete an entry by ID."""
    db = get_db()
    try:
        cursor = db.conn.execute(
            'DELETE FROM entries WHERE id = ?', (args.id,)
        )
        db.conn.commit()
        if cursor.rowcount:
            print(json.dumps({'id': args.id, 'status': 'deleted'}))
        else:
            print(json.dumps({'error': f'Entry {args.id} not found'}),
                  file=sys.stderr)
            sys.exit(1)
    finally:
        db.close()


def cmd_stats(args):
    """Show vault statistics."""
    db = get_db()
    try:
        by_category = db.conn.execute(
            'SELECT category, COUNT(*) as count FROM entries '
            'GROUP BY category ORDER BY count DESC'
        ).fetchall()
        by_type = db.conn.execute(
            'SELECT type, COUNT(*) as count FROM entries '
            'GROUP BY type ORDER BY count DESC'
        ).fetchall()
        total = sum(row[1] for row in by_category)
        oldest, newest = db.conn.execute(
            'SELECT MIN(created_at), MAX(created_at) FROM entries'
        ).fetchone()

        db_path = get_vault_home() / 'vault.db'
        db_size = db_path.stat().st_size if db_path.exists() else 0

        stats = {
            'total_entries': total,
            'by_category': {row[0]: row[1] for row in by_category},
            'by_type': {row[0]: row[1] for row in by_type},
            'oldest_entry': oldest,
            'newest_entry': newest,
            'db_size_bytes': db_size
        }
        print(json.dumps(stats, indent=2))
    finally:
        db.close()


def cmd_export(args):
    """Export vault entries as JSON."""
    db = get_db()
    try:
        where, params = build_filter(args)
        sql = 'SELECT * FROM entries' + where + ' ORDER BY created_at ASC'

        rows = db.conn.execute(sql, params).fetchall()
        entries = []
        for row in rows:
            entry = dict(row)
            entry['metadata'] = json.loads(entry['metadata'])
            entries.append(entry)

        output = {
            'exported_at': datetime.now().isoformat(),
            'count': len(entries),
            'entries': entries
        }

        if args.output:
            Path(args.output).write_text(json.dumps(output, indent=2))
            print(json.dumps({'status': 'exported', 'file': args.output,
                              'count': len(entries)}))
        else:
            print(json.dumps(output, indent=2))
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(
        description='Roxabi vault — manage your knowledge base'
    )
    sub = parser.add_subparsers(dest='command', required=True)

    # add
    p_add = sub.add_parser('add', help='Add an entry')
    p_add.add_argument('--category', required=True, help='Entry category')
    p_add.add_argument('--type', required=True, help='Entry type')
    p_add.add_argument('--title', required=True, help='Entry title')
    p_add.add_argument('--content', required=True, help='Entry content')
    p_add.add_argument('--metadata', help='JSON metadata string')
    p_add.set_defaults(func=cmd_add)

    # search
    p_search = sub.add_parser('search', help='Full-text search')
    p_search.add_argument('query', help='Search query')
    p_search.add_argument('--limit', type=int, default=20, help='Max results')
    p_search.set_defaults(func=cmd_search)

    # list
    p_list = sub.add_parser('list', help='List entries')
    p_list.add_argument('--category', help='Filter by category')
    p_list.add_argument('--type', help='Filter by type')
    p_list.add_argument('--limit', type=int, default=50, help='Max results')
    p_list.set_defaults(func=cmd_list)

    # get
    p_get = sub.add_parser('get', help='Get entry by ID')
    p_get.add_argument('id', type=int, help='Entry ID')
    p_get.set_defaults(func=cmd_get)

    # delete
    p_del = sub.add_parser('delete', help='Delete entry by ID')
    p_del.add_argument('id', type=int, help='Entry ID')
    p_del.set_defaults(func=cmd_delete)

    # stats
    p_stats = sub.add_parser('stats', help='Show vault statistics')
    p_stats.set_defaults(func=cmd_stats)

    # export
    p_export = sub.add_parser('export', help='Export entries as JSON')
    p_export.add_argument('--category', help='Filter by category')
    p_export.add_argument('--type', help='Filter by type')
    p_export.add_argument('--output', '-o', help='Output file path')
    p_export.set_defaults(func=cmd_export)

    args = parser.parse_args()

    if not vault_available():
        print(json.dumps({
            'error': 'Vault not initialized. Run vault-init first.'
        }), file=sys.stderr)
        sys.exit(1)

    args.func(args)


if __name__ == '__main__':
    main()
