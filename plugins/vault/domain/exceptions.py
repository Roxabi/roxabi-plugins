"""Vault exception hierarchy."""


class PluginError(Exception):
    """Base exception for all Roxabi plugin errors."""


class VaultError(PluginError):
    """Base exception for vault plugin."""


class EntryNotFoundError(VaultError):
    """Entry not found in vault."""
    def __init__(self, entry_id: int):
        self.entry_id = entry_id
        super().__init__(f"Entry #{entry_id} not found")


class FtsIndexError(VaultError):
    """FTS indexing error."""


class StorageError(VaultError):
    """Database or filesystem storage error."""
