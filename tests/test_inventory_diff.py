"""Tests for plugins/compress/scripts/inventory_diff.py (issue #311).

Covers the Decision-6 normalization charset, the Decision-7 diff contract
(missing/invented/changed + recall + min-N guard), verdict semantics
(faithful paraphrases do not block), and the --log verify-row envelope
(schema_version 2, category 'verify', O_APPEND).
"""

import importlib.util
import json
import re
import unicodedata
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / 'plugins' / 'compress' / 'scripts' / 'inventory_diff.py'
VALIDATE_PLUGINS_SCRIPT = REPO_ROOT / 'tools' / 'validate_plugins.py'

# Crockford base32 alphabet — no I, L, O, U
ULID_RE = re.compile(r'^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$')


@pytest.fixture(scope='module')
def inv_diff():
    """Load inventory_diff.py as a module via its file path."""
    spec = importlib.util.spec_from_file_location('inventory_diff', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope='module')
def validate_plugins_mod():
    """Load tools/validate_plugins.py as a module via its file path (F3 parity)."""
    spec = importlib.util.spec_from_file_location('validate_plugins', VALIDATE_PLUGINS_SCRIPT)
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


def test_normalize_nfc_and_nfd_forms_are_identical(inv_diff):
    """Composed (NFC) and decomposed (NFD) Unicode forms of the same text must
    normalize identically — otherwise the same content could key differently
    depending on which form the writer/reader tooling happened to emit."""
    nfc = unicodedata.normalize('NFC', 'café — retry')
    nfd = unicodedata.normalize('NFD', 'café — retry')
    assert nfc != nfd  # sanity: the two forms really are byte-different
    assert inv_diff.normalize(nfc) == inv_diff.normalize(nfd)


def test_normalize_nfc_and_nfd_forms_are_identical_in_validate_plugins(validate_plugins_mod):
    """Same NFC/NFD regression, on the lockstep copy in tools/validate_plugins.py (F9)."""
    nfc = unicodedata.normalize('NFC', 'café — retry')
    nfd = unicodedata.normalize('NFD', 'café — retry')
    assert nfc != nfd
    assert (validate_plugins_mod._normalize_inventory_text(nfc)
            == validate_plugins_mod._normalize_inventory_text(nfd))


# ---------------------------------------------------------------------------
# normalize parity — inventory_diff.normalize ≡
# validate_plugins._normalize_inventory_text (F3, Decision-6 lockstep)
# ---------------------------------------------------------------------------

_PARITY_CORPUS = [
    'X ⟺ A ∧ B, threshold ≥ 5',
    'retry — max 3 times!',
    '  Retry   THREE\ttimes  ',
    '∀x ∃y: x ∈ S ∧ y ∉ T → x ⟺ y, else ∅ ≤ result',
    '| plan → dry-run diff of every host change | review the diff |',
    '...   ,,,   !!!',
    'MiXeD Case   With   Weird   Spacing',
    'café — a punctuation-only token: ---',
    unicodedata.normalize('NFD', 'café au lait — protocol ∃!'),
]


@pytest.mark.parametrize('text', _PARITY_CORPUS)
def test_normalize_parity_with_validate_plugins(inv_diff, validate_plugins_mod, text):
    """inventory_diff.normalize and validate_plugins._normalize_inventory_text must
    agree (Decision-6 charset lockstep) across glyphs, table-row punctuation,
    punctuation-only tokens, and mixed case/whitespace."""
    assert inv_diff.normalize(text) == validate_plugins_mod._normalize_inventory_text(text)


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
# duplicate anchors — deduped before any counting, never inflate recall (F4)
# ---------------------------------------------------------------------------

def test_diff_duplicate_writer_anchor_does_not_inflate_recall(inv_diff):
    """A duplicated writer anchor must not count twice toward recall."""
    writer = make_inventory(8)
    writer_padded = writer + [dict(writer[0])]  # exact duplicate of an already-matched anchor
    result = inv_diff.diff(writer_padded, list(writer))
    assert result['recall'] == 1.0
    assert result['duplicates_dropped'] == 1


