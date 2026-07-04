"""Tests for plugins/compress/scripts/inventory_diff.py (issue #311).

Covers the Decision-6 normalization charset, the Decision-7 diff contract
(missing/invented/changed + recall + min-N guard), verdict semantics
(faithful paraphrases do not block), and the --log verify-row envelope
(schema_version 2, category 'verify', O_APPEND).
"""

import importlib.util
import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / 'plugins' / 'compress' / 'scripts' / 'inventory_diff.py'

# Crockford base32 alphabet — no I, L, O, U
ULID_RE = re.compile(r'^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$')


@pytest.fixture(scope='module')
def inv_diff():
    """Load inventory_diff.py as a module via its file path."""
    spec = importlib.util.spec_from_file_location('inventory_diff', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_inventory(n, prefix='rule'):
    """n items with stable anchors INV-<prefix>-1..n."""
    return [
        {'anchor': f'INV-{prefix}-{i}', 'text': f'item number {i} does a thing'}
        for i in range(1, n + 1)
    ]


def write_inventories(tmp_path, writer, reader):
    """Write writer/reader inventories as JSON files, return their paths."""
    writer_path = tmp_path / 'writer.json'
    reader_path = tmp_path / 'reader.json'
    writer_path.write_text(json.dumps(writer), encoding='utf-8')
    reader_path.write_text(json.dumps(reader), encoding='utf-8')
    return writer_path, reader_path


# ---------------------------------------------------------------------------
# normalize — Decision-6 charset
# ---------------------------------------------------------------------------

def test_normalize_lowercases_and_collapses_whitespace(inv_diff):
    """Case folds and internal whitespace runs collapse to one space."""
    assert inv_diff.normalize('  Retry   THREE\ttimes  ') == 'retry three times'


def test_normalize_drops_punctuation_only_tokens(inv_diff):
    """Punctuation-only tokens vanish; punctuation inside tokens is stripped."""
    assert inv_diff.normalize('retry — max 3 times!') == 'retry max 3 times'


def test_normalize_preserves_whitelisted_glyphs(inv_diff):
    """Glyphs in the Decision-6 class (∀∃∄∈∉∧∨¬→⟺∅≥≤) survive normalization."""
    assert inv_diff.normalize('X ⟺ A ∧ B, threshold ≥ 5') == 'x ⟺ a ∧ b threshold ≥ 5'


# ---------------------------------------------------------------------------
# diff — missing / invented / changed / recall
# ---------------------------------------------------------------------------

def test_diff_equal_inventories_all_empty_recall_1(inv_diff):
    """Identical inventories → empty diff sets, recall 1.0, sample sufficient."""
    writer = make_inventory(8)
    result = inv_diff.diff(writer, list(writer))
    assert result['missing'] == []
    assert result['invented'] == []
    assert result['changed'] == []
    assert result['recall'] == 1.0
    assert result['insufficient_sample'] is False


def test_diff_missing_writer_only_anchor(inv_diff):
    """A writer anchor absent from the reader lands in missing."""
    writer = make_inventory(8)
    reader = [item for item in writer if item['anchor'] != 'INV-rule-3']
    result = inv_diff.diff(writer, reader)
    assert [m['anchor'] for m in result['missing']] == ['INV-rule-3']
    assert result['invented'] == []
    assert result['changed'] == []


def test_diff_invented_reader_only_anchor(inv_diff):
    """A reader anchor absent from the writer lands in invented."""
    writer = make_inventory(8)
    reader = list(writer) + [{'anchor': 'INV-edge-9', 'text': 'a hallucinated item'}]
    result = inv_diff.diff(writer, reader)
    assert result['missing'] == []
    assert [i['anchor'] for i in result['invented']] == ['INV-edge-9']


def test_diff_changed_when_normalized_keys_differ(inv_diff):
    """Shared anchor with different normalized text → changed, unclassified."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    reader[0]['text'] = 'item number 1 does the opposite thing'
    result = inv_diff.diff(writer, reader)
    assert len(result['changed']) == 1
    changed = result['changed'][0]
    assert changed['anchor'] == 'INV-rule-1'
    assert changed['writer_text'] == 'item number 1 does a thing'
    assert changed['reader_text'] == 'item number 1 does the opposite thing'
    # Semantic sub-classification is the writer's call — the script never guesses.
    assert changed['writer_classification'] is None


def test_diff_paraphrase_equal_after_normalization_not_changed(inv_diff):
    """Case/punctuation-only differences normalize away — not a change."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    reader[0]['text'] = '  Item number 1 — does a thing!  '
    result = inv_diff.diff(writer, reader)
    assert result['changed'] == []
    assert result['recall'] == 1.0


def test_diff_recall_counts_only_normalized_matches(inv_diff):
    """recall = |reader ∩ writer| / |writer| — changed and missing do not count."""
    writer = make_inventory(10)
    reader = [dict(item) for item in writer[:9]]  # INV-rule-10 missing
    reader[0]['text'] = 'entirely different wording'  # INV-rule-1 changed
    reader[1]['text'] = 'another rewritten item'  # INV-rule-2 changed
    result = inv_diff.diff(writer, reader)
    assert result['recall'] == pytest.approx(0.7)
    assert len(result['missing']) == 1
    assert len(result['changed']) == 2


# ---------------------------------------------------------------------------
# min-N guard — recall over < 8 writer items is noise
# ---------------------------------------------------------------------------

def test_min_n_guard_flags_small_sample(inv_diff):
    """Fewer than 8 writer items → insufficient_sample is True."""
    writer = make_inventory(7)
    result = inv_diff.diff(writer, list(writer))
    assert result['insufficient_sample'] is True


def test_min_n_guard_boundary_eight_items_sufficient(inv_diff):
    """Exactly 8 writer items clear the min-N guard."""
    writer = make_inventory(8)
    result = inv_diff.diff(writer, list(writer))
    assert result['insufficient_sample'] is False


# ---------------------------------------------------------------------------
# verdict — pass / fail / insufficient sample; faithful does not block
# ---------------------------------------------------------------------------

def test_verdict_pass_on_clean_result(inv_diff):
    """recall ≥ floor and empty diff sets → pass."""
    writer = make_inventory(8)
    result = inv_diff.diff(writer, list(writer))
    assert inv_diff.compute_verdict(result, floor=0.85) == 'pass'


def test_verdict_fail_on_missing(inv_diff):
    """A missing item blocks even when recall clears the floor."""
    writer = make_inventory(10)
    reader = [item for item in writer if item['anchor'] != 'INV-rule-5']
    result = inv_diff.diff(writer, reader)
    assert result['recall'] == pytest.approx(0.9)
    assert inv_diff.compute_verdict(result, floor=0.85) == 'fail'


def test_verdict_insufficient_sample_human_gated(inv_diff):
    """min-N guard verdict is distinct from pass/fail."""
    writer = make_inventory(3)
    result = inv_diff.diff(writer, list(writer))
    verdict = inv_diff.compute_verdict(result, floor=0.85)
    assert verdict == 'insufficient sample — human-gated'


def test_verdict_faithful_changed_does_not_block(inv_diff):
    """A changed item the writer classified faithful does not block the pass."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    reader[0]['text'] = 'the first item performs a thing'
    result = inv_diff.diff(writer, reader)
    result['changed'][0]['writer_classification'] = 'faithful'
    assert result['recall'] == pytest.approx(7 / 8)
    assert inv_diff.compute_verdict(result, floor=0.85) == 'pass'


def test_verdict_unclassified_changed_blocks_conservatively(inv_diff):
    """An unclassified changed item blocks — the script never guesses semantics."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    reader[0]['text'] = 'the first item performs a thing'
    result = inv_diff.diff(writer, reader)
    assert inv_diff.compute_verdict(result, floor=0.85) == 'fail'


# ---------------------------------------------------------------------------
# CLI — JSON report to stdout, exit codes
# ---------------------------------------------------------------------------

def test_cli_prints_json_report(inv_diff, tmp_path, capsys):
    """Default run prints the report as JSON and exits 0."""
    writer = make_inventory(8)
    writer_path, reader_path = write_inventories(tmp_path, writer, writer)
    rc = inv_diff.main([str(writer_path), str(reader_path)])
    assert rc == 0
    report = json.loads(capsys.readouterr().out)
    assert report['recall'] == 1.0
    assert report['verdict'] == 'pass'
    assert report['diff_mode'] == 'anchor-based'
    assert report['floor'] == 0.85
    assert 'anchor_tokens' in report
    assert 'legend_tokens' in report


def test_cli_missing_file_exits_2(inv_diff, tmp_path, capsys):
    """A missing inventory file is an IO error → exit 2."""
    writer_path, _ = write_inventories(tmp_path, make_inventory(8), [])
    rc = inv_diff.main([str(writer_path), str(tmp_path / 'absent.json')])
    assert rc == 2


def test_cli_malformed_json_exits_2(inv_diff, tmp_path, capsys):
    """Unparseable inventory JSON is an IO error → exit 2."""
    writer_path, reader_path = write_inventories(tmp_path, make_inventory(8), [])
    reader_path.write_text('not json {', encoding='utf-8')
    rc = inv_diff.main([str(writer_path), str(reader_path)])
    assert rc == 2


# ---------------------------------------------------------------------------
# --log — verify-row envelope appended to verify-log.jsonl
# ---------------------------------------------------------------------------

def _run_log(inv_diff, tmp_path, correlation):
    writer = make_inventory(8)
    writer_path, reader_path = write_inventories(tmp_path, writer, writer)
    return inv_diff.main([
        str(writer_path), str(reader_path),
        '--log',
        '--target', 'plugins/sample/skills/sample/SKILL.md',
        '--source-ref', '3f786850e387550fdab836ed7e6dc881de23001b',
        '--correlation', correlation,
        '--anchor-tokens', '12',
        '--legend-tokens', '0',
    ])


def test_log_appends_verify_row(inv_diff, tmp_path, isolated_vault, capsys):
    """--log appends one Observation-enveloped verify row (schema_version 2)."""
    correlation = inv_diff.new_ulid()
    rc = _run_log(inv_diff, tmp_path, correlation)
    assert rc == 0

    log = isolated_vault / 'compress' / 'verify-log.jsonl'
    lines = log.read_text(encoding='utf-8').splitlines()
    assert len(lines) == 1

    row = json.loads(lines[0])
    assert ULID_RE.match(row['id'])
    assert row['source'] == 'compress-skill'
    assert row['source_ref'] == '3f786850e387550fdab836ed7e6dc881de23001b'
    assert row['category'] == 'verify'
    assert row['correlation'] == correlation

    payload = row['payload_typed']
    assert payload['schema_version'] == 2
    assert payload['recall'] == 1.0
    assert payload['missing'] == []
    assert payload['invented'] == []
    assert payload['changed'] == []
    assert payload['diff_mode'] == 'anchor-based'
    assert payload['floor'] == 0.85
    assert payload['verdict'] == 'pass'
    assert payload['anchor_tokens'] == 12
    assert payload['legend_tokens'] == 0


def test_log_is_append_only(inv_diff, tmp_path, isolated_vault, capsys):
    """Two --log runs append two rows — O_APPEND, never truncate."""
    _run_log(inv_diff, tmp_path, inv_diff.new_ulid())
    _run_log(inv_diff, tmp_path, inv_diff.new_ulid())
    log = isolated_vault / 'compress' / 'verify-log.jsonl'
    assert len(log.read_text(encoding='utf-8').splitlines()) == 2


def test_log_requires_envelope_flags(inv_diff, tmp_path, capsys):
    """--log without target/source-ref/correlation is a usage error → exit 2."""
    writer = make_inventory(8)
    writer_path, reader_path = write_inventories(tmp_path, writer, writer)
    rc = inv_diff.main([str(writer_path), str(reader_path), '--log'])
    assert rc == 2


def test_log_uncreatable_vault_degrades_to_report_only(
    inv_diff, tmp_path, monkeypatch, capsys
):
    """Uncreatable log dir → report still printed, no row, degradation stated."""
    blocker = tmp_path / 'not-a-dir'
    blocker.write_text('file where the vault dir should be', encoding='utf-8')
    monkeypatch.setenv('ROXABI_VAULT_HOME', str(blocker))
    rc = _run_log(inv_diff, tmp_path, inv_diff.new_ulid())
    assert rc == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out)['verdict'] == 'pass'
    assert 'report-only' in captured.err
