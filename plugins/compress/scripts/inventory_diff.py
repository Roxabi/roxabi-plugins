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
  duplicates_dropped — count of duplicate-anchor items dropped (first
               occurrence wins) before any counting, so a padded inventory
               can never inflate recall
  verdict    — pass | fail | insufficient sample — human-gated

Normalization and the go/no-go contract live in
skills/compress/references/verify.md (RECALL_FLOOR pre-registered there).

Usage:
  inventory_diff.py writer.json reader.json [--floor F] [--diff-mode M]
      [--anchor-tokens N] [--legend-tokens N] [--classified CLASSIFIED_JSON]
      [--log --target F --source-ref H --correlation C]

`--classified` points at a JSON object `{"<anchor>": "faithful"|"weakened"|"inverted"}`
supplied by the writer — its own runtime semantic call on each changed item.
Anchors absent from the file (or the file itself absent) stay unclassified
(None) and block the verdict conservatively; this script never guesses.

Exit codes: 0 report produced (verdict inside the JSON), 2 on IO/usage errors.
"""
import argparse
import json
import os
import re
import secrets
import sys
import time
import unicodedata
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

# --classified values — the writer's own runtime semantic call; anything else
# is a usage error, never silently coerced.
_VALID_CLASSIFICATIONS = {'faithful', 'weakened', 'inverted'}


def new_ulid() -> str:
    """Vendored minimal ULID: 48-bit ms timestamp + 80-bit randomness, Crockford base32."""
    # lockstep: keep identical to scripts/count_tokens.py::new_ulid — see #311
    value = ((int(time.time() * 1000) & ((1 << 48) - 1)) << 80) | secrets.randbits(80)
    return ''.join(_CROCKFORD[(value >> shift) & 0x1F] for shift in range(125, -1, -5))


def normalize(text: str) -> str:
    """Decision-6 text-key normalization.

    NFC-normalize (composed vs. decomposed Unicode forms of logically
    identical text must key identically) → lowercase → strip leading/
    trailing whitespace → collapse internal whitespace runs to one space →
    drop characters outside the `[a-z0-9 ∀∃∄∈∉∧∨¬→⟺∅≥≤]` class
    (punctuation-only tokens vanish).
    """
    # lockstep: keep identical to tools/validate_plugins.py::_normalize_inventory_text
    # (Decision-6 charset parity, NFC-first step) — see #311
    text = unicodedata.normalize('NFC', text)
    tokens = []
    for token in text.lower().split():
        token = _NORM_DROP_RE.sub('', token)
        if token:
            tokens.append(token)
    return ' '.join(tokens)


def _dedupe_by_anchor(items: list[dict]) -> tuple[list[dict], int]:
    """Drop duplicate anchors (first occurrence wins); return (deduped, dropped_count).

    Duplicate anchors must never inflate recall by padding the denominator
    with "free" matched repeats — dedupe happens before any counting.
    """
    seen = set()
    deduped = []
    dropped = 0
    for item in items:
        anchor = item['anchor']
        if anchor in seen:
            dropped += 1
            continue
        seen.add(anchor)
        deduped.append(item)
    return deduped, dropped


def diff(writer: list[dict], reader: list[dict], classifications: dict | None = None) -> dict:
    """Set-compare two inventories on (anchor, normalized text key) pairs.

    Deterministic only — no semantics. Recall counts exact normalized matches;
    changed items lower it until the writer reclassifies them at runtime.
    Duplicate anchors within either inventory are deduped first (see
    `_dedupe_by_anchor`) — the dropped count is surfaced as
    `duplicates_dropped` so a padded inventory can never inflate recall.

    `classifications` maps anchor → 'faithful'|'weakened'|'inverted', as
    supplied by the writer (e.g. via --classified). Anchors absent from the
    map stay unclassified (None) and block the verdict conservatively — this
    function never guesses.
    """
    if classifications is None:
        classifications = {}
    writer, writer_dupes = _dedupe_by_anchor(writer)
    reader, reader_dupes = _dedupe_by_anchor(reader)

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
                'writer_classification': classifications.get(anchor),
            })
    return {
        'missing': missing,
        'invented': invented,
        'changed': changed,
        'recall': matched / len(writer) if writer else 0.0,
        'insufficient_sample': len(writer) < MIN_N,
        'duplicates_dropped': writer_dupes + reader_dupes,
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


def _validate_inventory_shape(data) -> str | None:
    """Return an error string if `data` is not list-of-{anchor: str, text: str}, else None."""
    if not isinstance(data, list):
        return 'not valid inventory shape — expected a JSON array'
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            return f'not valid inventory shape — item {i} is not an object'
        if not isinstance(item.get('anchor'), str) or not isinstance(item.get('text'), str):
            return f'not valid inventory shape — item {i} must have string "anchor" and "text"'
    return None


def _load_inventory(path_str: str):
    """Load one inventory JSON; returns (data, error) — error is exit-2 text.

    Validates list-of-{anchor: str, text: str} shape — a malformed file is a
    clean exit-2 error, never an uncaught traceback further down the pipeline.
    Non-UTF-8 input is likewise a clean exit-2 error (lockstep with
    check_golden_inventories in tools/validate_plugins.py, which already
    catches both JSONDecodeError and UnicodeDecodeError).
    """
    path = Path(path_str)
    if not path.exists():
        return None, f'Error: inventory not found: {path}'
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        return None, f'Error: failed to parse {path}: {exc}'
    except UnicodeDecodeError as exc:
        return None, f'Error: {path} is not valid UTF-8: {exc}'
    shape_error = _validate_inventory_shape(data)
    if shape_error:
        return None, f'Error: {path}: {shape_error}'
    return data, None


def _load_classifications(path_str: str):
    """Load the writer's --classified JSON; returns (dict, error) — error is exit-2 text.

    Shape: `{"<anchor>": "faithful"|"weakened"|"inverted"}` — the writer's own
    runtime semantic call. Any value outside the three-way classification is
    a usage error, never silently coerced or dropped.
    """
    path = Path(path_str)
    if not path.exists():
        return None, f'Error: classifications file not found: {path}'
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        return None, f'Error: failed to parse {path}: {exc}'
    if not isinstance(data, dict):
        return None, f'Error: {path} is not a valid classifications shape (expected a JSON object)'
    for anchor, classification in data.items():
        if not isinstance(anchor, str) or classification not in _VALID_CLASSIFICATIONS:
            return None, (
                f'Error: {path} has an invalid classification for {anchor!r}: '
                f'{classification!r} (expected one of {sorted(_VALID_CLASSIFICATIONS)})'
            )
    return data, None


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
    parser.add_argument('--classified',
                        help='writer-supplied classifications JSON '
                             '{anchor: faithful|weakened|inverted}')
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

    classifications = {}
    if args.classified:
        classifications, error = _load_classifications(args.classified)
        if error:
            print(error, file=sys.stderr)
            return 2

    result = diff(writer, reader, classifications)
    payload = {
        'schema_version': SCHEMA_VERSION,
        'recall': result['recall'],
        'missing': result['missing'],
        'invented': result['invented'],
        'changed': result['changed'],
        'insufficient_sample': result['insufficient_sample'],
        'duplicates_dropped': result['duplicates_dropped'],
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
