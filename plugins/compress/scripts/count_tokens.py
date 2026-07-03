#!/usr/bin/env python3
"""Token counting and Observation ledger for the compress plugin.

3-tier counter (resolve_method):
  anthropic-api   — ANTHROPIC_API_KEY set and anthropic importable
  tiktoken-proxy  — tiktoken importable and encoding data loadable; computes
                    BOTH o200k_base and cl100k_base and marks agreement
  estimate        — ~chars/4 heuristic, output labeled with a warning

Binary thresholds (<5% skip, delta ~= 0) bind only under method=anthropic-api;
the proxy tier acts only when both encodings agree, and when API + tiktoken
are both available the count emits a one-shot proxy-vs-API calibration line.

Degradation contract: when the Bash tool is unavailable the skill falls back
to method=estimate, skips verify, and writes NO ledger row — all ledger
appends go through `count_tokens.py append` (O_APPEND, one row per run).

Usage:
  count_tokens.py count <file.md> [--method ...]
  count_tokens.py append --target F --mode M --source-ref H --tokens-before N
      --tokens-after N --sections-json J --correlation C [--method ...]
"""
import argparse
import json
import os
import re
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # repo root
from roxabi_sdk.paths import get_plugin_data, ensure_dir


PLUGIN_NAME = 'compress'
SOURCE = 'compress-skill'
SCHEMA_VERSION = 1
METHODS = ['anthropic-api', 'tiktoken-proxy', 'estimate']
AGREEMENT_TOLERANCE = 0.05
ESTIMATE_WARNING = 'estimate tier — chars/4 heuristic, not a real token count'

_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
_HEADING_RE = re.compile(r'^(#{1,6}) (.+)$')


def new_ulid() -> str:
    """Vendored minimal ULID: 48-bit ms timestamp + 80-bit randomness, Crockford base32."""
    value = ((int(time.time() * 1000) & ((1 << 48) - 1)) << 80) | secrets.randbits(80)
    return ''.join(_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5))


def resolve_method() -> str:
    """Pick the best available tier: anthropic-api > tiktoken-proxy > estimate."""
    if os.environ.get('ANTHROPIC_API_KEY'):
        try:
            import anthropic  # noqa: F401
            return 'anthropic-api'
        except ImportError:
            pass
    if _load_proxy_encoders() is not None:
        return 'tiktoken-proxy'
    return 'estimate'


def _load_proxy_encoders():
    """Load (o200k, cl100k) encoder callables; None when tiktoken is unusable.

    Broad except: get_encoding() fetches BPE data on first use and can fail
    in sandboxed environments even when tiktoken imports fine.
    """
    try:
        import tiktoken
        return (
            tiktoken.get_encoding('o200k_base').encode,
            tiktoken.get_encoding('cl100k_base').encode,
        )
    except Exception:
        return None


