"""Tests for the golden-inventories check in tools/validate_plugins.py (issue #311).

check_golden_inventories parses <!-- INV-… --> anchors + their tagged item
text from each golden *.compressed.md and set-compares (anchor, normalized
text key) pairs against the sibling .inventory.json — both directions,
Decision-6 normalization, no LLM in CI.
"""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / 'tools' / 'validate_plugins.py'

VALID_COMPRESSED = """\
---
name: sample
---
<!-- compress: level=L2 src-sha=3f786850e387550fdab836ed7e6dc881de23001b glossary=none -->

# Sample

<!-- INV-rule-1 -->
- Always retry three times
<!-- INV-thresh-2 -->
- Timeout is 30 seconds
"""

VALID_INVENTORY = [
    {'anchor': 'INV-rule-1', 'text': 'Always retry three times'},
    {'anchor': 'INV-thresh-2', 'text': 'Timeout is 30 seconds'},
]


def _load_tool():
    """Import tools/validate_plugins.py as a module."""
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write_triple(golden_dir: Path, name='01-sample', compressed=VALID_COMPRESSED,
                  inventory=VALID_INVENTORY):
    """Write a golden triple (compressed + inventory) into golden_dir."""
    golden_dir.mkdir(parents=True, exist_ok=True)
    (golden_dir / f'{name}.compressed.md').write_text(compressed, encoding='utf-8')
    if inventory is not None:
        (golden_dir / f'{name}.inventory.json').write_text(
            json.dumps(inventory), encoding='utf-8'
        )
    return golden_dir


# ---------------------------------------------------------------------------
# Valid triple — no errors
# ---------------------------------------------------------------------------

def test_valid_triple_passes(tmp_path):
    """A triple whose anchors match its expected inventory is clean."""
    golden_dir = _write_triple(tmp_path / 'golden')
    mod = _load_tool()
    assert mod.check_golden_inventories(golden_dir=golden_dir) == []


def test_normalization_tolerates_case_and_punctuation(tmp_path):
    """Equivalence is on normalized text keys, never bytes."""
    inventory = [
        {'anchor': 'INV-rule-1', 'text': 'always retry THREE times!'},
        {'anchor': 'INV-thresh-2', 'text': '  Timeout is 30 seconds.  '},
    ]
    golden_dir = _write_triple(tmp_path / 'golden', inventory=inventory)
    mod = _load_tool()
    assert mod.check_golden_inventories(golden_dir=golden_dir) == []


# ---------------------------------------------------------------------------
# Broken triple — error names the triple and the anchor
# ---------------------------------------------------------------------------

def test_broken_triple_names_triple_and_anchor(tmp_path):
    """An inventory item whose anchor is absent from the compressed file fails."""
    inventory = VALID_INVENTORY + [
        {'anchor': 'INV-edge-3', 'text': 'An item the compressed file lost'}
    ]
    golden_dir = _write_triple(tmp_path / 'golden', inventory=inventory)
    mod = _load_tool()
    errors = mod.check_golden_inventories(golden_dir=golden_dir)
    assert len(errors) == 1
    assert '01-sample' in errors[0]
    assert 'INV-edge-3' in errors[0]


def test_changed_text_fails_both_directions(tmp_path):
    """Same anchor, different normalized text → flagged in both directions."""
    inventory = [
        {'anchor': 'INV-rule-1', 'text': 'Never retry at all'},
        {'anchor': 'INV-thresh-2', 'text': 'Timeout is 30 seconds'},
    ]
    golden_dir = _write_triple(tmp_path / 'golden', inventory=inventory)
    mod = _load_tool()
    errors = mod.check_golden_inventories(golden_dir=golden_dir)
    assert errors, 'drifted text key must fail the check'
    assert any('INV-rule-1' in e for e in errors)


# ---------------------------------------------------------------------------
# Activation semantic — absent dir is inert, existing-but-empty dir is loud
# ---------------------------------------------------------------------------

def test_absent_golden_dir_returns_empty(tmp_path):
    """No golden dir yet → check is inert (activates when the dir lands)."""
    mod = _load_tool()
    assert mod.check_golden_inventories(golden_dir=tmp_path / 'nope') == []


def test_empty_golden_dir_errors_loudly(tmp_path):
    """An existing golden dir with zero triples is an error, never a silent pass."""
    golden_dir = tmp_path / 'golden'
    golden_dir.mkdir()
    mod = _load_tool()
    errors = mod.check_golden_inventories(golden_dir=golden_dir)
    assert len(errors) == 1
    assert 'no golden triples' in errors[0]


# ---------------------------------------------------------------------------
# IO tiers — missing sibling, malformed JSON
# ---------------------------------------------------------------------------

def test_missing_sibling_inventory_not_found_tier(tmp_path):
    """A compressed file without its .inventory.json → 'not found at' error."""
    golden_dir = _write_triple(tmp_path / 'golden', inventory=None)
    mod = _load_tool()
    errors = mod.check_golden_inventories(golden_dir=golden_dir)
    assert len(errors) == 1
    assert 'not found at' in errors[0]


def test_malformed_inventory_json_parse_tier(tmp_path):
    """Unparseable expected inventory → clean parse-tier error, no traceback."""
    golden_dir = _write_triple(tmp_path / 'golden')
    (golden_dir / '01-sample.inventory.json').write_text('not json {', encoding='utf-8')
    mod = _load_tool()
    errors = mod.check_golden_inventories(golden_dir=golden_dir)
    assert len(errors) == 1
    assert 'failed to parse' in errors[0]


