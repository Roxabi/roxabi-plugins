"""Roxabi vault path resolution — canonical copy."""
import os
import sqlite3
from pathlib import Path


def get_vault_home() -> Path:
    """~/.roxabi-vault/ by default, or ROXABI_VAULT_HOME if set."""
    return Path(os.environ.get('ROXABI_VAULT_HOME', Path.home() / '.roxabi-vault'))


def get_plugin_data(plugin_name: str) -> Path:
    """~/.roxabi-vault/<plugin>/"""
    return get_vault_home() / plugin_name


def get_shared_dir(name: str) -> Path:
    """~/.roxabi-vault/<name>/ for shared directories (content, ideas, learnings)."""
    return get_vault_home() / name


def get_config(plugin_name: str) -> Path:
    """~/.roxabi-vault/config/<plugin_name>.json"""
    return get_vault_home() / 'config' / f'{plugin_name}.json'


def ensure_dir(path: Path) -> Path:
    """Create directory with parents, return path."""
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def vault_available() -> bool:
    """Check if vault.db exists."""
    return (get_vault_home() / 'vault.db').exists()


def vault_healthy() -> bool:
    """Check if vault.db exists AND is a valid SQLite database."""
    db = get_vault_home() / 'vault.db'
    if not db.exists():
        return False
    try:
        conn = sqlite3.connect(str(db))
        try:
            conn.execute('PRAGMA user_version')
            return True
        finally:
            conn.close()
    except Exception:
        return False
