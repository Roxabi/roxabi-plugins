"""Tests for plugins/compress/scripts/count_tokens.py."""

import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / 'plugins' / 'compress' / 'scripts' / 'count_tokens.py'
SKILL_MD = REPO_ROOT / 'plugins' / 'compress' / 'skills' / 'compress' / 'SKILL.md'

# Crockford base32 alphabet — no I, L, O, U
ULID_RE = re.compile(r'^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$')

# SSoT for the Phase 2 degradation instruction: SKILL.md § Phase 2 must contain
# PHASE2_DEGRADED_CLAUSE verbatim. Split into its three invariants — what fires
# it, what it orders, what the user is handed — so the failure message says
# which one drifted.
PHASE2_TRIGGER = 'Report carries `degraded_from`'
PHASE2_IMPERATIVE = 'say it to the user before Phase 3, one line, verbatim shape:'
PHASE2_USER_LINE = (
    'counts degraded: <degraded_from> unavailable → <method> — Δtokens are unmeasured '
    '(proxy ∨ chars/4 estimate), not an API count; the binary threshold (Δ ≈ 0) does '
    '¬bind this run'
)
PHASE2_DEGRADED_CLAUSE = f'{PHASE2_TRIGGER} → {PHASE2_IMPERATIVE} `{PHASE2_USER_LINE}`'

SAMPLE_MD = """\
# Alpha

First section body text for counting.

## Beta

Second section body, slightly longer text goes here.
"""


