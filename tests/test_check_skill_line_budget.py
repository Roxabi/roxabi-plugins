"""Tests for the SKILL.md line-budget check in tools/validate_plugins.py."""

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
    """Import tools/validate_plugins.py as a module."""
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write_skill(tmp_path: Path, plugin: str, lines: int) -> Path:
    """Write a synthetic plugins-tree SKILL.md with exactly `lines` physical lines."""
    skill_md = tmp_path / plugin / 'skills' / plugin / 'SKILL.md'
    skill_md.parent.mkdir(parents=True)
    skill_md.write_text(''.join(f'line {i}\n' for i in range(lines)), encoding='utf-8')
    return skill_md


# ---------------------------------------------------------------------------
# Over budget — one error naming plugin, actual, budget
# ---------------------------------------------------------------------------

def test_over_budget_reports_error(tmp_path):
    """A 120-line SKILL.md against a 110-line budget yields one error with the numbers."""
    _write_skill(tmp_path, 'pluginx', 120)
    mod = _load_tool()
    errors = mod.check_skill_line_budget(budgets={'pluginx': 110}, plugins_dir=tmp_path)
    assert len(errors) == 1
    assert 'pluginx' in errors[0]
    assert '120' in errors[0]
    assert '110' in errors[0]


# ---------------------------------------------------------------------------
# At budget — no error
# ---------------------------------------------------------------------------

def test_at_budget_passes(tmp_path):
    """A SKILL.md exactly at its budget is compliant."""
    _write_skill(tmp_path, 'pluginx', 110)
    mod = _load_tool()
    errors = mod.check_skill_line_budget(budgets={'pluginx': 110}, plugins_dir=tmp_path)
    assert errors == []


# ---------------------------------------------------------------------------
# Budgeted plugin without a SKILL.md — no crash, no error
# ---------------------------------------------------------------------------

def test_budgeted_plugin_without_skill_md(tmp_path):
    """A budget entry for a plugin with no SKILL.md is silently skipped."""
    mod = _load_tool()
    errors = mod.check_skill_line_budget(budgets={'ghost': 110}, plugins_dir=tmp_path)
    assert errors == []


# ---------------------------------------------------------------------------
# Default call — shipped tree must be within budget
# ---------------------------------------------------------------------------

def test_shipped_tree_within_budget():
    """Default budgets against the real repo tree report no errors."""
    mod = _load_tool()
    assert mod.check_skill_line_budget() == []


def test_budget_registry_pins_compress():
    """The shipped registry budgets compress at 110 lines."""
    mod = _load_tool()
    assert mod.SKILL_LINE_BUDGETS.get('compress') == 110


# ---------------------------------------------------------------------------
# Subprocess smoke — full tool run passes and includes the check
# ---------------------------------------------------------------------------

def test_tool_passes_on_shipped_tree():
    """Full validate_plugins.py run exits 0 and reports the line-budget check."""
    rc, stdout, stderr = run_tool()
    assert rc == 0, (
        f'validate_plugins.py failed on shipped tree.\nstdout:\n{stdout}\nstderr:\n{stderr}'
    )
    assert 'PASS: SKILL.md line budget' in stdout
