import sys
from pathlib import Path

import pytest

# Ensure repo root is on sys.path for roxabi_sdk imports
_repo_root = str(Path(__file__).resolve().parents[1])
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)


@pytest.fixture(autouse=True)
def isolated_vault(monkeypatch, tmp_path):
    """Redirect all vault operations to a temp directory."""
    vault_dir = tmp_path / 'vault'
    vault_dir.mkdir(mode=0o700)
    monkeypatch.setenv('ROXABI_VAULT_HOME', str(vault_dir))
    return vault_dir
