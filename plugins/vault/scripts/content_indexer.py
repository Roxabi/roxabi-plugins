#!/usr/bin/env python3
"""Content indexer — cross-plugin helper to index content in vault.

Usage as CLI (from any plugin):

    python3 <vault-plugin>/scripts/content_indexer.py \
        --category content --type linkedin-post \
        --title "My Post" --content "Post body..."

Usage as library (within vault plugin):

    from content_indexer import index_content
    entry_id = index_content('notes', 'meeting', 'Standup 2024-01-15', body)

Returns entry id if indexed, None if vault is unavailable.
Never raises — always fails gracefully.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # plugin root
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # repo root
from roxabi_sdk.paths import get_vault_home
from adapters.sqlite_repository import SqliteEntryRepository


def index_content(category: str, entry_type: str, title: str, content: str,
                  metadata: dict | None = None) -> int | None:
    """Index content in the vault. Returns entry id or None if unavailable.

    This function never raises. If the vault is not initialized or any
    error occurs, it returns None silently.
    """
    try:
        db_path = get_vault_home() / 'vault.db'
        repo = SqliteEntryRepository(db_path)
        try:
            entry = repo.add(category, entry_type, title, content,
                             json.dumps(metadata or {}))
            return entry.id
        finally:
            repo.close()
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description='Index content in the Roxabi vault')
    parser.add_argument('--category', required=True, help='Entry category')
    parser.add_argument('--type', required=True, help='Entry type')
    parser.add_argument('--title', required=True, help='Entry title')
    parser.add_argument('--content', required=True, help='Entry content')
    parser.add_argument('--metadata', default=None, help='JSON metadata string')
    args = parser.parse_args()

    metadata = json.loads(args.metadata) if args.metadata else None
    entry_id = index_content(args.category, args.type, args.title, args.content, metadata)

    if entry_id is not None:
        print(json.dumps({'id': entry_id, 'status': 'indexed'}))
    else:
        print(json.dumps({'status': 'skipped', 'reason': 'vault unavailable'}),
              file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
