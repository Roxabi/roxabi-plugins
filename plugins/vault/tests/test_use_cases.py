"""Tests for vault use cases — mocked ports, no I/O."""
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for p in [_plugin_root, _repo_root]:
    if p not in sys.path:
        sys.path.insert(0, p)

from domain.models import VaultEntry, SearchResult
from use_cases.add_entry import AddEntryUseCase
from use_cases.search_entries import SearchEntriesUseCase


class TestAddEntryUseCase:

    def test_delegates_to_repo(self):
        mock_repo = MagicMock()
        mock_repo.add.return_value = VaultEntry(
            id=1, category='test', type='note', title='Title',
            content='Content', created_at='now', updated_at='now',
        )
        uc = AddEntryUseCase(repo=mock_repo)
        result = uc.execute('test', 'note', 'Title', 'Content')
        mock_repo.add.assert_called_once_with('test', 'note', 'Title', 'Content', '')
        assert result.id == 1
        assert result.title == 'Title'

    def test_passes_metadata(self):
        mock_repo = MagicMock()
        mock_repo.add.return_value = VaultEntry(
            id=2, category='test', type='note', title='T',
            content='C', metadata='{"key":"val"}',
            created_at='now', updated_at='now',
        )
        uc = AddEntryUseCase(repo=mock_repo)
        result = uc.execute('test', 'note', 'T', 'C', '{"key":"val"}')
        mock_repo.add.assert_called_once_with('test', 'note', 'T', 'C', '{"key":"val"}')
        assert result.metadata == '{"key":"val"}'


class TestSearchEntriesUseCase:

    def test_delegates_to_search(self):
        entry = VaultEntry(
            id=1, category='test', type='note', title='Found',
            content='Body', created_at='now', updated_at='now',
        )
        mock_search = MagicMock()
        mock_search.search.return_value = [SearchResult(entry=entry, rank=0.95)]
        uc = SearchEntriesUseCase(search=mock_search)
        results = uc.execute('query')
        mock_search.search.assert_called_once_with('query', limit=20)
        assert len(results) == 1
        assert results[0].entry.title == 'Found'

    def test_custom_limit(self):
        mock_search = MagicMock()
        mock_search.search.return_value = []
        uc = SearchEntriesUseCase(search=mock_search)
        uc.execute('q', limit=5)
        mock_search.search.assert_called_once_with('q', limit=5)