def estimate_tokens(text: str) -> int:
    """~chars/4 heuristic."""
    return max(1, len(text) // 4)


def split_sections(text: str) -> list[dict]:
    """Split markdown on ATX headings; each section includes its heading line."""
    sections = []
    name, buf = '(preamble)', []
    for line in text.splitlines(keepends=True):
        m = _HEADING_RE.match(line)
        if m:
            if ''.join(buf).strip():
                sections.append({'name': name, 'text': ''.join(buf)})
            name, buf = m.group(2).strip(), [line]
        else:
            buf.append(line)
    if ''.join(buf).strip():
        sections.append({'name': name, 'text': ''.join(buf)})
    return sections


def _agree(a: int, b: int) -> bool:
    """True when both counts are within AGREEMENT_TOLERANCE relative difference."""
    if a == b:
        return True
    return abs(a - b) <= AGREEMENT_TOLERANCE * max(a, b)


def _api_count(text: str) -> int:
    """Count tokens via the Anthropic count_tokens endpoint."""
    import anthropic

    client = anthropic.Anthropic()
    model = os.environ.get('ANTHROPIC_MODEL', 'claude-sonnet-4-5')
    response = client.messages.count_tokens(
        model=model, messages=[{'role': 'user', 'content': text}]
    )
    return response.input_tokens


def count_target(path, method=None, encoders=None) -> dict:
    """Per-section token counts for a markdown file.

    Returns a report dict with a mandatory 'method' field. Proxy reports carry
    both encodings plus 'agreement' flags; the estimate tier is labeled with a
    warning. Binary thresholds bind only under method=anthropic-api.
    """
    path = Path(path)
    text = path.read_text(encoding='utf-8')
    if method is None:
        method = resolve_method()
    if method == 'tiktoken-proxy' and encoders is None:
        encoders = _load_proxy_encoders()
        if encoders is None:
            method = 'estimate'
    sections = split_sections(text)
    report = {'target': str(path), 'method': method, 'sections': []}

    if method == 'tiktoken-proxy':
        total_o200k = total_cl100k = 0
        for section in sections:
            o200k = len(encoders[0](section['text']))
            cl100k = len(encoders[1](section['text']))
            total_o200k += o200k
            total_cl100k += cl100k
            report['sections'].append({
                'name': section['name'],
                'tokens_o200k': o200k,
                'tokens_cl100k': cl100k,
                'agreement': _agree(o200k, cl100k),
            })
        report['tokens_o200k'] = total_o200k
        report['tokens_cl100k'] = total_cl100k
        report['agreement'] = _agree(total_o200k, total_cl100k)
        return report

    if method == 'anthropic-api':
        total = 0
        for section in sections:
            tokens = _api_count(section['text'])
            total += tokens
            report['sections'].append({'name': section['name'], 'tokens': tokens})
        report['tokens'] = total
        proxy = _load_proxy_encoders()
        if proxy is not None and total:
            proxy_total = sum(len(proxy[0](s['text'])) for s in sections)
            delta = (proxy_total - total) / total * 100
            report['calibration'] = (
                f'calibration: o200k={proxy_total} api={total} delta={delta:+.1f}%'
            )
        return report

    total = 0
    for section in sections:
        tokens = estimate_tokens(section['text'])
        total += tokens
        report['sections'].append({'name': section['name'], 'tokens': tokens})
    report['method'] = 'estimate'
    report['tokens'] = total
    report['warning'] = ESTIMATE_WARNING
    return report


def append_row(mode, target, source_ref, tokens_before, tokens_after, sections,
               correlation, method='estimate', proxy_agreement=None,
               calibration=None) -> dict:
    """Append one Observation-shaped row (ADR-005) to the compress ledger.

    source_ref is the pre-image hash of the target, captured by the caller
    BEFORE any write. O_APPEND with a single write keeps concurrent appends
    line-atomic; the ledger has no other write path. glossary_version and
    level stay null until #310 / #311 land. Returns the written row.
    """
    row = {
        'id': new_ulid(),
        'source': SOURCE,
        'source_ref': source_ref,
        'ts': datetime.now(timezone.utc).isoformat(),
        'category': mode,
        'payload_typed': {
            'schema_version': SCHEMA_VERSION,
            'method': method,
            'target': target,
            'sections': sections,
            'tokens_before': tokens_before,
            'tokens_after': tokens_after,
            'proxy_agreement': proxy_agreement,
            'calibration': calibration,
            'glossary_version': None,  # reserved — dep #310
            'level': None,  # reserved — dep #311
        },
        'correlation': correlation,
    }
    ledger = ensure_dir(get_plugin_data(PLUGIN_NAME)) / 'ledger.jsonl'
    line = json.dumps(row, ensure_ascii=False) + '\n'
    fd = os.open(ledger, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(fd, line.encode('utf-8'))
    finally:
        os.close(fd)
    return row


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description='Token counting and Observation ledger for the compress plugin.'
    )
    sub = parser.add_subparsers(dest='command', required=True)

    count_p = sub.add_parser('count', help='Per-section token counts for a markdown file.')
    count_p.add_argument('target')
    count_p.add_argument('--method', choices=METHODS)

    append_p = sub.add_parser('append', help='Append one Observation row to the ledger.')
    append_p.add_argument('--target', required=True)
    append_p.add_argument('--mode', required=True)
    append_p.add_argument('--source-ref', required=True)
    append_p.add_argument('--tokens-before', type=int, required=True)
    append_p.add_argument('--tokens-after', type=int, required=True)
    append_p.add_argument('--sections-json', required=True,
                          help='JSON array of {name, tokens_before, tokens_after}')
    append_p.add_argument('--correlation', required=True)
    append_p.add_argument('--method', default='estimate', choices=METHODS)
    append_p.add_argument('--proxy-agreement', choices=['true', 'false'])
    append_p.add_argument('--calibration')

    args = parser.parse_args(argv)

    if args.command == 'count':
        report = count_target(args.target, method=args.method)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    row = append_row(
        mode=args.mode,
        target=args.target,
        source_ref=args.source_ref,
        tokens_before=args.tokens_before,
        tokens_after=args.tokens_after,
        sections=json.loads(args.sections_json),
        correlation=args.correlation,
        method=args.method,
        proxy_agreement=(
            None if args.proxy_agreement is None else args.proxy_agreement == 'true'
        ),
        calibration=args.calibration,
    )
    print(json.dumps(row, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
