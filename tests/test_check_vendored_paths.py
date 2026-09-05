"""Tests for the vendored-path-helper gate in tools/validate_plugins.py.

The gate is a ban, not a sync comparison: `roxabi_sdk.paths` is the only home
for path resolution, so any plugin-local `paths.py` is an error. It replaced an
inert filecmp check, so it is pinned here — an empty tree passes either way,
which makes CI unable to tell the ban from its no-op predecessor.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / 'tools' / 'validate_plugins.py'


def _load_tool():
    """Import tools/validate_plugins.py as a module."""
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _gate(tmp_path: Path, *vendored: str) -> list[str]:
    """Run check_vendored_paths against a synthetic plugins tree."""
    mod = _load_tool()
    plugins_dir = tmp_path / 'plugins'
    for rel in vendored:
        target = plugins_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('# vendored\n', encoding='utf-8')
    plugins_dir.mkdir(parents=True, exist_ok=True)
    mod.REPO_ROOT = tmp_path
    mod.PLUGINS_DIR = plugins_dir
    return mod.check_vendored_paths()


def test_clean_tree_passes(tmp_path):
    assert _gate(tmp_path, 'cv/scripts/generate_cv.py', 'cv/scripts/storage.py') == []


def test_flags_plugin_root_lib_copy(tmp_path):
    """The shape ADR-001 called canonical; plugins/vault used it until a0a8a679."""
    errors = _gate(tmp_path, 'vault/_lib/paths.py')
    assert len(errors) == 1
    assert 'vault/_lib/paths.py' in errors[0]
    assert 'roxabi_sdk.paths' in errors[0]


def test_flags_every_vendoring_shape(tmp_path):
    errors = _gate(
        tmp_path,
        'cv/scripts/_lib/paths.py',
        'cv/skills/build/scripts/_lib/paths.py',
        'compress/scripts/_lib/paths/__init__.py',
        'compress/scripts/_paths.py',
    )
    assert len(errors) == 4


def test_gate_is_wired_into_the_run():
    """A check that never runs cannot fail; pin the registration too."""
    result = subprocess.run(
        [sys.executable, str(TOOL)],
        capture_output=True,
        text=True,
    )
    assert 'No vendored paths.py' in result.stdout
