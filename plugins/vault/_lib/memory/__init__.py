"""Roxabi vault memory — FTS5 helpers for migration/rebuild."""

from .fts import index_entry, search_entries, remove_entry

__all__ = ['index_entry', 'search_entries', 'remove_entry']
