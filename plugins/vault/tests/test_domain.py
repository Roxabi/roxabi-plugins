"""Tests for vault domain models and exceptions."""
import pytest


def test_vault_entry_frozen():
    from domain.models import VaultEntry
    e = VaultEntry(id=1, category="test", type="note", title="t", content="c",
                   created_at="2026-01-01", updated_at="2026-01-01")
    assert e.title == "t"
    assert e.category == "test"
    with pytest.raises(AttributeError):
        e.title = "modified"


def test_vault_entry_with_metadata():
    from domain.models import VaultEntry
    e = VaultEntry(id=1, category="test", type="note", title="t", content="c",
                   created_at="2026-01-01", updated_at="2026-01-01", metadata='{"key": "val"}')
    assert e.metadata == '{"key": "val"}'


def test_vault_entry_default_metadata():
    from domain.models import VaultEntry
    e = VaultEntry(id=1, category="test", type="note", title="t", content="c",
                   created_at="2026-01-01", updated_at="2026-01-01")
    assert e.metadata == ""


def test_search_result():
    from domain.models import VaultEntry, SearchResult
    entry = VaultEntry(id=1, category="test", type="note", title="t", content="c",
                       created_at="2026-01-01", updated_at="2026-01-01")
    sr = SearchResult(entry=entry, rank=0.95)
    assert sr.rank == 0.95
    assert sr.entry.id == 1


def test_vault_exceptions_hierarchy():
    from domain.exceptions import PluginError, VaultError, EntryNotFoundError, IndexError
    assert issubclass(VaultError, PluginError)
    assert issubclass(EntryNotFoundError, VaultError)
    assert issubclass(IndexError, VaultError)

    with pytest.raises(PluginError):
        raise VaultError("test")

    with pytest.raises(VaultError):
        raise EntryNotFoundError(42)


def test_entry_repository_is_abstract():
    from ports.repository import EntryRepository
    with pytest.raises(TypeError):
        EntryRepository()


def test_search_port_is_abstract():
    from ports.search import SearchPort
    with pytest.raises(TypeError):
        SearchPort()
