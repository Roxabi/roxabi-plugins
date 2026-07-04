"""Tests for the notation-legends check in tools/validate_plugins.py.

Two gates (issue #310, spec Decision 9):
- Pointer gate: each gated dev-core legend file carries exactly one line
  containing `notation.md` (the one-line pointer to the canonical glossary).
- Set-equality gate: backtick spans of SKILL.md's `Whitelist:` line must be
  set-equal to the column-1 backtick spans of notation.md's `## Core Table`
  active rows (separator rows skipped, `\\|` unescaped, both sets non-empty).
"""

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


def _write_legend(tmp_path: Path, name: str = 'base.md', line: str | None = None) -> Path:
    """Write a gated legend file; default body carries a compliant one-line pointer."""
    if line is None:
        line = (
            'Notation legend → canonical glossary: '
            '`${CLAUDE_PLUGIN_ROOT}/../shared/references/notation.md` '
            '(repo: `plugins/shared/references/notation.md`)'
        )
    path = tmp_path / name
    path.write_text(f'# Stub agent\n\n## Notation\n\n{line}\n', encoding='utf-8')
    return path


def _write_skill(tmp_path: Path, spans: list[str] | None) -> Path:
    """Write a synthetic SKILL.md; spans=None omits the Whitelist: line entirely."""
    body = '# Stub skill\n\n## Guardrails\n\n'
    if spans is not None:
        body += 'Whitelist: ' + ' '.join(f'`{s}`' for s in spans) + '\n'
    path = tmp_path / 'SKILL.md'
    path.write_text(body, encoding='utf-8')
    return path


def _write_glossary(tmp_path: Path, cells: list[str]) -> Path:
    """Write a synthetic notation.md whose core-table column-1 cells are `cells`.

    Each cell is raw markdown for column 1 (e.g. '`∀`' or '`∃`/`∄`' or '`\\|X\\|`').
    A trailing section with a stray backtick span guards the next-## boundary.
    """
    lines = [
        '# Notation',
        '',
        '## Core Table',
        '',
        '| glyph | senses | gloss? | fidelity ⚠ | notes/adjudication |',
        '|-------|--------|--------|------------|---------------------|',
    ]
    for cell in cells:
        lines.append(f'| {cell} | sense | — | — | prefer `∀` over `⇔` |')
    lines += ['', '## Maintenance Policy', '', 'deprecated: `zzz` — must not leak into the set', '']
    path = tmp_path / 'notation.md'
    path.write_text('\n'.join(lines), encoding='utf-8')
    return path


def _run_check(mod, tmp_path: Path, *, legend=None, skill=None, glossary=None):
    """Invoke check_notation_legends with defaults valid so one gate is under test."""
    if legend is None:
        legend = _write_legend(tmp_path)
    if skill is None:
        skill = _write_skill(tmp_path, ['∀', '¬'])
    if glossary is None:
        glossary = _write_glossary(tmp_path, ['`∀`', '`¬`'])
    return mod.check_notation_legends(
        legend_files=[legend], skill_path=skill, glossary_path=glossary
    )


# ---------------------------------------------------------------------------
# Pointer gate — compliant pointer passes
# ---------------------------------------------------------------------------

def test_pointer_line_passes(tmp_path):
    """A gated file with exactly one line containing notation.md yields no errors."""
    mod = _load_tool()
    assert _run_check(mod, tmp_path) == []


# ---------------------------------------------------------------------------
# Pointer gate — full legend (no notation.md) fails
# ---------------------------------------------------------------------------

def test_full_legend_fails_pointer_gate(tmp_path):
    """A gated file whose legend is spelled out inline (no pointer) is drift."""
    mod = _load_tool()
    legend = _write_legend(
        tmp_path, line='`¬` not | `→` then | `∀` for all | `Σ` state dict'
    )
    errors = _run_check(mod, tmp_path, legend=legend)
    assert len(errors) == 1
    assert 'notation.md' in errors[0]
    assert str(legend) in errors[0] or legend.name in errors[0]


# ---------------------------------------------------------------------------
# Pointer gate — missing gated file → IO error tier ('not found at')
# ---------------------------------------------------------------------------

def test_missing_legend_file(tmp_path):
    """A missing gated file reports 'not found at' (exit-2 tier via _is_io_error)."""
    mod = _load_tool()
    errors = _run_check(mod, tmp_path, legend=tmp_path / 'absent.md')
    assert errors
    assert any('not found at' in e for e in errors)
    assert all(mod._is_io_error(e) for e in errors if 'not found at' in e)


def test_missing_glossary_file(tmp_path):
    """A missing notation.md reports 'not found at' (exit-2 tier)."""
    mod = _load_tool()
    errors = _run_check(mod, tmp_path, glossary=tmp_path / 'nowhere' / 'notation.md')
    assert any('not found at' in e for e in errors)


# ---------------------------------------------------------------------------
# Set equality — whitelist ≡ core table passes (multi-glyph cells, escaped pipes,
# column-1-only extraction)
# ---------------------------------------------------------------------------

