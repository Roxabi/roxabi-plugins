"""Tests for the license-checker copy gate in tools/validate_plugins.py.

lefthook runs tools/license_check.py, a copy of the plugin's
plugins/dev-core/tools/license_check.py. The two were once edited apart, so a
re-copy from the plugin silently dropped the copy's own behaviour.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / 'tools' / 'validate_plugins.py'


def _load_tool():
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _gate(tmp_path: Path, source: str, copy: str | None) -> list[str]:
    src = tmp_path / 'source.py'
    src.write_text(source, encoding='utf-8')
    dst = tmp_path / 'copy.py'
    if copy is not None:
        dst.write_text(copy, encoding='utf-8')
    return _load_tool().check_license_checker_copy(src, dst)


def test_identical_copy_passes(tmp_path):
    assert _gate(tmp_path, 'print(1)\n', 'print(1)\n') == []


def test_a_one_byte_difference_fails_and_names_the_copy(tmp_path):
    errors = _gate(tmp_path, 'print(1)\n', 'print(1) \n')
    assert len(errors) == 1
    assert str(tmp_path / 'copy.py') in errors[0]


def test_a_missing_copy_fails(tmp_path):
    errors = _gate(tmp_path, 'print(1)\n', None)
    assert len(errors) == 1
    assert 'not found' in errors[0]


def test_the_repo_copy_matches_its_source_in_the_full_run():
    result = subprocess.run([sys.executable, str(TOOL)], capture_output=True, text=True)
    assert 'PASS: License checker copy' in result.stdout
