"""Tests for the canonical paths.py resolver."""
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Import paths module once
_vault_lib_parent = str(Path(__file__).resolve().parent.parent / 'plugins' / 'vault')
if _vault_lib_parent not in sys.path:
    sys.path.insert(0, _vault_lib_parent)
from _lib import paths as paths_module


def test_default_vault_home(monkeypatch):
    """get_vault_home() returns ~/.roxabi-vault/ when ROXABI_VAULT_HOME is unset."""
    monkeypatch.delenv('ROXABI_VAULT_HOME', raising=False)
    result = paths_module.get_vault_home()
    assert result == Path.home() / '.roxabi-vault'


def test_env_override(isolated_vault):
    """get_vault_home() respects ROXABI_VAULT_HOME."""
    result = paths_module.get_vault_home()
    assert result == isolated_vault


def test_get_plugin_data(isolated_vault):
    """get_plugin_data() returns subdirectory under vault home."""
    result = paths_module.get_plugin_data('cv')
    assert result == isolated_vault / 'cv'


def test_get_shared_dir(isolated_vault):
    """get_shared_dir() returns shared directory under vault home."""
    result = paths_module.get_shared_dir('content')
    assert result == isolated_vault / 'content'


def test_get_config(isolated_vault):
    """get_config() returns config file path."""
    result = paths_module.get_config('cv')
    assert result == isolated_vault / 'config' / 'cv.json'


def test_ensure_dir(isolated_vault):
    """ensure_dir() creates directory with correct permissions."""
    target = isolated_vault / 'sub' / 'dir'
    result = paths_module.ensure_dir(target)
    assert result == target
    assert target.is_dir()
    assert oct(target.stat().st_mode)[-3:] == '700'


def test_vault_available_false(isolated_vault):
    """vault_available() returns False when vault.db doesn't exist."""
    assert paths_module.vault_available() is False


def test_vault_available_true(isolated_vault):
    """vault_available() returns True when vault.db exists."""
    db_path = isolated_vault / 'vault.db'
    conn = sqlite3.connect(str(db_path))
    conn.execute('CREATE TABLE test (id INTEGER)')
    conn.close()
    assert paths_module.vault_available() is True


def test_vault_healthy_false_no_db(isolated_vault):
    """vault_healthy() returns False when no vault.db."""
    assert paths_module.vault_healthy() is False


def test_vault_healthy_true(isolated_vault):
    """vault_healthy() returns True for valid SQLite database."""
    db_path = isolated_vault / 'vault.db'
    conn = sqlite3.connect(str(db_path))
    conn.execute('PRAGMA user_version = 1')
    conn.close()
    assert paths_module.vault_healthy() is True


def test_vault_healthy_false_corrupt(isolated_vault):
    """vault_healthy() returns False for corrupt database."""
    db_path = isolated_vault / 'vault.db'
    db_path.write_text('not a database')
    assert paths_module.vault_healthy() is False


def test_vault_healthy_closes_conn_on_pragma_failure(isolated_vault):
    """Regression: vault_healthy() must close connection even when PRAGMA raises."""
    db_path = isolated_vault / 'vault.db'
    # Create a valid SQLite file so connect() succeeds
    conn = sqlite3.connect(str(db_path))
    conn.close()

    mock_conn = MagicMock()
    mock_conn.execute.side_effect = sqlite3.DatabaseError('simulated failure')

    with patch.object(paths_module.sqlite3, 'connect', return_value=mock_conn):
        result = paths_module.vault_healthy()

    assert result is False
    mock_conn.close.assert_called_once()
