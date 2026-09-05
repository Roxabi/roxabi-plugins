"""Tests for the per-plugin `_sdk_bootstrap.py` SDK resolver.

The resolver replaced a hardcoded `parents[3]` guess that only held in the repo
checkout. Installed plugins live at
`~/.claude/plugins/cache/<marketplace>/<plugin>/<hash>/`, where `parents[3]` is
`.../plugins/cache` — a directory that never contains `roxabi_sdk/`, so every
Python entrypoint died with `ModuleNotFoundError` at import time. The installed
layout is pinned here twice: once on the resolver, once end-to-end on a real
entrypoint copied into a mirror of that cache tree.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGINS_DIR = REPO_ROOT / 'plugins'
BOOTSTRAP = PLUGINS_DIR / 'compress' / '_sdk_bootstrap.py'
MARKETPLACE = 'roxabi-marketplace'
HASH = '0104dbc85244'  # shape of a real cache dir name


def _load_bootstrap():
    """Import a plugin's `_sdk_bootstrap.py` by path (it is not a package)."""
    spec = importlib.util.spec_from_file_location('_sdk_bootstrap_under_test', BOOTSTRAP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _plant_sdk(root: Path) -> Path:
    """Create the `roxabi_sdk/paths.py` marker under `root`."""
    (root / 'roxabi_sdk').mkdir(parents=True, exist_ok=True)
    (root / 'roxabi_sdk' / '__init__.py').write_text('', encoding='utf-8')
    (root / 'roxabi_sdk' / 'paths.py').write_text('MARKER = 1\n', encoding='utf-8')
    return root


def _cache_entrypoint(tmp_path: Path, plugin: str = 'compress') -> Path:
    """Mirror the installed layout; return the cached `scripts/x.py` path."""
    plugins = tmp_path / 'plugins'
    entry = plugins / 'cache' / MARKETPLACE / plugin / HASH / 'scripts' / 'x.py'
    entry.parent.mkdir(parents=True)
    entry.write_text('', encoding='utf-8')
    return entry


@pytest.fixture(autouse=True)
def no_sdk_override(monkeypatch):
    """The override must not leak in from the developer's environment."""
    monkeypatch.delenv('ROXABI_SDK_HOME', raising=False)


def test_repo_checkout_resolves_at_any_depth(tmp_path):
    """The upward walk removes the magic number: depth no longer matters."""
    repo = _plant_sdk(tmp_path / 'repo')
    deep = repo / 'plugins' / 'compress' / 'skills' / 'compress' / 'scripts' / 'x.py'
    deep.parent.mkdir(parents=True)

    assert _load_bootstrap().find_sdk_root(deep) == repo


def test_installed_cache_resolves_via_marketplace_clone(tmp_path):
    """The bug: `<plugins>/cache/<mk>/<plugin>/<hash>/` has no SDK above it."""
    entry = _cache_entrypoint(tmp_path)
    clone = _plant_sdk(tmp_path / 'plugins' / 'marketplaces' / MARKETPLACE)

    assert _load_bootstrap().find_sdk_root(entry) == clone


def test_env_override_wins_over_enclosing_repo(tmp_path, monkeypatch):
    repo = _plant_sdk(tmp_path / 'repo')
    override = _plant_sdk(tmp_path / 'elsewhere')
    entry = repo / 'plugins' / 'compress' / 'scripts' / 'x.py'
    entry.parent.mkdir(parents=True)
    monkeypatch.setenv('ROXABI_SDK_HOME', str(override))

    assert _load_bootstrap().find_sdk_root(entry) == override


def test_incomplete_env_override_falls_through(tmp_path, monkeypatch):
    """A stale `ROXABI_SDK_HOME` must not shadow a working checkout."""
    repo = _plant_sdk(tmp_path / 'repo')
    entry = repo / 'plugins' / 'compress' / 'scripts' / 'x.py'
    entry.parent.mkdir(parents=True)
    empty = tmp_path / 'empty'
    empty.mkdir()
    monkeypatch.setenv('ROXABI_SDK_HOME', str(empty))

    assert _load_bootstrap().find_sdk_root(entry) == repo


def test_missing_sdk_raises_and_names_what_it_searched(tmp_path):
    """No silent `None`: a caller would then insert 'None' onto sys.path."""
    entry = _cache_entrypoint(tmp_path)  # cache tree, no marketplace clone

    with pytest.raises(ModuleNotFoundError) as excinfo:
        _load_bootstrap().find_sdk_root(entry)

    message = str(excinfo.value)
    assert 'roxabi_sdk' in message
    assert str(tmp_path / 'plugins' / 'marketplaces' / MARKETPLACE) in message


def test_entrypoint_imports_from_installed_cache_layout(tmp_path):
    """End-to-end: a cached `count_tokens.py` must import its SDK.

    Copies the plugin root the way the installer does (plugin subtree only)
    next to a full marketplace clone, then imports the real entrypoint in a
    subprocess with no repo root in scope.
    """
    source = PLUGINS_DIR / 'compress'
    cached = tmp_path / 'plugins' / 'cache' / MARKETPLACE / 'compress' / HASH
    shutil.copytree(source / 'scripts', cached / 'scripts')
    for module in sorted(source.glob('*.py')):
        shutil.copy2(module, cached / module.name)
    clone = tmp_path / 'plugins' / 'marketplaces' / MARKETPLACE
    clone.mkdir(parents=True)
    shutil.copytree(REPO_ROOT / 'roxabi_sdk', clone / 'roxabi_sdk')

    env = {k: v for k, v in os.environ.items() if k not in ('PYTHONPATH', 'ROXABI_SDK_HOME')}
    result = subprocess.run(
        [sys.executable, '-c',
         'import sys; sys.path.insert(0, "scripts"); '
         'import count_tokens; print(count_tokens.PLUGIN_NAME)'],
        cwd=cached, env=env, capture_output=True, text=True,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'compress'


def test_bootstrap_copies_are_identical():
    """Per-plugin duplication is deliberate; divergence is not."""
    copies = sorted(PLUGINS_DIR.glob('*/_sdk_bootstrap.py'))
    assert len(copies) >= 2
    texts = {c.read_text(encoding='utf-8') for c in copies}
    assert len(texts) == 1, f'divergent copies: {[str(c) for c in copies]}'
