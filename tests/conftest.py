import pytest


@pytest.fixture(autouse=True)
def isolated_vault(monkeypatch, tmp_path):
    """Redirect all vault operations to a temp directory."""
    vault_dir = tmp_path / 'vault'
    vault_dir.mkdir(mode=0o700)
    monkeypatch.setenv('ROXABI_VAULT_HOME', str(vault_dir))
    return vault_dir
