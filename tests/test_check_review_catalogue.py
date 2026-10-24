"""Tests for the review-catalogue check in tools/validate_plugins.py."""

import importlib.util
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / 'tools' / 'validate_plugins.py'


def run_tool(*extra_args):
    """Run validate_plugins.py as a subprocess and return (returncode, stdout, stderr)."""
    result = subprocess.run(
        [sys.executable, str(TOOL), *extra_args],
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout, result.stderr


def _load_tool():
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run_check(yaml_file: Path):
    """Invoke check_review_catalogue() directly with an injected catalogue path."""
    return _load_tool().check_review_catalogue(yaml_path=yaml_file)


def test_current_review_catalogue_is_valid():
    """The shipped canonical catalogue must be readable and non-empty."""
    rc, stdout, stderr = run_tool('--check', 'review-catalogue')
    assert rc == 0, (
        f'validate_plugins.py --check review-catalogue rejects the shipped catalogue.\n'
        f'stderr:\n{stderr}\nstdout:\n{stdout}'
    )


def test_yaml_file_missing(tmp_path):
    """A missing canonical catalogue is an IO error."""
    errors = _run_check(tmp_path / 'nonexistent.yml')
    assert errors
    assert _load_tool()._is_io_error(errors[0])
    assert 'review-classes.yml not found' in '\n'.join(errors).lower()


def test_yaml_not_utf8(tmp_path):
    """A non-UTF-8 canonical catalogue is an IO error."""
    yaml_file = tmp_path / 'review-classes.yml'
    yaml_file.write_bytes(b'classes:\n  - class: \xff\n')
    errors = _run_check(yaml_file)
    assert errors
    assert _load_tool()._is_io_error(errors[0])
    assert 'not valid utf-8' in '\n'.join(errors).lower()


def test_empty_classes_list(tmp_path):
    """A parsed catalogue without classes is a schema error."""
    yaml_file = tmp_path / 'review-classes.yml'
    yaml_file.write_text('version: "1.0.0"\nclasses: []\n', encoding='utf-8')
    errors = _run_check(yaml_file)
    assert errors
    assert 'no class entries' in '\n'.join(errors).lower()
    assert _load_tool()._is_io_error(errors[0])


def test_yaml_parse_error(tmp_path):
    """Malformed canonical YAML is a parse error."""
    yaml_file = tmp_path / 'review-classes.yml'
    yaml_file.write_text('classes:\n  - class: sample-check\nbroken: [unclosed\n', encoding='utf-8')
    errors = _run_check(yaml_file)
    assert errors
    assert 'failed to parse' in '\n'.join(errors).lower()
    assert _load_tool()._is_io_error(errors[0])


def test_subsumption_pair_mentioned_together_in_note_is_valid(tmp_path):
    """A declared pair is valid when both members appear in its catalogue note."""
    yaml_file = tmp_path / 'review-classes.yml'
    yaml_file.write_text(
        'classes:\n'
        '  - class: source-class\n'
        '    note: "Subsumption: source-class subsumes target-class."\n'
        '  - class: target-class\n',
        encoding='utf-8',
    )

    assert _run_check(yaml_file) == []


def test_subsumption_pair_missing_its_source_member_is_rejected(tmp_path):
    """A declared pair cannot omit the source member from its catalogue note."""
    yaml_file = tmp_path / 'review-classes.yml'
    yaml_file.write_text(
        'classes:\n'
        '  - class: source-class\n'
        '    note: "Subsumption: target-class."\n'
        '  - class: target-class\n',
        encoding='utf-8',
    )

    errors = _run_check(yaml_file)
    assert errors
    assert 'subsumption pair (source-class, target-class)' in '\n'.join(errors)
