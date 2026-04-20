#!/usr/bin/env python3
"""Post-process video VLM analysis.json → derivative markdown files.

Generates artifacts matching the qaya-analysis precedent:
    text_frames.md    title cards + slide text (kind=text)
    terms.md          top recurring uppercase terms (acronyms / module names)
    top20_dense.md    top-N frames by description density
    digest.txt        compact one-line-per-frame table

Usage:
    uv run python scripts/analysis_derivatives.py <path-to-analysis.json>
    uv run python scripts/analysis_derivatives.py <dir-with-analysis.json>

Writes into the same directory as analysis.json.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


# Uppercase words of length 2..10, optionally w/ internal hyphen/slash (ED-LNN, DIAGRAM/SCHEMA).
# Require at least 2 uppercase chars so lone 'A' or 'I' don't flood results.
_TERM_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,9}(?:[-/][A-Z0-9]{1,10})?\b")

# Stop words — common false positives (English boilerplate, single-letter acronyms).
_STOP_TERMS = {
    "A", "I", "AND", "OR", "THE", "OF", "ON", "IN", "TO", "IS", "IT",
    "AS", "AT", "BE", "BY", "FOR", "FROM", "HAS", "HAVE", "NOT", "WITH",
    "AN", "ARE", "WAS", "CAN", "MAY", "NEW", "ONE", "TWO",
}


def _ts_str(second: float) -> str:
    s = int(second)
    return f"{s // 60}:{s % 60:02d}"


def _digest_line(frame: dict[str, Any]) -> str:
    ts = _ts_str(frame.get("second", 0))
    kind = (frame.get("kind") or frame.get("scene_type") or "?")[:7]
    desc = frame.get("description") or ""
    char = len(desc)
    ctok = frame.get("pass_2_completion_tokens") or 0
    preview = desc.replace("\n", " ").strip()[:80]
    return f"{ts:>6} | {kind:<7} | {char:>4} | {ctok:>4} | {preview}"


def write_digest(frames: list[dict], out: Path) -> None:
    header = f"{'ts':>6} | {'kind':<7} | {'char':>4} | {'ctok':>4} | preview\n"
    header += "-" * 120 + "\n"
    lines = [_digest_line(f) for f in frames]
    out.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")


def write_text_frames(frames: list[dict], out: Path) -> None:
    """Frames classified as `text` — title cards, slide text."""
    text_frames = [f for f in frames if f.get("kind") == "text" and f.get("description")]
    if not text_frames:
        out.write_text("# Text-kind frames\n\n_No text-kind frames detected._\n", encoding="utf-8")
        return
    out_lines = ["# Text-kind frames (title cards, slide text)", ""]
    for f in text_frames:
        ts = _ts_str(f.get("second", 0))
        desc = (f.get("description") or "").strip()
        out_lines.append(f"## [{ts}] chars={len(desc)}")
        out_lines.append("")
        out_lines.append(desc)
        out_lines.append("")
        out_lines.append("---")
        out_lines.append("")
    out.write_text("\n".join(out_lines), encoding="utf-8")


def write_terms(frames: list[dict], out: Path, min_count: int = 3, top_n: int = 100) -> None:
    """Top recurring uppercase terms across all descriptions."""
    counter: Counter[str] = Counter()
    for f in frames:
        desc = f.get("description") or ""
        for match in _TERM_RE.findall(desc):
            if match in _STOP_TERMS:
                continue
            counter[match] += 1
    items = [(t, c) for t, c in counter.most_common(top_n) if c >= min_count]
    if not items:
        out.write_text("# Top recurring uppercase terms\n\n_None above threshold._\n", encoding="utf-8")
        return
    lines = [
        "# Top recurring uppercase terms (likely acronyms / module names)",
        "",
        "| term | count |",
        "|---|---|",
    ]
    lines.extend(f"| `{t}` | {c} |" for t, c in items)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_top_dense(frames: list[dict], out: Path, top_n: int = 20) -> None:
    """Top-N frames by description character count."""
    scored = [
        (len(f.get("description") or ""), f)
        for f in frames
        if f.get("description")
    ]
    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[:top_n]
    if not top:
        out.write_text(f"# Top-{top_n} dense frames\n\n_No frames with descriptions._\n", encoding="utf-8")
        return
    lines = [f"# Top-{top_n} densest frames (by description length)", ""]
    for chars, f in top:
        ts = _ts_str(f.get("second", 0))
        kind = f.get("kind") or f.get("scene_type") or "?"
        desc = (f.get("description") or "").strip()
        lines.append(f"## [{ts}] kind={kind} chars={chars}")
        lines.append("")
        lines.append(desc)
        lines.append("")
        lines.append("---")
        lines.append("")
    out.write_text("\n".join(lines), encoding="utf-8")


def generate(analysis_path: Path) -> dict[str, Path]:
    data = json.loads(analysis_path.read_text(encoding="utf-8"))
    frames = data.get("frame_descriptions") or []
    out_dir = analysis_path.parent
    paths = {
        "digest": out_dir / "digest.txt",
        "text_frames": out_dir / "text_frames.md",
        "terms": out_dir / "terms.md",
        "top20_dense": out_dir / "top20_dense.md",
    }
    write_digest(frames, paths["digest"])
    write_text_frames(frames, paths["text_frames"])
    write_terms(frames, paths["terms"])
    write_top_dense(frames, paths["top20_dense"])
    return paths


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("path", help="Path to analysis.json OR its parent directory")
    args = ap.parse_args()

    p = Path(args.path).expanduser().resolve()
    if p.is_dir():
        p = p / "analysis.json"
    if not p.is_file():
        print(f"ERROR: not found: {p}", file=sys.stderr)
        sys.exit(1)

    out = generate(p)
    for label, path in out.items():
        print(f"  {label:<12} → {path}")


if __name__ == "__main__":
    main()
