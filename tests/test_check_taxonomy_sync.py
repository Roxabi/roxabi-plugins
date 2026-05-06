"""Tests for tools/check_taxonomy_sync.py."""

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / 'tools' / 'check_taxonomy_sync.py'
YAML_PATH = REPO_ROOT / 'plugins' / 'dev-core' / 'skills' / 'code-review' / 'review-classes.yml'
SKILL_PATH = REPO_ROOT / 'plugins' / 'dev-core' / 'skills' / 'code-review' / 'SKILL.md'


def run_tool(*extra_args, env_overrides=None):
    """Run check_taxonomy_sync.py as a subprocess and return (returncode, stdout, stderr)."""
    import os
    env = os.environ.copy()
    if env_overrides:
        env.update(env_overrides)
    result = subprocess.run(
        [sys.executable, str(TOOL), *extra_args],
        capture_output=True,
        text=True,
        env=env,
    )
    return result.returncode, result.stdout, result.stderr


# ---------------------------------------------------------------------------
# Happy path — current repo state must be in sync
# ---------------------------------------------------------------------------

def test_current_repo_in_sync():
    """Running the tool against the actual repo files must exit 0 (no drift)."""
    rc, stdout, stderr = run_tool()
    assert rc == 0, (
        f'check_taxonomy_sync.py reports drift on current HEAD.\n'
        f'stderr:\n{stderr}\nstdout:\n{stdout}'
    )
    assert stderr == '', f'Unexpected stderr on clean run:\n{stderr}'


# ---------------------------------------------------------------------------
# Synthetic mismatch fixtures
# ---------------------------------------------------------------------------

MINIMAL_YAML_TEMPLATE = """\
version: "1.0.0"
classes:
  - class: alpha
    origin: TEST
    description: Alpha class.
  - class: beta
    origin: TEST
    description: Beta class.
{extra}
"""

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

    extra_entries = ''.join(
        f'  - class: {c}\n    origin: TEST\n    description: {c} class.\n'
        for c in yaml_classes[2:]  # alpha+beta already in template
    )
    yaml_content = MINIMAL_YAML_TEMPLATE.format(extra=extra_entries)
    # Override with exact list
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


def _run_tool_on_pair(yaml_file: Path, skill_file: Path):
    """Invoke the tool module directly (not subprocess) by monkey-patching its paths."""
    import importlib.util
    import importlib

    # Load the module fresh each call to avoid cached state
    spec = importlib.util.spec_from_file_location('check_taxonomy_sync', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # Temporarily override the module-level path constants
    orig_yaml = mod.YAML_PATH
    orig_skill = mod.SKILL_PATH
    mod.YAML_PATH = yaml_file
    mod.SKILL_PATH = skill_file
    try:
        return mod.main()
    finally:
        mod.YAML_PATH = orig_yaml
        mod.SKILL_PATH = orig_skill


# ---------------------------------------------------------------------------
# Mismatch: SKILL.md missing a slug that is in YAML
# ---------------------------------------------------------------------------

def test_missing_slug_in_skill(tmp_path, capsys):
    """When SKILL.md omits a YAML slug, main() returns 1 and names the missing slug."""
    yaml_file, skill_file = _write_pair(
        tmp_path,
        yaml_classes=['alpha', 'beta', 'gamma'],
        skill_slugs=['alpha', 'beta'],  # gamma missing
    )
    rc = _run_tool_on_pair(yaml_file, skill_file)
    assert rc == 1
    captured = capsys.readouterr()
    assert 'gamma' in captured.err
    assert 'missing' in captured.err


# ---------------------------------------------------------------------------
# Mismatch: SKILL.md has a slug not in YAML
# ---------------------------------------------------------------------------

def test_extra_slug_in_skill(tmp_path, capsys):
    """When SKILL.md contains a slug absent from YAML, main() returns 1 and names it."""
    yaml_file, skill_file = _write_pair(
        tmp_path,
        yaml_classes=['alpha', 'beta'],
        skill_slugs=['alpha', 'beta', 'phantom'],  # phantom not in YAML
    )
    rc = _run_tool_on_pair(yaml_file, skill_file)
    assert rc == 1
    captured = capsys.readouterr()
    assert 'phantom' in captured.err
    assert 'extra' in captured.err


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
    rc = _run_tool_on_pair(yaml_file, skill_file)
    assert rc == 1
    captured = capsys.readouterr()
    assert 'beta' in captured.err
    assert 'gamma' in captured.err


# ---------------------------------------------------------------------------
# Error: anchor not found in SKILL.md
# ---------------------------------------------------------------------------

def test_anchor_not_found(tmp_path, capsys):
    """When the canonical class list anchor is absent, main() returns 2."""
    yaml_file = tmp_path / 'review-classes.yml'
    skill_file = tmp_path / 'SKILL.md'

    yaml_file.write_text(
        'version: "1.0.0"\nclasses:\n  - class: alpha\n    origin: TEST\n    description: x.\n',
        encoding='utf-8',
    )
    skill_file.write_text('# No spawn template here at all.\n', encoding='utf-8')

    rc = _run_tool_on_pair(yaml_file, skill_file)
    assert rc == 2
    captured = capsys.readouterr()
    assert 'not found' in captured.err.lower() or 'canonical' in captured.err.lower()


# ---------------------------------------------------------------------------
# Error: YAML file missing
# ---------------------------------------------------------------------------

def test_yaml_file_missing(tmp_path, capsys):
    """When review-classes.yml is absent, main() returns 2."""
    yaml_file = tmp_path / 'nonexistent.yml'
    skill_file = tmp_path / 'SKILL.md'
    skill_file.write_text('placeholder\n', encoding='utf-8')

    rc = _run_tool_on_pair(yaml_file, skill_file)
    assert rc == 2
    captured = capsys.readouterr()
    assert 'not found' in captured.err.lower() or 'error' in captured.err.lower()
