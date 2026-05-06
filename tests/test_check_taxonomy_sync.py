"""Tests for the class-list-sync check in tools/validate_plugins.py."""

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / 'tools' / 'validate_plugins.py'
YAML_PATH = REPO_ROOT / 'plugins' / 'dev-core' / 'skills' / 'code-review' / 'review-classes.yml'
SKILL_PATH = REPO_ROOT / 'plugins' / 'dev-core' / 'skills' / 'code-review' / 'SKILL.md'


def run_tool(*extra_args):
    """Run validate_plugins.py as a subprocess and return (returncode, stdout, stderr)."""
    result = subprocess.run(
        [sys.executable, str(TOOL), *extra_args],
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout, result.stderr


MINIMAL_SKILL_TEMPLATE = """\
# SKILL.md stub

### Spawn template

```
Canonical classes (use slug only): {slugs}. Free-text labels not in this list are invalid.
```
"""


def _write_pair(tmp_path: Path, yaml_classes: list[str], skill_slugs: list[str]):
    """Write a synthetic YAML + SKILL.md pair under tmp_path and return their paths."""
    yaml_file = tmp_path / 'review-classes.yml'
    skill_file = tmp_path / 'SKILL.md'

    lines = ['version: "1.0.0"\n', 'classes:\n']
    for cls in yaml_classes:
        lines.append(f'  - class: {cls}\n')
        lines.append(f'    origin: TEST\n')
        lines.append(f'    description: {cls} class.\n')
    yaml_file.write_text(''.join(lines), encoding='utf-8')

    skill_file.write_text(
        MINIMAL_SKILL_TEMPLATE.format(slugs=', '.join(skill_slugs)),
        encoding='utf-8',
    )
    return yaml_file, skill_file


def _run_check(yaml_file: Path, skill_file: Path):
    """Invoke check_class_list_sync() directly with injected paths."""
    import importlib.util

    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    return mod.check_class_list_sync(yaml_path=yaml_file, skill_path=skill_file)


# ---------------------------------------------------------------------------
# Happy path — current repo state must be in sync
# ---------------------------------------------------------------------------

def test_current_repo_in_sync():
    """Running the tool with --check class-list-sync against the actual repo must exit 0."""
    rc, stdout, stderr = run_tool('--check', 'class-list-sync')
    assert rc == 0, (
        f'validate_plugins.py --check class-list-sync reports drift on current HEAD.\n'
        f'stderr:\n{stderr}\nstdout:\n{stdout}'
    )


# ---------------------------------------------------------------------------
# Mismatch: SKILL.md missing a slug that is in YAML
# ---------------------------------------------------------------------------

def test_missing_slug_in_skill(tmp_path, capsys):
    """When SKILL.md omits a YAML slug, check returns errors naming the missing slug."""
    yaml_file, skill_file = _write_pair(
        tmp_path,
        yaml_classes=['alpha', 'beta', 'gamma'],
        skill_slugs=['alpha', 'beta'],  # gamma missing
    )
    errors = _run_check(yaml_file, skill_file)
    assert errors
    combined = '\n'.join(errors)
    assert 'gamma' in combined
    assert 'missing' in combined


# ---------------------------------------------------------------------------
# Mismatch: SKILL.md has a slug not in YAML
# ---------------------------------------------------------------------------

def test_extra_slug_in_skill(tmp_path, capsys):
    """When SKILL.md contains a slug absent from YAML, check returns errors naming it."""
    yaml_file, skill_file = _write_pair(
        tmp_path,
        yaml_classes=['alpha', 'beta'],
        skill_slugs=['alpha', 'beta', 'phantom'],  # phantom not in YAML
    )
    errors = _run_check(yaml_file, skill_file)
    assert errors
    combined = '\n'.join(errors)
    assert 'phantom' in combined
    assert 'extra' in combined


# ---------------------------------------------------------------------------
# Mismatch: both missing and extra
# ---------------------------------------------------------------------------

def test_both_missing_and_extra(tmp_path, capsys):
    """When both missing and extra slugs exist, both are reported."""
    yaml_file, skill_file = _write_pair(
        tmp_path,
        yaml_classes=['alpha', 'beta'],
        skill_slugs=['alpha', 'gamma'],  # beta missing, gamma extra
    )
    errors = _run_check(yaml_file, skill_file)
    assert errors
    combined = '\n'.join(errors)
    assert 'beta' in combined
    assert 'gamma' in combined
    assert 'missing' in combined
    assert 'extra' in combined


# ---------------------------------------------------------------------------
# Error: anchor not found in SKILL.md — exit 1 (drift, not IO error)
# ---------------------------------------------------------------------------

def test_anchor_not_found(tmp_path, capsys):
    """When the canonical class list anchor is absent, check returns an error (drift → rc=1)."""
    yaml_file = tmp_path / 'review-classes.yml'
    skill_file = tmp_path / 'SKILL.md'

    yaml_file.write_text(
        'version: "1.0.0"\nclasses:\n  - class: alpha\n    origin: TEST\n    description: x.\n',
        encoding='utf-8',
    )
    skill_file.write_text('# No spawn template here at all.\n', encoding='utf-8')

    errors = _run_check(yaml_file, skill_file)
    assert errors
    combined = '\n'.join(errors).lower()
    assert 'canonical class list not found' in combined

    # Via subprocess: anchor-not-found is drift → exit 1 (not exit 2)
    import importlib.util
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert not mod._is_io_error(errors[0]), 'anchor-not-found must be exit 1 (drift), not exit 2'


# ---------------------------------------------------------------------------
# Error: YAML file missing — exit 2 (IO error)
# ---------------------------------------------------------------------------

def test_yaml_file_missing(tmp_path, capsys):
    """When review-classes.yml is absent, check returns an IO error message."""
    yaml_file = tmp_path / 'nonexistent.yml'
    skill_file = tmp_path / 'SKILL.md'
    skill_file.write_text('placeholder\n', encoding='utf-8')

    errors = _run_check(yaml_file, skill_file)
    assert errors
    combined = '\n'.join(errors).lower()
    assert 'review-classes.yml not found' in combined


# ---------------------------------------------------------------------------
# Error: empty classes list — exit 2 (schema error)
# ---------------------------------------------------------------------------

def test_empty_classes_list(tmp_path, capsys):
    """When review-classes.yml parses but classes: is empty, check returns an IO/schema error."""
    yaml_file = tmp_path / 'review-classes.yml'
    skill_file = tmp_path / 'SKILL.md'

    yaml_file.write_text('version: "1.0.0"\nclasses: []\n', encoding='utf-8')
    skill_file.write_text(
        MINIMAL_SKILL_TEMPLATE.format(slugs='alpha'),
        encoding='utf-8',
    )

    errors = _run_check(yaml_file, skill_file)
    assert errors
    combined = '\n'.join(errors).lower()
    assert 'no class entries' in combined

    import importlib.util
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod._is_io_error(errors[0]), 'empty classes must be exit 2 (IO/schema error)'


# ---------------------------------------------------------------------------
# Error: YAML parse error — exit 2
# ---------------------------------------------------------------------------

def test_yaml_parse_error(tmp_path, capsys):
    """When review-classes.yml has invalid YAML, check returns a parse error (exit 2)."""
    yaml_file = tmp_path / 'review-classes.yml'
    skill_file = tmp_path / 'SKILL.md'

    yaml_file.write_text('classes: [unclosed\n', encoding='utf-8')
    skill_file.write_text(
        MINIMAL_SKILL_TEMPLATE.format(slugs='alpha'),
        encoding='utf-8',
    )

    errors = _run_check(yaml_file, skill_file)
    assert errors
    combined = '\n'.join(errors).lower()
    assert 'failed to parse' in combined

    import importlib.util
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod._is_io_error(errors[0]), 'yaml parse error must be exit 2'