# ---------------------------------------------------------------------------
# Shape guard — valid JSON but not list-of-{anchor, text} (F5); one malformed
# triple must FAIL only itself, never abort the rest of the run
# ---------------------------------------------------------------------------

def test_wrong_shape_inventory_fails_cleanly_not_traceback(tmp_path):
    """A valid-JSON but wrong-shape inventory FAILs cleanly, never raises."""
    golden_dir = _write_triple(tmp_path / 'golden', inventory=None)
    (golden_dir / '01-sample.inventory.json').write_text(
        json.dumps({'not': 'a list'}), encoding='utf-8'
    )
    mod = _load_tool()
    errors = mod.check_golden_inventories(golden_dir=golden_dir)
    assert len(errors) == 1
    assert 'not valid inventory shape' in errors[0]


def test_one_malformed_triple_does_not_abort_the_rest(tmp_path):
    """One triple with malformed inventory shape must not crash/skip sibling triples."""
    golden_dir = tmp_path / 'golden'
    _write_triple(golden_dir, name='01-bad', inventory=[{'anchor': 'INV-rule-1'}])  # no text
    _write_triple(golden_dir, name='02-good')
    mod = _load_tool()
    errors = mod.check_golden_inventories(golden_dir=golden_dir)
    assert any('01-bad' in e and 'not valid inventory shape' in e for e in errors)
    assert not any('02-good' in e for e in errors)


def test_compressed_anchor_grammar_violation_fails_only_that_triple(tmp_path):
    """A compressed file violating the anchor grammar (F6) FAILs only that triple —
    the wrapped per-triple body must not let the raised ValueError abort the run."""
    golden_dir = tmp_path / 'golden'
    broken_compressed = """\
---
name: broken
---
<!-- compress: level=L2 src-sha=deadbeef glossary=none -->

# Broken

<!-- INV-rule-1 -->
<!-- INV-rule-2 -->
- only text after the second anchor
"""
    _write_triple(
        golden_dir, name='01-broken', compressed=broken_compressed,
        inventory=[
            {'anchor': 'INV-rule-1', 'text': 'x'},
            {'anchor': 'INV-rule-2', 'text': 'only text after the second anchor'},
        ],
    )
    _write_triple(golden_dir, name='02-good')
    mod = _load_tool()
    errors = mod.check_golden_inventories(golden_dir=golden_dir)
    assert any('01-broken' in e for e in errors)
    assert not any('02-good' in e for e in errors)


# ---------------------------------------------------------------------------
# Anchor lookahead — adjacent anchors each get their own item text (F6)
# ---------------------------------------------------------------------------

def test_parse_compressed_anchors_raises_on_anchor_with_no_item_text():
    """An anchor immediately followed by another anchor line (no item text) raises,
    rather than silently stealing the next anchor's raw comment as its own text."""
    mod = _load_tool()
    text = '<!-- INV-rule-1 -->\n<!-- INV-rule-2 -->\n- text for rule 2\n'
    with pytest.raises(ValueError):
        mod._parse_compressed_anchors(text)


def test_parse_compressed_anchors_lookahead_skips_anchor_lines():
    """Two anchors each immediately followed by their own item text both parse
    independently — the lookahead must not consume an adjacent anchor's comment."""
    mod = _load_tool()
    text = '<!-- INV-rule-1 -->\n- rule one text\n<!-- INV-rule-2 -->\n- rule two text\n'
    pairs = mod._parse_compressed_anchors(text)
    assert ('INV-rule-1', mod._normalize_inventory_text('rule one text')) in pairs
    assert ('INV-rule-2', mod._normalize_inventory_text('rule two text')) in pairs


def test_adjacent_anchors_each_get_their_own_text_via_golden_check(tmp_path):
    """End-to-end: two anchors each with their own following text pass the check
    cleanly — the adjacency fix does not disturb the well-formed case."""
    compressed = """\
---
name: adjacent-ok
---
<!-- compress: level=L2 src-sha=deadbeef glossary=none -->

# Adjacent OK

<!-- INV-rule-1 -->
- first anchor's item text
<!-- INV-rule-2 -->
- second anchor's item text
"""
    inventory = [
        {'anchor': 'INV-rule-1', 'text': "first anchor's item text"},
        {'anchor': 'INV-rule-2', 'text': "second anchor's item text"},
    ]
    golden_dir = _write_triple(
        tmp_path / 'golden', name='01-adjacent-ok', compressed=compressed, inventory=inventory
    )
    mod = _load_tool()
    assert mod.check_golden_inventories(golden_dir=golden_dir) == []


# ---------------------------------------------------------------------------
# Shipped tree — non-vacuous: the real golden dir must exist and be clean
# ---------------------------------------------------------------------------

def test_shipped_tree_golden_dir_exists_and_passes():
    """The shipped golden dir exists, holds ≥1 triple, and the check is clean.

    Non-vacuous by construction: the dir-absent → [] activation semantic
    cannot satisfy this test — it asserts the dir and at least one triple.
    """
    mod = _load_tool()
    golden_dir = Path(mod.GOLDEN_DIR)
    assert golden_dir.is_dir(), f'shipped golden dir missing: {golden_dir}'
    triples = sorted(golden_dir.glob('*.compressed.md'))
    assert len(triples) >= 1, 'shipped golden dir holds no triples'
    assert mod.check_golden_inventories() == []


def test_tool_registers_golden_inventories_check():
    """Default validate_plugins.py run includes the Golden inventories check."""
    result = subprocess.run(
        [sys.executable, str(TOOL)], capture_output=True, text=True
    )
    assert 'Golden inventories' in result.stdout
