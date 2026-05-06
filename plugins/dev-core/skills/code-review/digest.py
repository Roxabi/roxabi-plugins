"""Boundary digest emitter — Slice 2 of code-review redesign.

A boundary digest is a compact summary of what a Chunk contains, sent to
Lane-A agents reviewing *other* chunks so they can detect cross-chunk
anti-patterns (RC-3 / parallel-path-drift) without receiving the full diff.

Design intent (docs/analysis-review-fix-strategy.md §5 F2):
  "Digest must include call-graph edges to named entry points + modified
   ACL/contract hunks (not just signatures)"

What we emit per chunk:
  - List of changed file paths (canonical)
  - Renamed files (old → new) for cross-directory rename detection
  - Summary line-count per file
  - Extracted function/class/def signatures from hunk text (best-effort)

Recall wiring is deferred to Slice 3.
"""
from __future__ import annotations

import re
import sys as _sys
from dataclasses import dataclass, field
from pathlib import Path as _Path

# Allow both package-style and direct-script imports
_sys.path.insert(0, str(_Path(__file__).parent))
from chunker import Chunk, DiffFile  # noqa: E402


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------

@dataclass
class FileDigest:
    """Compact representation of one file's contribution to a chunk."""

    path: str
    old_path: str | None    # populated on renames; None otherwise
    lines: int              # diff line count
    signatures: list[str]   # function/class/method names visible in the diff


@dataclass
class BoundaryDigest:
    """Digest emitted for one Chunk, consumed by agents reviewing other chunks."""

    chunk_index: int
    files: list[FileDigest] = field(default_factory=list)

    @property
    def total_lines(self) -> int:
        return sum(f.lines for f in self.files)

    @property
    def paths(self) -> list[str]:
        return [f.path for f in self.files]

    @property
    def renames(self) -> list[tuple[str, str]]:
        """Return list of (old_path, new_path) pairs for renamed files."""
        return [
            (f.old_path, f.path)
            for f in self.files
            if f.old_path is not None
        ]


# ---------------------------------------------------------------------------
# Signature extraction (best-effort, stdlib only)
# ---------------------------------------------------------------------------

# Match Python/TS/JS function and class definitions in diff context/added lines.
# We intentionally ignore removed lines (prefix '-') — they represent what changed away.
_SIG_PATTERNS = [
    # Python: def foo(...) / async def foo(...) / class Foo(...):
    re.compile(r'^[+ ][ \t]*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)'),
    re.compile(r'^[+ ][ \t]*class\s+([A-Za-z_][A-Za-z0-9_]*)'),
    # TypeScript/JavaScript: function foo / export function foo / const foo = (
    re.compile(r'^[+ ][ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)'),
    re.compile(r'^[+ ][ \t]*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\('),
    # Arrow: export const foo = async (...) =>
    re.compile(r'^[+ ][ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=\s*)?(?:async\s*)?\(.*\)\s*(?::\s*\S+\s*)?=>'),
]

# Dunder/private names to skip from signatures (not useful for cross-chunk analysis)
_SKIP_NAMES = frozenset({
    '__init__', '__repr__', '__str__', '__eq__', '__hash__',
    '__lt__', '__le__', '__gt__', '__ge__', '__ne__',
})


def _extract_signatures(hunk_text: str) -> list[str]:
    """Return deduplicated function/class names visible in hunk_text.

    Only scans added/context lines (prefix '+' or ' '). Removed lines are
    excluded — they represent the before state, not what the agent is reviewing.
    """
    seen: dict[str, None] = {}  # ordered set via dict keys
    for line in hunk_text.splitlines():
        for pat in _SIG_PATTERNS:
            m = pat.match(line)
            if m:
                name = m.group(1)
                if name not in _SKIP_NAMES and not name.startswith('__'):
                    seen[name] = None
                break
    return list(seen.keys())


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def emit_digest(chunk: Chunk, chunk_index: int) -> BoundaryDigest:
    """Produce a BoundaryDigest for a single Chunk.

    Args:
        chunk:       The Chunk to summarise.
        chunk_index: Zero-based index of this chunk in the full chunk list.

    Returns:
        BoundaryDigest with per-file summaries and extracted signatures.
    """
    file_digests: list[FileDigest] = []
    for diff_file in chunk.files:
        sigs = _extract_signatures(diff_file.hunk_text)
        file_digests.append(FileDigest(
            path=diff_file.path,
            old_path=diff_file.old_path,
            lines=diff_file.lines,
            signatures=sigs,
        ))
    return BoundaryDigest(chunk_index=chunk_index, files=file_digests)


def emit_all_digests(chunks: list[Chunk]) -> list[BoundaryDigest]:
    """Emit a BoundaryDigest for every chunk in the list.

    Returns an empty list if chunks is empty.
    """
    return [emit_digest(c, i) for i, c in enumerate(chunks)]


def format_digest_for_agent(digest: BoundaryDigest) -> str:
    """Render a BoundaryDigest as human-readable Markdown for agent prompts.

    Agents reviewing *other* chunks receive this text so they can flag
    cross-chunk concerns (e.g. parallel-path-drift) without reading the
    full diff of that chunk.
    """
    lines: list[str] = [
        f'## Boundary digest — chunk {digest.chunk_index}',
        f'Total diff lines: {digest.total_lines}',
        '',
    ]

    if digest.renames:
        lines.append('### Renames')
        for old, new in digest.renames:
            lines.append(f'  {old} → {new}')
        lines.append('')

    lines.append('### Files')
    for fd in digest.files:
        sig_str = ', '.join(fd.signatures) if fd.signatures else '—'
        lines.append(f'  {fd.path}  ({fd.lines} lines)  sigs: {sig_str}')

    return '\n'.join(lines)