def test_set_equality_passes(tmp_path):
    """Whitelist spans ≡ core-table column-1 spans → no errors.

    Locks three parse contracts at once: multi-glyph cells (`∃`/`∄`) contribute
    each span; `\\|X\\|` in a table cell unescapes to whitelist's `|X|`; backtick
    spans outside column 1 (the notes cell carries `⇔`) never enter the set.
    """
    mod = _load_tool()
    skill = _write_skill(tmp_path, ['∀', '∃', '∄', '|X|', ':='])
    glossary = _write_glossary(tmp_path, ['`∀`', '`∃`/`∄`', '`\\|X\\|`', '`:=`'])
    assert _run_check(mod, tmp_path, skill=skill, glossary=glossary) == []


# ---------------------------------------------------------------------------
# Set equality — whitelist ⊃ core table fails, diff named
# ---------------------------------------------------------------------------

def test_whitelist_superset_fails(tmp_path):
    """A whitelist glyph absent from the core table is named in the error."""
    mod = _load_tool()
    skill = _write_skill(tmp_path, ['∀', '¬', '⇒'])
    glossary = _write_glossary(tmp_path, ['`∀`', '`¬`'])
    errors = _run_check(mod, tmp_path, skill=skill, glossary=glossary)
    assert errors
    assert any('⇒' in e for e in errors)


# ---------------------------------------------------------------------------
# Set equality — core table ⊃ whitelist fails, diff named
# ---------------------------------------------------------------------------

def test_core_table_superset_fails(tmp_path):
    """A core-table glyph absent from the whitelist is named in the error."""
    mod = _load_tool()
    skill = _write_skill(tmp_path, ['∀', '¬'])
    glossary = _write_glossary(tmp_path, ['`∀`', '`¬`', '`↦`'])
    errors = _run_check(mod, tmp_path, skill=skill, glossary=glossary)
    assert errors
    assert any('↦' in e for e in errors)


def test_two_way_drift_names_both_directions(tmp_path):
    """Drift in both directions reports both the missing and the extra glyph."""
    mod = _load_tool()
    skill = _write_skill(tmp_path, ['∀', '⇒'])
    glossary = _write_glossary(tmp_path, ['`∀`', '`↦`'])
    errors = _run_check(mod, tmp_path, skill=skill, glossary=glossary)
    joined = '\n'.join(errors)
    assert '⇒' in joined
    assert '↦' in joined


# ---------------------------------------------------------------------------
# Non-empty guard — empty parsed sets fail loudly (never vacuously pass)
# ---------------------------------------------------------------------------

def test_missing_whitelist_line_fails_loud(tmp_path):
    """A SKILL.md without a Whitelist: line fails — even against an empty table."""
    mod = _load_tool()
    skill = _write_skill(tmp_path, None)
    glossary = _write_glossary(tmp_path, [])
    errors = _run_check(mod, tmp_path, skill=skill, glossary=glossary)
    assert errors


def test_empty_core_table_fails_loud(tmp_path):
    """A core table with no active rows fails, even if the anchor heading exists."""
    mod = _load_tool()
    glossary = _write_glossary(tmp_path, [])
    errors = _run_check(mod, tmp_path, glossary=glossary)
    assert errors


def test_missing_core_table_anchor_is_drift(tmp_path):
    """notation.md without a '## Core Table' heading fails as drift, not IO error."""
    mod = _load_tool()
    glossary = tmp_path / 'notation.md'
    glossary.write_text('# Notation\n\n## Some Other Section\n', encoding='utf-8')
    errors = _run_check(mod, tmp_path, glossary=glossary)
    assert errors
    assert not any(mod._is_io_error(e) for e in errors)


# ---------------------------------------------------------------------------
# Separator rows — never contribute to the parsed set
# ---------------------------------------------------------------------------

def test_separator_row_skipped(tmp_path):
    """Separator rows (---, :--- variants) parse clean and add nothing to the set."""
    mod = _load_tool()
    glossary = tmp_path / 'notation.md'
    glossary.write_text(
        '# Notation\n\n## Core Table\n\n'
        '| glyph | senses |\n'
        '|:------|:------:|\n'
        '| `∀` | sense |\n'
        '| `¬` | sense |\n\n'
        '## Next\n',
        encoding='utf-8',
    )
    assert _run_check(mod, tmp_path, glossary=glossary) == []


# ---------------------------------------------------------------------------
# Shipped tree — defaults pass, CLI choice wired, full run reports the check
# ---------------------------------------------------------------------------

def test_shipped_tree_passes():
    """Default paths against the real repo tree report no errors."""
    mod = _load_tool()
    assert mod.check_notation_legends() == []


def test_check_cli_shipped_tree():
    """--check notation-legends against the shipped tree exits 0."""
    rc, stdout, stderr = run_tool('--check', 'notation-legends')
    assert rc == 0, (
        f'--check notation-legends failed on shipped tree.\n'
        f'stdout:\n{stdout}\nstderr:\n{stderr}'
    )


def test_full_run_reports_notation_legends():
    """The default all-checks run includes and passes the notation-legends check."""
    rc, stdout, stderr = run_tool()
    assert rc == 0, (
        f'validate_plugins.py failed on shipped tree.\nstdout:\n{stdout}\nstderr:\n{stderr}'
    )
    assert 'PASS: Notation legends' in stdout
