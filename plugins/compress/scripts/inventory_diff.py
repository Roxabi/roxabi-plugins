#!/usr/bin/env python3
"""Deterministic inventory diff for the compress read-back instrument (#311).

Inputs are two JSON inventories `[{anchor, text}]` — the writer's Phase 2
inventory and a fresh reader's re-expansion. Output is a JSON report:

  missing    — writer anchors absent from the reader
  invented   — reader anchors/items absent from the writer
  changed    — shared anchor, normalized text keys differ; the semantic
               sub-classification (faithful|weakened|inverted) is the
               writer's call at runtime, recorded as writer_classification —
               this script never guesses it (unclassified blocks the verdict
               conservatively)
  recall     — |reader ∩ writer| / |writer non-L0| on (anchor, normalized key)
  verdict    — pass | fail | insufficient sample — human-gated

Normalization and the go/no-go contract live in
skills/compress/references/verify.md (RECALL_FLOOR pre-registered there).

Usage:
  inventory_diff.py writer.json reader.json [--floor F] [--diff-mode M]
      [--anchor-tokens N] [--legend-tokens N]
      [--log --target F --source-ref H --correlation C]

Exit codes: 0 report produced (verdict inside the JSON), 2 on IO/usage errors.
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
SCHEMA_VERSION = 2  # verify-row payload (issue #311 Decision 7)
MIN_N = 8  # min-N guard — recall over fewer writer items is noise
RECALL_FLOOR = 0.85  # default only — SSoT is references/verify.md

# lockstep: keep identical to scripts/count_tokens.py::new_ulid — see #311
_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

# Decision-6 charset: normalized keys keep only [a-z0-9 ∀∃∄∈∉∧∨¬→⟺∅≥≤]
_NORM_DROP_RE = re.compile(r'[^a-z0-9∀∃∄∈∉∧∨¬→⟺∅≥≤]')


def new_ulid() -> str:
    """Vendored minimal ULID: 48-bit ms timestamp + 80-bit randomness, Crockford base32."""
    # lockstep: keep identical to scripts/count_tokens.py::new_ulid — see #311
    value = ((int(time.time() * 1000) & ((1 << 48) - 1)) << 80) | secrets.randbits(80)
    return ''.join(_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5))


def normalize(text: str) -> str:
    """Decision-6 text-key normalization.

    lowercase → strip leading/trailing whitespace → collapse internal
    whitespace runs to one space → drop characters outside the
    `[a-z0-9 ∀∃∄∈∉∧∨¬→⟺∅≥≤]` class (punctuation-only tokens vanish).
    """
    # lockstep: keep identical to tools/validate_plugins.py::_normalize_inventory_text
    # (Decision-6 charset parity) — see #311
    tokens = []
    for token in text.lower().split():
        token = _NORM_DROP_RE.sub('', token)
        if token:
            tokens.append(token)
    return ' '.join(tokens)


def diff(writer: list[dict], reader: list[dict]) -> dict:
    """Set-compare two inventories on (anchor, normalized text key) pairs.

    Deterministic only — no semantics. Recall counts exact normalized matches;
    changed items lower it until the writer reclassifies them at runtime.
    """
    writer_texts = {item['anchor']: item['text'] for item in writer}
    reader_texts = {item['anchor']: item['text'] for item in reader}

    missing = [item for item in writer if item['anchor'] not in reader_texts]
    invented = [item for item in reader if item['anchor'] not in writer_texts]
    changed = []
    matched = 0
    for item in writer:
        anchor = item['anchor']
        if anchor not in reader_texts:
            continue
        if normalize(item['text']) == normalize(reader_texts[anchor]):
            matched += 1
        else:
            changed.append({
                'anchor': anchor,
                'writer_text': item['text'],
                'reader_text': reader_texts[anchor],
                'writer_classification': None,  # writer's call — never guessed here
            })
    return {
        'missing': missing,
        'invented': invented,
        'changed': changed,
        'recall': matched / len(writer) if writer else 0.0,
        'insufficient_sample': len(writer) < MIN_N,
    }


def compute_verdict(result: dict, floor: float) -> str:
    """Apply the verify.md go/no-go to a diff result.

    pass ⟺ recall ≥ floor ∧ zero {missing, invented, changed-blocking};
    changed items classified 'faithful' do not block, everything else
    (weakened, inverted, unclassified) does.
    """
    if result['insufficient_sample']:
        return 'insufficient sample — human-gated'
    blocking_changed = [
        c for c in result['changed'] if c.get('writer_classification') != 'faithful'
    ]
    if (result['recall'] >= floor and not result['missing']
            and not result['invented'] and not blocking_changed):
        return 'pass'
    return 'fail'


def append_log(payload: dict, target: str, source_ref: str, correlation: str) -> dict:
    """Append one Observation-enveloped verify row to verify-log.jsonl.

    Same envelope as the train-A ledger (category 'verify', verify-specific
    payload). Returns the written row.
    """
    row = {
        'id': new_ulid(),
        'source': SOURCE,
        'source_ref': source_ref,
        'ts': datetime.now(timezone.utc).isoformat(),
        'category': 'verify',
        'payload_typed': {'target': target, **payload},
        'correlation': correlation,
    }
    log = ensure_dir(get_plugin_data(PLUGIN_NAME)) / 'verify-log.jsonl'
    # lockstep: keep identical to scripts/count_tokens.py::append_row — see #311
    line = json.dumps(row, ensure_ascii=False) + '\n'
    data = memoryview(line.encode('utf-8'))
    fd = os.open(log, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        while data:
            written = os.write(fd, data)
            data = data[written:]
    finally:
        os.close(fd)
    return row


def _load_inventory(path_str: str):
    """Load one inventory JSON; returns (data, error) — error is exit-2 text."""
    path = Path(path_str)
    if not path.exists():
        return None, f'Error: inventory not found: {path}'
    try:
        return json.loads(path.read_text(encoding='utf-8')), None
    except json.JSONDecodeError as exc:
        return None, f'Error: failed to parse {path}: {exc}'


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description='Diff a writer inventory against a fresh-reader inventory (#311).'
    )
    parser.add_argument('writer', help='writer inventory JSON [{anchor, text}]')
    parser.add_argument('reader', help='reader inventory JSON [{anchor, text}]')
    parser.add_argument('--floor', type=float, default=RECALL_FLOOR,
                        help='recall floor (SSoT: references/verify.md)')
    parser.add_argument('--diff-mode', default='anchor-based')
    parser.add_argument('--anchor-tokens', type=int)
    parser.add_argument('--legend-tokens', type=int)
    parser.add_argument('--log', action='store_true',
                        help='append a verify row to verify-log.jsonl')
    parser.add_argument('--target', help='verified artifact path (envelope)')
    parser.add_argument('--source-ref', help='pre-image hash of the target')
    parser.add_argument('--correlation', help='run ULID shared across the run')
    args = parser.parse_args(argv)

    if args.log and not (args.target and args.source_ref and args.correlation):
        print('Error: --log requires --target, --source-ref and --correlation',
              file=sys.stderr)
        return 2

    writer, error = _load_inventory(args.writer)
    if error:
        print(error, file=sys.stderr)
        return 2
    reader, error = _load_inventory(args.reader)
    if error:
        print(error, file=sys.stderr)
        return 2

    result = diff(writer, reader)
    payload = {
        'schema_version': SCHEMA_VERSION,
        'recall': result['recall'],
        'missing': result['missing'],
        'invented': result['invented'],
        'changed': result['changed'],
        'insufficient_sample': result['insufficient_sample'],
        'diff_mode': args.diff_mode,
        'floor': args.floor,
        'verdict': compute_verdict(result, args.floor),
        'anchor_tokens': args.anchor_tokens,
        'legend_tokens': args.legend_tokens,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    if args.log:
        try:
            append_log(payload, args.target, args.source_ref, args.correlation)
        except OSError as exc:
            # Spec edge case: vault dir uncreatable → report-only, no log row.
            print(f'note: verify-log unavailable ({exc}) — report-only, no log row',
                  file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
