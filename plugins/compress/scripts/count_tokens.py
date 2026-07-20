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
      --tokens-after N --correlation C [--method ...]
      (provide either --sections-json or --payload-file)
  count_tokens.py freshness <file>   # for derive freshness gate (returns unix ts)
  count_tokens.py repo-head          # for derive ledger source-ref (repo snapshot)
  count_tokens.py new-ulid
"""
import argparse
import importlib.util
import json
import os
import re
import secrets
import subprocess
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
_FENCE_RE = re.compile(r'^```')


def new_ulid() -> str:
    """Vendored minimal ULID: 48-bit ms timestamp + 80-bit randomness, Crockford base32."""
    # lockstep: keep identical to scripts/inventory_diff.py::new_ulid — see #311
    value = ((int(time.time() * 1000) & ((1 << 48) - 1)) << 80) | secrets.randbits(80)
    return ''.join(_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5))


def _anthropic_importable() -> bool:
    """True when the anthropic package can be imported."""
    return importlib.util.find_spec('anthropic') is not None


def resolve_method(env=None, probe=None) -> str:
    """Pick the best available tier: anthropic-api > tiktoken-proxy > estimate.

    env/probe are injectable seams for tests, mirroring the encoders= seam on
    the tiktoken-proxy branch: env defaults to os.environ, probe defaults to
    an importlib-based availability check for the anthropic package.
    """
    if env is None:
        env = os.environ
    if probe is None:
        probe = _anthropic_importable
    if env.get('ANTHROPIC_API_KEY') and probe():
        return 'anthropic-api'
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
    """Split markdown on ATX headings; each section includes its heading line.

    Heading detection is suspended inside fenced code blocks (``` ... ```) so
    a `# comment` inside a bash block does not split a section.
    """
    sections = []
    name, buf = '(preamble)', []
    in_fence = False
    for line in text.splitlines(keepends=True):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        m = None if in_fence else _HEADING_RE.match(line)
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

    client = anthropic.Anthropic(timeout=30)
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
    if not path.exists():
        print(f'Error: file not found: {path}', file=sys.stderr)
        sys.exit(1)
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
        try:
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
        except Exception as exc:
            # Mirrors _load_proxy_encoders' degradation idiom: any anthropic-api
            # failure (network, auth, timeout) falls back in-run rather than
            # raising — to tiktoken-proxy when available, else estimate.
            fallback_method = (
                'tiktoken-proxy' if _load_proxy_encoders() is not None else 'estimate'
            )
            fallback = count_target(path, method=fallback_method)
            fallback['degraded_from'] = 'anthropic-api'
            fallback['warning'] = (
                f'anthropic-api failed ({exc}) — degraded to {fallback_method}'
            )
            return fallback

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
    BEFORE any write. O_APPEND keeps concurrent appends line-atomic on POSIX
    as long as each row is written within one open() lifetime; os.write()
    can still return short on a single call, so the write loops until the
    full encoded line (trailing newline included) is flushed. glossary_version
    and level stay null until #310 / #311 land. Returns the written row.
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
    # lockstep: keep identical to scripts/inventory_diff.py::append_log — see #311
    line = json.dumps(row, ensure_ascii=False) + '\n'
    data = memoryview(line.encode('utf-8'))
    fd = os.open(ledger, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        while data:
            written = os.write(fd, data)
            data = data[written:]
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

    sub.add_parser('new-ulid', help='Print a new run ULID (for --correlation).')

    fresh_p = sub.add_parser('freshness', help='Return unix timestamp of last commit for a file (for derive freshness gate).')
    fresh_p.add_argument('file')

    sub.add_parser('repo-head', help='Return current repo HEAD SHA (for derive ledger source-ref).')

    append_p = sub.add_parser('append', help='Append one Observation row to the ledger.')
    append_p.add_argument('--target', required=True)
    append_p.add_argument('--mode', required=True)
    append_p.add_argument('--source-ref', required=True)
    append_p.add_argument('--tokens-before', type=int, required=True)
    append_p.add_argument('--tokens-after', type=int, required=True)
    append_p.add_argument('--sections-json',
                          help='JSON array of {name, tokens_before, tokens_after} (or use --payload-file)')
    append_p.add_argument('--payload-file',
                          help='Path to JSON file with sections (and optionally other fields). Preferred: avoids shell interpolation of untrusted data.')
    append_p.add_argument('--correlation', required=True)
    append_p.add_argument('--method', default='estimate', choices=METHODS)
    append_p.add_argument('--proxy-agreement', choices=['true', 'false'])
    append_p.add_argument('--calibration')

    args = parser.parse_args(argv)

    if args.command == 'count':
        report = count_target(args.target, method=args.method)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    if args.command == 'new-ulid':
        print(new_ulid())
        return 0

    if args.command == 'freshness':
        # Return raw unix timestamp (or empty on failure). Caller does the FRESHNESS_DAYS math + fail-closed.
        try:
            out = subprocess.check_output(
                ['git', 'log', '-1', '--format=%ct', '--', args.file],
                stderr=subprocess.DEVNULL
            ).decode().strip()
            print(out)
        except (subprocess.CalledProcessError, FileNotFoundError, OSError):
            print('')
        return 0

    if args.command == 'repo-head':
        try:
            out = subprocess.check_output(['git', 'rev-parse', 'HEAD'], stderr=subprocess.DEVNULL).decode().strip()
            print(out)
        except (subprocess.CalledProcessError, FileNotFoundError, OSError):
            print('')
        return 0

    # append handling
    sections = None
    if args.payload_file:
        try:
            with open(args.payload_file) as f:
                payload = json.load(f)
            if isinstance(payload, dict):
                sections = payload.get('sections') or payload
            else:
                sections = payload
            if not isinstance(sections, list):
                raise ValueError("payload must contain a list for 'sections'")
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f'Error: invalid --payload-file: {exc}', file=sys.stderr)
            sys.exit(1)
    elif args.sections_json:
        try:
            sections = json.loads(args.sections_json)
        except json.JSONDecodeError as exc:
            print(f'Error: invalid --sections-json: {exc}', file=sys.stderr)
            sys.exit(1)
    else:
        print('Error: either --sections-json or --payload-file is required', file=sys.stderr)
        sys.exit(1)

    row = append_row(
        mode=args.mode,
        target=args.target,
        source_ref=args.source_ref,
        tokens_before=args.tokens_before,
        tokens_after=args.tokens_after,
        sections=sections,
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