def test_diff_duplicate_anchor_cannot_mask_a_real_miss(inv_diff):
    """Padding with duplicates of a matched anchor must not disguise a genuine miss."""
    writer = make_inventory(10)
    reader = [item for item in writer if item['anchor'] != 'INV-rule-10']  # 9 items
    # Duplicate INV-rule-1 nine times — before dedupe this pads the denominator with
    # "free" matches (19 total, 18 matched) and could mask the real miss.
    writer_padded = writer + [dict(writer[0])] * 9
    result = inv_diff.diff(writer_padded, reader)
    assert result['recall'] == pytest.approx(0.9)  # unchanged from the undeduped 9/10
    assert result['duplicates_dropped'] == 9
    assert [m['anchor'] for m in result['missing']] == ['INV-rule-10']


def test_diff_duplicate_reader_anchor_counted_in_duplicates_dropped(inv_diff):
    """Reader-side duplicates are deduped too and surfaced in duplicates_dropped."""
    writer = make_inventory(8)
    reader = list(writer) + [dict(writer[0])]
    result = inv_diff.diff(writer, reader)
    assert result['duplicates_dropped'] == 1
    assert result['recall'] == 1.0


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


def test_verdict_fails_on_low_recall_even_when_all_changed_are_faithful(inv_diff):
    """recall < floor must still fail even when every changed item is faithful and
    missing/invented are empty — falsifies a mutant that hardcodes the recall gate
    to True (F10)."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    for i, item in enumerate(reader):
        item['text'] = f'completely rewritten paraphrase number {i}'
    result = inv_diff.diff(writer, reader)
    for c in result['changed']:
        c['writer_classification'] = 'faithful'
    assert result['missing'] == []
    assert result['invented'] == []
    assert result['recall'] < 0.85
    assert inv_diff.compute_verdict(result, floor=0.85) == 'fail'


# ---------------------------------------------------------------------------
# --classified — writer-supplied semantic classification seam (F1a)
# ---------------------------------------------------------------------------

def test_diff_classified_faithful_from_param_does_not_block(inv_diff):
    """diff() accepts a classifications dict; a faithful-classified anchor doesn't block."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    reader[0]['text'] = 'the first item performs a thing'
    result = inv_diff.diff(writer, reader, classifications={'INV-rule-1': 'faithful'})
    assert result['changed'][0]['writer_classification'] == 'faithful'
    assert inv_diff.compute_verdict(result, floor=0.85) == 'pass'


def test_cli_classified_faithful_passes(inv_diff, tmp_path, capsys):
    """--classified marking the sole changed anchor faithful clears the verdict to pass."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    reader[0]['text'] = 'the first item performs a thing'
    writer_path, reader_path = write_inventories(tmp_path, writer, reader)
    classified_path = tmp_path / 'classified.json'
    classified_path.write_text(json.dumps({'INV-rule-1': 'faithful'}), encoding='utf-8')
    rc = inv_diff.main([str(writer_path), str(reader_path), '--classified', str(classified_path)])
    assert rc == 0
    report = json.loads(capsys.readouterr().out)
    assert report['verdict'] == 'pass'
    assert report['changed'][0]['writer_classification'] == 'faithful'


def test_cli_classified_missing_anchor_stays_unclassified_and_blocks(inv_diff, tmp_path, capsys):
    """An anchor absent from --classified stays unclassified — blocks conservatively."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    reader[0]['text'] = 'the first item performs a thing'
    writer_path, reader_path = write_inventories(tmp_path, writer, reader)
    classified_path = tmp_path / 'classified.json'
    classified_path.write_text(json.dumps({}), encoding='utf-8')
    rc = inv_diff.main([str(writer_path), str(reader_path), '--classified', str(classified_path)])
    assert rc == 0
    report = json.loads(capsys.readouterr().out)
    assert report['verdict'] == 'fail'
    assert report['changed'][0]['writer_classification'] is None


