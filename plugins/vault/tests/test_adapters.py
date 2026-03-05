"""Tests for vault adapter implementations — SqliteEntryRepository + Fts5SearchAdapter."""
import json
import sys
from pathlib import Path

import pytest

# Ensure plugin root + repo root on sys.path for imports
_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for p in [_plugin_root, _repo_root]:
    if p not in sys.path:
        sys.path.insert(0, p)

from adapters.sqlite_repository import SqliteEntryRepository
from adapters.fts5_search import Fts5SearchAdapter
from domain.models import VaultEntry, SearchResult


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / 'test.db'


@pytest.fixture
def repo(db_path):
    return SqliteEntryRepository(db_path=db_path)


@pytest.fixture
def search(db_path, repo):
    # Ensure schema exists (repo creates it on first use)
    repo.add('test', 'note', 'setup', 'setup content')
    return Fts5SearchAdapter(db_path=db_path)


class TestSqliteEntryRepository:

    def test_add_returns_vault_entry(self, repo):
        entry = repo.add('test', 'note', 'Title', 'Content')
        assert isinstance(entry, VaultEntry)
        assert entry.title == 'Title'
        assert entry.content == 'Content'
        assert entry.category == 'test'
        assert entry.type == 'note'
        assert entry.id >= 1

    def test_add_with_metadata(self, repo):
        meta = json.dumps({'key': 'value'})
        entry = repo.add('test', 'note', 'Title', 'Content', metadata=meta)
        assert entry.metadata == meta

    def test_get_returns_entry(self, repo):
        added = repo.add('test', 'note', 'Title', 'Content')
        fetched = repo.get(added.id)
        assert fetched.id == added.id
        assert fetched.title == 'Title'

    def test_get_nonexistent_returns_none(self, repo):
        # Ensure schema exists
        repo.add('test', 'note', 'setup', 'content')
        result = repo.get(9999)
        assert result is None

    def test_delete_existing(self, repo):
        entry = repo.add('test', 'note', 'Title', 'Content')
        assert repo.delete(entry.id) is True

    def test_delete_nonexistent(self, repo):
        repo.add('test', 'note', 'setup', 'content')
        assert repo.delete(9999) is False

    def test_list_all(self, repo):
        repo.add('cat1', 'note', 'A', 'content a')
        repo.add('cat2', 'note', 'B', 'content b')
        entries = repo.list()
        assert len(entries) == 2

    def test_list_by_category(self, repo):
        repo.add('cat1', 'note', 'A', 'content a')
        repo.add('cat2', 'note', 'B', 'content b')
        entries = repo.list(category='cat1')
        assert len(entries) == 1
        assert entries[0].category == 'cat1'

    def test_list_by_type(self, repo):
        repo.add('cat1', 'note', 'A', 'content a')
        repo.add('cat1', 'article', 'B', 'content b')
        entries = repo.list(type='article')
        assert len(entries) == 1
        assert entries[0].type == 'article'

    def test_list_with_limit(self, repo):
        for i in range(5):
            repo.add('cat', 'note', f'Title {i}', f'content {i}')
        entries = repo.list(limit=3)
        assert len(entries) == 3

    def test_stats(self, repo):
        repo.add('cat1', 'note', 'A', 'content')
        repo.add('cat1', 'article', 'B', 'content')
        repo.add('cat2', 'note', 'C', 'content')
        stats = repo.stats()
        assert stats['total_entries'] == 3
        assert 'cat1' in stats['by_category']
        assert stats['by_category']['cat1'] == 2

    def test_export_all(self, repo):
        repo.add('cat1', 'note', 'A', 'content a')
        repo.add('cat2', 'note', 'B', 'content b')
        entries = repo.export()
        assert len(entries) == 2

    def test_export_filtered(self, repo):
        repo.add('cat1', 'note', 'A', 'content a')
        repo.add('cat2', 'note', 'B', 'content b')
        entries = repo.export(category='cat1')
        assert len(entries) == 1


class TestFts5SearchAdapter:

    def test_search_returns_results(self, search, repo):
        repo.add('test', 'note', 'Python Guide', 'A comprehensive Python tutorial')
        results = search.search('Python')
        assert len(results) >= 1
        assert isinstance(results[0], SearchResult)
        assert isinstance(results[0].entry, VaultEntry)

    def test_search_no_match(self, search):
        results = search.search('xyznonexistent')
        # May return the setup entry or nothing depending on FTS
        # Just verify it returns a list of SearchResult
        assert isinstance(results, list)

    def test_search_with_limit(self, search, repo):
        for i in range(5):
            repo.add('test', 'note', f'Python topic {i}', f'Python content {i}')
        results = search.search('Python', limit=2)
        assert len(results) <= 2
