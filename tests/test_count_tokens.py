"""Tests for plugins/compress/scripts/count_tokens.py."""

import importlib.util
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / 'plugins' / 'compress' / 'scripts' / 'count_tokens.py'

# Crockford base32 alphabet — no I, L, O, U
ULID_RE = re.compile(r'^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$')

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
    lines = ledger.read_text(encoding='utf-8').splitlines()
    assert len(lines) == 1

    row = json.loads(lines[0])
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


def test_append_row_is_append_only(ct, isolated_vault):
    """Two appends → two rows; the first row is never clobbered."""
    first = _append_sample_row(ct, ct.new_ulid())
    _append_sample_row(ct, ct.new_ulid())

    ledger = isolated_vault / 'compress' / 'ledger.jsonl'
    lines = ledger.read_text(encoding='utf-8').splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])['id'] == first['id']
    assert json.loads(lines[0])['id'] != json.loads(lines[1])['id']


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
    lines = ledger.read_text(encoding='utf-8').splitlines()
    row = json.loads(lines[-1])
    assert row['correlation'] == correlation
    assert row['payload_typed']['proxy_agreement'] is True


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