def test_log_carries_real_classification(inv_diff, tmp_path, isolated_vault, capsys):
    """--log with --classified writes the real classification into the logged row —
    the report is no longer stuck at unclassified once the seam is used."""
    writer = make_inventory(8)
    reader = [dict(item) for item in writer]
    reader[0]['text'] = 'the first item performs a thing'
    writer_path, reader_path = write_inventories(tmp_path, writer, reader)
    classified_path = tmp_path / 'classified.json'
    classified_path.write_text(json.dumps({'INV-rule-1': 'faithful'}), encoding='utf-8')
    rc = inv_diff.main([
        str(writer_path), str(reader_path),
        '--classified', str(classified_path),
        '--log',
        '--target', 'plugins/sample/skills/sample/SKILL.md',
        '--source-ref', '3f786850e387550fdab836ed7e6dc881de23001b',
        '--correlation', inv_diff.new_ulid(),
    ])
    assert rc == 0
    log = isolated_vault / 'compress' / 'verify-log.jsonl'
    row = json.loads(log.read_text(encoding='utf-8').splitlines()[0])
    assert row['payload_typed']['changed'][0]['writer_classification'] == 'faithful'


def test_cli_classified_invalid_value_exits_2(inv_diff, tmp_path, capsys):
    """An out-of-vocabulary classification value is a usage error → exit 2."""
    writer = make_inventory(8)
    writer_path, reader_path = write_inventories(tmp_path, writer, writer)
    classified_path = tmp_path / 'classified.json'
    classified_path.write_text(json.dumps({'INV-rule-1': 'sort-of'}), encoding='utf-8')
    rc = inv_diff.main([str(writer_path), str(reader_path), '--classified', str(classified_path)])
    assert rc == 2


def test_cli_classified_missing_file_exits_2(inv_diff, tmp_path, capsys):
    """A --classified path that does not exist is a clean usage error → exit 2."""
    writer = make_inventory(8)
    writer_path, reader_path = write_inventories(tmp_path, writer, writer)
    rc = inv_diff.main([
        str(writer_path), str(reader_path), '--classified', str(tmp_path / 'absent.json')
    ])
    assert rc == 2


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
# shape guard — valid JSON but not list-of-{anchor, text} (F5), non-UTF-8 (F5b)
# ---------------------------------------------------------------------------

def test_cli_wrong_top_level_shape_exits_2_cleanly(inv_diff, tmp_path, capsys):
    """A JSON object instead of an array is a clean exit-2 error, never a traceback."""
    writer_path, reader_path = write_inventories(tmp_path, make_inventory(8), [])
    reader_path.write_text(json.dumps({'not': 'a list'}), encoding='utf-8')
    rc = inv_diff.main([str(writer_path), str(reader_path)])
    assert rc == 2
    assert 'not valid inventory shape' in capsys.readouterr().err


def test_cli_item_missing_text_key_exits_2_cleanly(inv_diff, tmp_path, capsys):
    """An item missing the required 'text' string key is a clean exit-2 error."""
    writer_path, reader_path = write_inventories(tmp_path, make_inventory(8), [])
    reader_path.write_text(json.dumps([{'anchor': 'INV-rule-1'}]), encoding='utf-8')
    rc = inv_diff.main([str(writer_path), str(reader_path)])
    assert rc == 2
    assert 'not valid inventory shape' in capsys.readouterr().err


def test_cli_non_utf8_inventory_exits_2_cleanly(inv_diff, tmp_path, capsys):
    """Non-UTF-8 bytes in an inventory file are a clean exit-2 error, not an uncaught
    traceback (F5b — _load_inventory previously caught JSONDecodeError only)."""
    writer_path, reader_path = write_inventories(tmp_path, make_inventory(8), [])
    reader_path.write_bytes(b'\xff\xfe\x00\x01not utf-8')
    rc = inv_diff.main([str(writer_path), str(reader_path)])
    assert rc == 2
    assert 'not valid utf-8' in capsys.readouterr().err.lower()


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
