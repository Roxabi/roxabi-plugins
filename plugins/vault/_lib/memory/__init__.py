"""Roxabi vault memory — SQLite+FTS5 storage layer."""

from .db import VaultDB
from .fts import index_entry, search_entries, remove_entry

__all__ = ['VaultDB', 'index_entry', 'search_entries', 'remove_entry']
