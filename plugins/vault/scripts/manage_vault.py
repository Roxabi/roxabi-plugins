#!/usr/bin/env python3
"""Roxabi vault CLI — add, search, list, get, delete, stats, export."""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Resolve imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # plugin root
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # repo root
from roxabi_sdk.paths import get_vault_home, vault_available
from adapters.sqlite_repository import SqliteEntryRepository
from adapters.fts5_search import Fts5SearchAdapter


def get_db_path() -> Path:
    return get_vault_home() / 'vault.db'


def cmd_add(args, repo):
    """Add an entry to the vault."""
    metadata = json.dumps(json.loads(args.metadata)) if args.metadata else '{}'
    entry = repo.add(args.category, args.type, args.title, args.content, metadata)
    print(json.dumps({'id': entry.id, 'status': 'added'}))


def cmd_search(args, repo, search):
    """Full-text search across vault entries."""
    results = search.search(args.query, limit=args.limit)
    output = []
    for r in results:
        output.append({
            'id': r.entry.id,
            'category': r.entry.category,
            'type': r.entry.type,
            'title': r.entry.title,
            'content': r.entry.content[:200] + ('...' if len(r.entry.content) > 200 else ''),
            'created_at': r.entry.created_at
        })
    print(json.dumps(output, indent=2))


def cmd_list(args, repo):
    """List vault entries, optionally filtered by category/type."""
    entries = repo.list(
        category=getattr(args, 'category', None),
        type=getattr(args, 'type', None),
        limit=args.limit
    )
    results = [
        {
            'id': e.id, 'category': e.category, 'type': e.type,
            'title': e.title, 'created_at': e.created_at, 'updated_at': e.updated_at
        }
        for e in entries
    ]
    print(json.dumps(results, indent=2))


def cmd_get(args, repo):
    """Get a single entry by ID."""
    entry = repo.get(args.id)
    if entry:
        result = {
            'id': entry.id, 'category': entry.category, 'type': entry.type,
            'title': entry.title, 'content': entry.content,
            'created_at': entry.created_at, 'updated_at': entry.updated_at,
            'metadata': json.loads(entry.metadata),
        }
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps({'error': f'Entry {args.id} not found'}),
              file=sys.stderr)
        sys.exit(1)


def cmd_delete(args, repo):
    """Delete an entry by ID."""
    if repo.delete(args.id):
        print(json.dumps({'id': args.id, 'status': 'deleted'}))
    else:
        print(json.dumps({'error': f'Entry {args.id} not found'}),
              file=sys.stderr)
        sys.exit(1)


def cmd_stats(args, repo):
    """Show vault statistics."""
    stats = repo.stats()
    db_path = get_db_path()
    output = {
        'total_entries': stats.total_entries,
        'by_category': stats.by_category,
        'by_type': stats.by_type,
        'oldest_entry': stats.oldest_entry,
        'newest_entry': stats.newest_entry,
        'db_size_bytes': db_path.stat().st_size if db_path.exists() else 0,
    }
    print(json.dumps(output, indent=2))


def cmd_export(args, repo):
    """Export vault entries as JSON."""
    entries = repo.export(
        category=getattr(args, 'category', None),
        type=getattr(args, 'type', None),
    )
    output_entries = [
        {
            'id': e.id, 'category': e.category, 'type': e.type,
            'title': e.title, 'content': e.content,
            'created_at': e.created_at, 'updated_at': e.updated_at,
            'metadata': json.loads(e.metadata),
        }
        for e in entries
    ]
    output = {
        'exported_at': datetime.now().isoformat(),
        'count': len(output_entries),
        'entries': output_entries
    }

    if args.output:
        Path(args.output).write_text(json.dumps(output, indent=2))
        print(json.dumps({'status': 'exported', 'file': args.output,
                          'count': len(output_entries)}))
    else:
        print(json.dumps(output, indent=2))


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

    # search
    p_search = sub.add_parser('search', help='Full-text search')
    p_search.add_argument('query', help='Search query')
    p_search.add_argument('--limit', type=int, default=20, help='Max results')

    # list
    p_list = sub.add_parser('list', help='List entries')
    p_list.add_argument('--category', help='Filter by category')
    p_list.add_argument('--type', help='Filter by type')
    p_list.add_argument('--limit', type=int, default=50, help='Max results')

    # get
    p_get = sub.add_parser('get', help='Get entry by ID')
    p_get.add_argument('id', type=int, help='Entry ID')

    # delete
    p_del = sub.add_parser('delete', help='Delete entry by ID')
    p_del.add_argument('id', type=int, help='Entry ID')

    # stats
    sub.add_parser('stats', help='Show vault statistics')

    # export
    p_export = sub.add_parser('export', help='Export entries as JSON')
    p_export.add_argument('--category', help='Filter by category')
    p_export.add_argument('--type', help='Filter by type')
    p_export.add_argument('--output', '-o', help='Output file path')

    args = parser.parse_args()

    if not vault_available():
        print(json.dumps({
            'error': 'Vault not initialized. Run vault-init first.'
        }), file=sys.stderr)
        sys.exit(1)

    # Composition root — construct adapters (shared connection)
    db_path = get_db_path()
    repo = SqliteEntryRepository(db_path)
    search = Fts5SearchAdapter(db_path, conn=repo._get_conn())

    try:
        if args.command == 'add':
            cmd_add(args, repo)
        elif args.command == 'search':
            cmd_search(args, repo, search)
        elif args.command == 'list':
            cmd_list(args, repo)
        elif args.command == 'get':
            cmd_get(args, repo)
        elif args.command == 'delete':
            cmd_delete(args, repo)
        elif args.command == 'stats':
            cmd_stats(args, repo)
        elif args.command == 'export':
            cmd_export(args, repo)
    finally:
        repo.close()
        search.close()


if __name__ == '__main__':
    main()
