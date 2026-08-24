"""Chunker — directory-cohesion + LOC-bounded fallback.

Slice 2 of the code-review redesign (see docs/analysis-review-fix-strategy.md §3 O2).

Design rules (O2):
  - Primary unit: stable directory tree (all files under the same top-level
    directory belong to one chunk, preserving cohesion across PRs).
  - Fallback: LOC-bounded split only when a single directory exceeds the budget.
  - Budget: 0.4 × active_model_context_window — dynamic, not a hard constant.
  - Pure Python stdlib; raises on malformed input (¬silent None/False coercion).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Sequence


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------

@dataclass
class DiffFile:
    """Parsed metadata for a single file in a unified diff."""

    path: str       # canonical path (b-side for renames, a-side for deletes)
    old_path: str | None  # populated on renames/copies; None otherwise
    lines: int      # total diff lines (context + added + removed) for this file
    hunk_text: str  # raw hunk content (everything after the file header)


@dataclass
class Chunk:
    """A group of DiffFiles assigned to one Lane-A agent."""

    files: list[DiffFile] = field(default_factory=list)

    @property
    def total_lines(self) -> int:
        return sum(f.lines for f in self.files)

    @property
    def paths(self) -> list[str]:
        return [f.path for f in self.files]


# ---------------------------------------------------------------------------
# Diff parsing
# ---------------------------------------------------------------------------

# Matches "diff --git a/... b/..."
# Non-greedy first group to handle paths containing literal ' b/'
_DIFF_HEADER = re.compile(r'^diff --git a/(.+?) b/(.+)$')
# Matches rename/copy "rename from ..." / "rename to ..." headers
_RENAME_FROM = re.compile(r'^rename from (.+)$')
_RENAME_TO = re.compile(r'^rename to (.+)$')


def parse_diff(raw_diff: str) -> list[DiffFile]:
    """Parse a unified git diff into a list of DiffFile objects.

    Raises ValueError with an excerpt of the offending input if the diff
    cannot be parsed (e.g. truncated header, ambiguous path).

    An empty diff returns an empty list (not an error).
    """
    if not raw_diff or not raw_diff.strip():
        return []

    files: list[DiffFile] = []
    lines = raw_diff.splitlines()
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        m = _DIFF_HEADER.match(line)
        if not m:
            i += 1
            continue

        a_path = m.group(1)
        b_path = m.group(2)
        if not a_path or not b_path:
            raise ValueError(f'Degenerate diff --git header: {line!r}')
        i += 1

        # Collect extended headers (index, mode, rename from/to, …)
        rename_from: str | None = None
        rename_to: str | None = None
        hunk_lines: list[str] = []

        while i < n and not _DIFF_HEADER.match(lines[i]):
            current = lines[i]
            rf = _RENAME_FROM.match(current)
            rt = _RENAME_TO.match(current)
            if rf:
                rename_from = rf.group(1)
            elif rt:
                rename_to = rt.group(1)
            else:
                # Everything from the first @@ onward is hunk text
                if current.startswith('@@') or hunk_lines:
                    hunk_lines.append(current)
            i += 1

        hunk_text = '\n'.join(hunk_lines)
        # Exclude @@ separator lines from LOC count; they are preserved in hunk_text
        loc = sum(1 for l in hunk_lines if not l.startswith('@@'))

        # Canonical path: b-side (rename target) if rename; otherwise b-path
        if rename_from is not None and rename_to is not None:
            canonical = rename_to
            old = rename_from
        elif b_path == '/dev/null':
            # Pure deletion — use a-path
            canonical = a_path
            old = None
        else:
            canonical = b_path
            old = a_path if a_path != b_path else None

        files.append(DiffFile(
            path=canonical,
            old_path=old,
            lines=loc,
            hunk_text=hunk_text,
        ))

    return files


# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------

def compute_budget(context_window_tokens: int, fraction: float = 0.4) -> int:
    """Return LOC budget as 0.4 × context window (or custom fraction).

    The token-to-LOC mapping is 1:1 for planning purposes — the budget is
    expressed in diff lines, not characters, so the caller can compare it
    directly against DiffFile.lines.

    Args:
        context_window_tokens: active model context window size (tokens).
        fraction: proportion of the context window to use as budget (default 0.4).

    Raises:
        ValueError: if context_window_tokens ≤ 0 or fraction not in (0, 1].
    """
    if context_window_tokens <= 0:
        raise ValueError(
            f'context_window_tokens must be > 0, got {context_window_tokens}'
        )
    if not (0 < fraction <= 1.0):
        raise ValueError(
            f'fraction must be in (0, 1], got {fraction}'
        )
    return int(context_window_tokens * fraction)


# ---------------------------------------------------------------------------
# Core chunker
# ---------------------------------------------------------------------------

def _top_dir(path: str, depth: int = 1) -> str:
    """Return the top directory component(s) of a path up to *depth* levels.

    'src/lyra/core/foo.py', depth=1 → 'src'
    'src/lyra/core/foo.py', depth=2 → 'src/lyra'
    'README.md',            depth=1 → '.'   (root-level file)

    Default depth=1 preserves existing behaviour.
    """
    parts = PurePosixPath(path).parts
    if len(parts) <= 1:
        return '.'
    return '/'.join(parts[:depth]) or '.'


def chunk(
    files: Sequence[DiffFile],
    budget: int,
) -> list[Chunk]:
    """Partition DiffFiles into Chunks respecting the LOC budget.

    Algorithm:
      1. Group files by top-level directory (directory-cohesion).
      2. For each directory group:
         a. If total LOC ≤ budget → one Chunk for the whole group.
         b. Else → LOC-bounded split within the group (greedy bin-packing).
      3. Any oversized single file (LOC > budget) gets its own Chunk
         (can't split a file further at this layer).

    Returns:
      List of Chunk objects (may be empty if files is empty).

    Raises:
      ValueError: if budget ≤ 0.
    """
    if budget <= 0:
        raise ValueError(f'budget must be > 0, got {budget}')

    if not files:
        return []

    # Group by top-level directory, preserving insertion order
    dir_groups: dict[str, list[DiffFile]] = {}
    for f in files:
        key = _top_dir(f.path)
        dir_groups.setdefault(key, []).append(f)

    result: list[Chunk] = []

    for dir_files in dir_groups.values():
        dir_loc = sum(f.lines for f in dir_files)

        if dir_loc <= budget:
            # Entire directory fits in one chunk
            result.append(Chunk(files=list(dir_files)))
        else:
            # LOC-bounded greedy split within the directory
            current = Chunk()
            for f in dir_files:
                if f.lines > budget:
                    # Single oversized file → its own chunk
                    if current.files:
                        result.append(current)
                        current = Chunk()
                    result.append(Chunk(files=[f]))
                elif current.total_lines + f.lines > budget:
                    # Current chunk would overflow → start a new one
                    result.append(current)
                    current = Chunk(files=[f])
                else:
                    current.files.append(f)

            if current.files:
                result.append(current)

    return result