@pytest.fixture(scope='module')
def ct():
    """Load count_tokens.py as a module via its file path."""
    spec = importlib.util.spec_from_file_location('count_tokens', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def sample_md(tmp_path):
    md = tmp_path / 'sample.md'
    md.write_text(SAMPLE_MD, encoding='utf-8')
    return md


# ---------------------------------------------------------------------------
# Tier selection — no API key, no tiktoken → estimate
# ---------------------------------------------------------------------------

def test_resolve_method_estimate_when_nothing_available(ct, monkeypatch):
    """Without ANTHROPIC_API_KEY and with tiktoken unimportable, method is estimate."""
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.setitem(sys.modules, 'anthropic', None)
    monkeypatch.setitem(sys.modules, 'tiktoken', None)
    assert ct.resolve_method() == 'estimate'


def test_resolve_method_anthropic_api_when_key_and_probe_true(ct):
    """Key set + anthropic probe true → anthropic-api tier (injected seams)."""
    method = ct.resolve_method(env={'ANTHROPIC_API_KEY': 'sk-test'}, probe=lambda: True)
    assert method == 'anthropic-api'


def test_resolve_method_tiktoken_proxy_when_no_key(ct, monkeypatch):
    """No key (probe irrelevant) + tiktoken available → tiktoken-proxy tier."""
    fake = lambda text: text.split()  # noqa: E731
    monkeypatch.setattr(ct, '_load_proxy_encoders', lambda: (fake, fake))
    method = ct.resolve_method(env={}, probe=lambda: True)
    assert method == 'tiktoken-proxy'


def test_resolve_method_estimate_when_key_but_probe_false(ct, monkeypatch):
    """Key set but anthropic not importable (probe False) + no tiktoken → estimate."""
    monkeypatch.setattr(ct, '_load_proxy_encoders', lambda: None)
    method = ct.resolve_method(env={'ANTHROPIC_API_KEY': 'sk-test'}, probe=lambda: False)
    assert method == 'estimate'


# ---------------------------------------------------------------------------
# Proxy tier — injected fake encoders drive the agreement flag
# ---------------------------------------------------------------------------

def test_proxy_agreement_true_when_encoders_agree(ct, sample_md):
    """Identical fake encoders → agreement is True and both counts match."""
    fake = lambda text: text.split()  # noqa: E731
    report = ct.count_target(sample_md, method='tiktoken-proxy', encoders=(fake, fake))
    assert report['method'] == 'tiktoken-proxy'
    assert report['agreement'] is True
    for section in report['sections']:
        assert section['tokens_o200k'] == section['tokens_cl100k']
        assert section['agreement'] is True


def test_proxy_agreement_false_when_encoders_disagree(ct, sample_md):
    """Wildly different fake encoders → agreement is False, both counts shown."""
    fake_words = lambda text: text.split()  # noqa: E731
    fake_chars = lambda text: list(text)  # noqa: E731
    report = ct.count_target(
        sample_md, method='tiktoken-proxy', encoders=(fake_words, fake_chars)
    )
    assert report['agreement'] is False
    section = report['sections'][0]
    assert section['tokens_o200k'] != section['tokens_cl100k']


# ---------------------------------------------------------------------------
# split_sections — fence-aware heading detection
# ---------------------------------------------------------------------------

def test_fenced_hash_does_not_split_section(ct):
    """A `# comment` inside a fenced code block does not start a new section."""
    text = (
        '# Alpha\n\nSome text.\n\n```bash\n# a comment\necho hi\n```\n\nMore text.\n'
    )
    sections = ct.split_sections(text)
    assert [s['name'] for s in sections] == ['Alpha']


def test_list_indented_fence_masks_headings(ct):
    """A fence nested in a list item (2-space indent) still suspends heading detection."""
    text = (
        '# Alpha\n'
        '\n'
        '- step one:\n'
        '\n'
        '  ```bash\n'
        '# not a heading — it is shell\n'
        '  echo hi\n'
        '  ```\n'
        '\n'
        'More text.\n'
    )
    sections = ct.split_sections(text)
    assert [s['name'] for s in sections] == ['Alpha']


def test_three_space_fence_still_closes_a_column_zero_fence(ct):
    """Fence parity holds across a column-0 opener and a 3-space closer (CommonMark max)."""
    text = (
        '# Alpha\n'
        '\n'
        '```bash\n'
        '# inside\n'
        '   ```\n'
        '\n'
        '# Beta\n'
        '\n'
        'Body.\n'
    )
    sections = ct.split_sections(text)
    assert [s['name'] for s in sections] == ['Alpha', 'Beta']


def test_four_space_and_tab_runs_are_not_fences(ct):
    """4-space / tab-indented backticks are indented code, not fences — headings still split."""
    four = '# Alpha\n\n    ```\n\n# Beta\n\nBody.\n'
    assert [s['name'] for s in ct.split_sections(four)] == ['Alpha', 'Beta']
    tab = '# Alpha\n\n\t```\n\n# Beta\n\nBody.\n'
    assert [s['name'] for s in ct.split_sections(tab)] == ['Alpha', 'Beta']


def test_fence_with_info_string_does_not_close_a_block(ct):
    """An opener nested in a list is still an OPENER — only a bare run closes.

    ```` ```bash ```` indented two spaces used to toggle the state off, which
    unmasked every `#` line in the rest of the block.
    """
    text = (
        '# Alpha\n'
        '\n'
        '```bash\n'
        '# masked\n'
        '  ```python\n'
        '# still masked — that line opened nothing and closed nothing\n'
        '```\n'
        '\n'
        '# Beta\n'
        '\n'
        'Body.\n'
    )
    assert [s['name'] for s in ct.split_sections(text)] == ['Alpha', 'Beta']


def test_longer_fence_run_is_closed_only_by_an_equal_or_longer_run(ct):
    """A 3-backtick line inside a 4-backtick block is content, not the closer."""
    text = (
        '# Alpha\n'
        '\n'
        '````markdown\n'
        '```\n'
        '# masked — inner fence is sample text\n'
        '```\n'
        '````\n'
        '\n'
        '# Beta\n'
        '\n'
        'Body.\n'
    )
    assert [s['name'] for s in ct.split_sections(text)] == ['Alpha', 'Beta']


def test_tilde_fence_masks_headings(ct):
    """`~~~` is a fence too, and a backtick run never closes a tilde block."""
    text = (
        '# Alpha\n'
        '\n'
        '~~~bash\n'
        '# masked\n'
        '```\n'
        '# still masked — wrong marker\n'
        '~~~\n'
        '\n'
        '# Beta\n'
        '\n'
        'Body.\n'
    )
    assert [s['name'] for s in ct.split_sections(text)] == ['Alpha', 'Beta']


@pytest.mark.xfail(
    reason='known gap: _FENCE_RE measures indent from column 0, but CommonMark '
           'measures a list-nested fence from the item content column — under '
           '`1. ` that is 3, so the fence sits at 4+ absolute spaces and reads '
           'as an indented code block here',
    strict=True,
)
def test_ordered_list_indented_fence_masks_headings(ct):
    """A fence inside an ordered-list item (4-space indent) should still mask."""
    text = (
        '# Alpha\n'
        '\n'
        '1. step one:\n'
        '\n'
        '    ```bash\n'
        '# not a heading — it is shell\n'
        '    echo hi\n'
        '    ```\n'
        '\n'
        'More text.\n'
    )
    assert [s['name'] for s in ct.split_sections(text)] == ['Alpha']


def test_preamble_before_first_heading(ct):
    """Text before the first heading lands in a '(preamble)' section."""
    text = 'Some intro text.\n\n# Alpha\n\nBody.\n'
    sections = ct.split_sections(text)
    assert sections[0]['name'] == '(preamble)'
    assert 'Some intro text.' in sections[0]['text']
    assert sections[1]['name'] == 'Alpha'


def test_zero_headings_yields_one_section(ct):
    """No ATX headings at all → the whole text is one section."""
    text = 'Just plain text.\nNo headings here.\n'
    sections = ct.split_sections(text)
    assert len(sections) == 1
    assert sections[0]['name'] == '(preamble)'


# ---------------------------------------------------------------------------
# count — per-section entries + mandatory method field
# ---------------------------------------------------------------------------

def test_count_reports_sections_and_method(ct, sample_md):
    """count_target splits on headings and always labels the method."""
    report = ct.count_target(sample_md, method='estimate')
    assert report['method'] == 'estimate'
    assert [s['name'] for s in report['sections']] == ['Alpha', 'Beta']
    for section in report['sections']:
        assert section['tokens'] > 0
    assert report['tokens'] > 0
    assert 'warning' in report


def test_count_cli_emits_json_with_method(ct, sample_md, capsys, monkeypatch):
    """The count subcommand prints a JSON report with a mandatory method field."""
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.setitem(sys.modules, 'anthropic', None)
    monkeypatch.setitem(sys.modules, 'tiktoken', None)
    rc = ct.main(['count', str(sample_md)])
    assert rc == 0
    report = json.loads(capsys.readouterr().out)
    assert report['method'] == 'estimate'
    assert len(report['sections']) == 2


def test_count_cli_missing_file_exits_nonzero(ct, capsys, tmp_path):
    """count on a nonexistent path exits 1 with a clean stderr message, no traceback."""
    missing = tmp_path / 'nope.md'
    with pytest.raises(SystemExit) as exc_info:
        ct.main(['count', str(missing)])
    assert exc_info.value.code == 1
    err = capsys.readouterr().err
    assert 'not found' in err
    assert 'Traceback' not in err


def test_new_ulid_cli_prints_valid_ulid(ct, capsys):
    """The new-ulid subcommand prints a bare 26-char Crockford ULID."""
    rc = ct.main(['new-ulid'])
    assert rc == 0
    out = capsys.readouterr().out.strip()
    assert ULID_RE.match(out)


# ---------------------------------------------------------------------------
# anthropic-api tier — in-run degradation on failure
# ---------------------------------------------------------------------------

def test_anthropic_api_failure_degrades_to_tiktoken_proxy(ct, sample_md, monkeypatch):
    """An anthropic-api failure degrades in-run to tiktoken-proxy when available."""
    def boom(text):
        raise RuntimeError('network down')

    fake = lambda text: text.split()  # noqa: E731
    monkeypatch.setattr(ct, '_api_count', boom)
    monkeypatch.setattr(ct, '_load_proxy_encoders', lambda: (fake, fake))
    report = ct.count_target(sample_md, method='anthropic-api')
    assert report['method'] == 'tiktoken-proxy'
    assert report['degraded_from'] == 'anthropic-api'
    assert 'warning' in report


def test_anthropic_api_failure_degrades_to_estimate_when_no_proxy(ct, sample_md, monkeypatch):
    """An anthropic-api failure degrades to estimate when tiktoken is also unavailable."""
    def boom(text):
        raise RuntimeError('network down')

    monkeypatch.setattr(ct, '_api_count', boom)
    monkeypatch.setattr(ct, '_load_proxy_encoders', lambda: None)
    report = ct.count_target(sample_md, method='anthropic-api')
    assert report['method'] == 'estimate'
    assert report['degraded_from'] == 'anthropic-api'
    assert 'warning' in report


def test_proxy_collapse_to_estimate_is_a_degradation(ct, sample_md, monkeypatch):
    """A requested proxy tier that collapses to estimate is degraded, and says so.

    `degraded_from` has to mean the same thing at every site — the tier I
    resolved is not the tier I delivered — or Phase 2's degradation line stays
    quiet on a run whose Δtokens are chars/4.
    """
    monkeypatch.setattr(ct, '_load_proxy_encoders', lambda: None)
    report = ct.count_target(sample_md, method='tiktoken-proxy')
    assert report['method'] == 'estimate'
    assert report['degraded_from'] == 'tiktoken-proxy'


def test_undegraded_run_carries_no_degraded_from(ct, sample_md):
    """A tier delivered as resolved is not degraded — the field stays absent."""
    assert 'degraded_from' not in ct.count_target(sample_md, method='estimate')


def test_degraded_warning_names_the_tier_the_report_landed_on(ct, sample_md, monkeypatch):
    """The warning is built from the fallback's method, not from the probe.

    The probe can say "tiktoken is there" and the encoders still fail to load
    inside the fallback count — naming the probed tier would advertise proxy
    counts on a chars/4 report.
    """
    probes = iter([(lambda text: text.split(),) * 2, None])

    def flaky_encoders():
        # First call = the probe in the except branch, second = the recursive
        # count_target that actually has to produce the numbers.
        return next(probes, None)

    def boom(text):
        raise RuntimeError('network down')

    monkeypatch.setattr(ct, '_api_count', boom)
    monkeypatch.setattr(ct, '_load_proxy_encoders', flaky_encoders)
    report = ct.count_target(sample_md, method='anthropic-api')
    assert report['method'] == 'estimate'
    assert report['degraded_from'] == 'anthropic-api'
    assert 'degraded to estimate' in report['warning']


def test_calibration_failure_keeps_api_counts_and_tier(ct, sample_md, monkeypatch):
    """A calibration-only failure never discards correct API counts nor degrades the tier."""
    def exploding_encoder(text):
        raise RuntimeError('bpe data unavailable')

    monkeypatch.setattr(ct, '_api_count', lambda text: len(text.split()))
    monkeypatch.setattr(
        ct, '_load_proxy_encoders', lambda: (exploding_encoder, exploding_encoder)
    )
    report = ct.count_target(sample_md, method='anthropic-api')
    assert report['method'] == 'anthropic-api'
    assert 'degraded_from' not in report
    assert report['tokens'] == sum(
        len(s['text'].split()) for s in ct.split_sections(SAMPLE_MD)
    )
    assert [s['name'] for s in report['sections']] == ['Alpha', 'Beta']
    assert 'calibration' not in report
    assert 'bpe data unavailable' in report['calibration_error']


def test_calibration_loader_failure_keeps_api_counts(ct, sample_md, monkeypatch):
    """Even a raising encoder LOADER leaves the API counts and the tier intact."""
    def boom():
        raise RuntimeError('tiktoken import exploded')

    monkeypatch.setattr(ct, '_api_count', lambda text: 7)
    monkeypatch.setattr(ct, '_load_proxy_encoders', boom)
    report = ct.count_target(sample_md, method='anthropic-api')
    assert report['method'] == 'anthropic-api'
    assert 'degraded_from' not in report
    assert report['tokens'] == 14
    assert 'tiktoken import exploded' in report['calibration_error']


def test_calibration_success_annotates_without_degrading(ct, sample_md, monkeypatch):
    """When both tiers work the report carries a calibration line and no error."""
    fake = lambda text: text.split()  # noqa: E731
    monkeypatch.setattr(ct, '_api_count', lambda text: len(text.split()))
    monkeypatch.setattr(ct, '_load_proxy_encoders', lambda: (fake, fake))
    report = ct.count_target(sample_md, method='anthropic-api')
    assert report['method'] == 'anthropic-api'
    assert 'degraded_from' not in report
    assert 'calibration: o200k=' in report['calibration']
    assert 'calibration_error' not in report


# ---------------------------------------------------------------------------
# append — Observation-shaped ledger row
# ---------------------------------------------------------------------------

def _append_sample_row(ct, correlation):
    return ct.append_row(
        mode='compress',
        target='plugins/compress/skills/compress/SKILL.md',
        source_ref='3f786850e387550fdab836ed7e6dc881de23001b',
        tokens_before=100,
        tokens_after=80,
        sections=[{'name': 'Alpha', 'tokens_before': 60, 'tokens_after': 50}],
        correlation=correlation,
        method='estimate',
    )


def test_append_row_writes_observation_shape(ct, isolated_vault):
    """One append → one JSONL row matching the Observation contract."""
    correlation = ct.new_ulid()
    _append_sample_row(ct, correlation)

    ledger = isolated_vault / 'compress' / 'ledger.jsonl'
    rows = ct.read_rows(ledger)
    assert len(rows) == 1

    row = rows[0]
    assert ULID_RE.match(row['id'])
    assert row['source'] == 'compress-skill'
    assert row['source_ref'] == '3f786850e387550fdab836ed7e6dc881de23001b'
    assert datetime.fromisoformat(row['ts']).utcoffset() == timedelta(0)
    assert row['category'] == 'compress'
    assert row['correlation'] == correlation

    payload = row['payload_typed']
    assert payload['schema_version'] == 1
    assert payload['method'] == 'estimate'
    assert payload['target'] == 'plugins/compress/skills/compress/SKILL.md'
    assert payload['sections'] == [
        {'name': 'Alpha', 'tokens_before': 60, 'tokens_after': 50}
    ]
    assert payload['tokens_before'] == 100
    assert payload['tokens_after'] == 80
    # Reserved fields: present and null until #310 / #311 land
    assert 'glossary_version' in payload and payload['glossary_version'] is None
    assert 'level' in payload and payload['level'] is None
    assert 'proxy_agreement' in payload
    assert 'calibration' in payload
    assert 'calibration_error' in payload


def test_append_row_is_append_only(ct, isolated_vault):
    """Two appends → two rows; the first row is never clobbered."""
    first = _append_sample_row(ct, ct.new_ulid())
    _append_sample_row(ct, ct.new_ulid())

    ledger = isolated_vault / 'compress' / 'ledger.jsonl'
    rows = ct.read_rows(ledger)
    assert len(rows) == 2
    assert rows[0]['id'] == first['id']
    assert rows[0]['id'] != rows[1]['id']


def _shorten_once(ct, monkeypatch, missing):
    """Make the next ledger-row os.write drop its last `missing` bytes, once."""
    real_write = os.write
    marker = b'"source": "compress-skill"'
    shortened = []

    def short_write(fd, data):
        payload = bytes(data)
        # One-shot, and only for the ledger row: other fds (and any recovery
        # append) must keep the real syscall. Never monkeypatch.undo() here —
        # the vault-isolation fixture shares this monkeypatch instance.
        if marker in payload and not shortened:
            shortened.append(True)
            return real_write(fd, payload[:len(payload) - missing])
        return real_write(fd, payload)

    monkeypatch.setattr(ct.os, 'write', short_write)


def test_concurrent_row_survives_a_short_write(ct, isolated_vault, monkeypatch):
    """Writer B lands a full row in the gap left by writer A's short write.

    The reviewer's reproduction, against real append_row: B's append happens
    between A's syscall and A's return, i.e. while the tail of the ledger is
    A's unterminated fragment. Under a trailing separator B is swallowed by
    that fragment — and the seal that used to "fix" it fires afterwards, so it
    cannot help. The separator leading the row is what makes B survive.
    """
    real_write = os.write
    marker = b'"source": "compress-skill"'
    landed = []

    def short_write_then_concurrent_append(fd, data):
        payload = bytes(data)
        if marker in payload and not landed:
            landed.append(None)                       # writer A short-writes
            written = real_write(fd, payload[:len(payload) // 2])
            landed[0] = _append_sample_row(ct, ct.new_ulid())  # writer B, in the gap
            return written
        return real_write(fd, payload)

    monkeypatch.setattr(ct.os, 'write', short_write_then_concurrent_append)
    with pytest.raises(ct.LedgerTruncatedError):
        _append_sample_row(ct, ct.new_ulid())

    ledger = isolated_vault / 'compress' / 'ledger.jsonl'
    assert [row['id'] for row in ct.read_rows(ledger)] == [landed[0]['id']]


def test_short_ledger_write_fails_loudly(ct, isolated_vault, monkeypatch):
    """A short write raises a distinct truncation error, with no second syscall.

    And the damage stops at the fragment: because the separator leads the row,
    the next writer's row lands on its own line and still parses. This is the
    reviewer's concurrency reproduction — writer A short-writes, writer B
    appends a full row — and B survives it.
    """
    _shorten_once(ct, monkeypatch, missing=200)
    with pytest.raises(ct.LedgerTruncatedError, match='truncated'):
        _append_sample_row(ct, ct.new_ulid())

    ledger = isolated_vault / 'compress' / 'ledger.jsonl'
    fragment = [ln for ln in ledger.read_text(encoding='utf-8').splitlines() if ln.strip()]
    assert len(fragment) == 1
    with pytest.raises(json.JSONDecodeError):
        json.loads(fragment[0])
    assert ct.read_rows(ledger) == []

    good = _append_sample_row(ct, ct.new_ulid())
    assert [row['id'] for row in ct.read_rows(ledger)] == [good['id']]


def test_short_write_of_one_byte_is_still_a_truncation(ct, isolated_vault, monkeypatch):
    """Left framing makes "wrote fewer bytes" and "the row is corrupt" coincide.

    Under a trailing separator the two disagreed on one boundary — the row
    landed whole and only its newline was dropped, and the guard still told the
    operator to discard a good row. With the separator leading, every byte a
    short write drops is a byte of JSON, so there is no such boundary left.
    """
    _shorten_once(ct, monkeypatch, missing=1)
    with pytest.raises(ct.LedgerTruncatedError, match='truncated'):
        _append_sample_row(ct, ct.new_ulid())

    ledger = isolated_vault / 'compress' / 'ledger.jsonl'
    assert ct.read_rows(ledger) == []
    good = _append_sample_row(ct, ct.new_ulid())
    assert [row['id'] for row in ct.read_rows(ledger)] == [good['id']]


def test_read_rows_tolerates_blank_and_unparseable_lines(ct, tmp_path):
    """The reader skips what the framing produces — it never raises on a log."""
    log = tmp_path / 'ledger.jsonl'
    log.write_text('\n{"id": "A"}\n{"id": "B"}\n{"trunc\n\n\n{"id": "C"}',
                   encoding='utf-8')
    assert [row['id'] for row in ct.read_rows(log)] == ['A', 'B', 'C']


def test_read_rows_parses_a_mixed_framing_file(ct, isolated_vault):
    """Rows written under the old trailing-newline framing still read back.

    An existing ledger ends with a newline; a left-framed append adds a blank
    line at the seam and nothing else. Old rows, seam, new rows — all present.
    """
    ledger = isolated_vault / 'compress' / 'ledger.jsonl'
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(
        '{"id": "OLD1"}\n{"id": "OLD2"}\n', encoding='utf-8'
    )  # pre-#329 framing
    new = _append_sample_row(ct, ct.new_ulid())

    assert [row['id'] for row in ct.read_rows(ledger)] == ['OLD1', 'OLD2', new['id']]


def test_ledger_truncation_is_a_distinct_oserror(ct):
    """Truncation is catchable apart from 'no row was written' OSErrors."""
    assert issubclass(ct.LedgerTruncatedError, OSError)
    assert ct.LedgerTruncatedError is not OSError


def test_append_cli_writes_row(ct, isolated_vault):
    """The append subcommand writes a ledger row with proxy_agreement as a real bool."""
    correlation = ct.new_ulid()
    rc = ct.main([
        'append',
        '--target', 'plugins/compress/skills/compress/SKILL.md',
        '--mode', 'compress',
        '--source-ref', 'abc',
        '--tokens-before', '10',
        '--tokens-after', '5',
        '--sections-json', '[]',
        '--correlation', correlation,
        '--proxy-agreement', 'true',
    ])
    assert rc == 0

    ledger = isolated_vault / 'compress' / 'ledger.jsonl'
    row = ct.read_rows(ledger)[-1]
    assert row['correlation'] == correlation
    assert row['payload_typed']['proxy_agreement'] is True


def test_append_cli_records_calibration_error(ct, isolated_vault):
    """A failed calibration reaches the ledger — distinguishable from an absent one."""
    failed = ct.main([
        'append', '--target', 't.md', '--mode', 'compress', '--source-ref', 'abc',
        '--tokens-before', '10', '--tokens-after', '5', '--sections-json', '[]',
        '--correlation', ct.new_ulid(),
        '--calibration-error', 'proxy calibration failed (bpe data unavailable)',
    ])
    absent = ct.main([
        'append', '--target', 't.md', '--mode', 'compress', '--source-ref', 'abc',
        '--tokens-before', '10', '--tokens-after', '5', '--sections-json', '[]',
        '--correlation', ct.new_ulid(),
    ])
    assert (failed, absent) == (0, 0)

    rows = ct.read_rows(isolated_vault / 'compress' / 'ledger.jsonl')
    assert rows[0]['payload_typed']['calibration_error'] == (
        'proxy calibration failed (bpe data unavailable)'
    )
    assert rows[1]['payload_typed']['calibration_error'] is None


def test_append_cli_missing_required_arg_exits_nonzero(ct):
    """A missing required CLI argument exits nonzero via argparse (SystemExit)."""
    with pytest.raises(SystemExit) as exc_info:
        ct.main(['append', '--mode', 'compress'])
    assert exc_info.value.code != 0


def test_append_cli_invalid_sections_json_exits_nonzero(ct, capsys):
    """append with malformed --sections-json exits 1 with a clean stderr message."""
    with pytest.raises(SystemExit) as exc_info:
        ct.main([
            'append',
            '--target', 't.md',
            '--mode', 'compress',
            '--source-ref', 'abc',
            '--tokens-before', '10',
            '--tokens-after', '5',
            '--sections-json', 'not-json',
            '--correlation', 'C',
        ])
    assert exc_info.value.code == 1
    err = capsys.readouterr().err
    assert 'sections-json' in err
    assert 'Traceback' not in err


def test_new_ulid_shape(ct):
    """Vendored ULIDs are 26-char Crockford base32 and unique."""
    a, b = ct.new_ulid(), ct.new_ulid()
    assert ULID_RE.match(a)
    assert ULID_RE.match(b)
    assert a != b


# ---------------------------------------------------------------------------
# Real tiktoken sanity (skipped in CI — tiktoken not installed)
# ---------------------------------------------------------------------------

def test_real_tiktoken_count_sanity(ct, sample_md):
    """With real tiktoken encodings, proxy counts are positive and below char count."""
    tiktoken = pytest.importorskip('tiktoken')
    try:
        o200k = tiktoken.get_encoding('o200k_base')
        cl100k = tiktoken.get_encoding('cl100k_base')
    except Exception:  # first-use network fetch may fail in sandboxed envs
        pytest.skip('tiktoken encoding data unavailable')
    report = ct.count_target(
        sample_md, method='tiktoken-proxy', encoders=(o200k.encode, cl100k.encode)
    )
    assert 0 < report['tokens_o200k'] < len(SAMPLE_MD)
    assert 0 < report['tokens_cl100k'] < len(SAMPLE_MD)


# ---------------------------------------------------------------------------
# Skill contract — the degradation marker has to reach a human
# ---------------------------------------------------------------------------

def _phase2() -> str:
    return (
        SKILL_MD.read_text(encoding='utf-8')
        .split('## Phase 2 — Analyze', 1)[1]
        .split('## Phase 3', 1)[0]
    )


def test_skill_phase2_degradation_clause_is_verbatim():
    """SKILL.md § Phase 2 carries PHASE2_DEGRADED_CLAUSE, character for character.

    Asserting the presence of keywords ('degraded_from', 'counts degraded',
    '<method>', 'bind') passed on the instruction's exact inversion — "say
    NOTHING to the user; counts degraded is internal-only" keeps every one of
    those words. The invariants that make the line worth anything are its own:
    the trigger, the imperative, and the payload the user is handed — so they
    are one constant, and the skill has to contain it whole.
    """
    assert PHASE2_DEGRADED_CLAUSE in _phase2()


def test_skill_phase2_cites_no_threshold_the_skill_never_applies():
    """The degradation line may only suspend thresholds the skill actually has.

    It used to suspend a '<5% skip' rule that appears nowhere in the skill, the
    references, or the counter — a rule a reader would go looking for.
    """
    skill = SKILL_MD.read_text(encoding='utf-8')
    assert '5%' not in skill
    assert 'Δ ≈ 0' in PHASE2_DEGRADED_CLAUSE  # the threshold Phase 4 does apply
    assert 'Δtokens ≈ 0' in skill


def test_skill_phase2_captures_calibration_error():
    """Phase 2 captures calibration_error, so a failed calibration reaches the row."""
    assert 'calibration_error' in _phase2()
