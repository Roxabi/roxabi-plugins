#!/usr/bin/env python3
"""JSON bridge over the canonical review chunker and digest libraries."""
from __future__ import annotations

import json
import sys
from typing import Any

from chunker import chunk, compute_budget, parse_diff
from digest import emit_all_digests, format_digest_for_agent


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}), flush=True)
    raise SystemExit(1)


def main() -> None:
    try:
        request: Any = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(f"invalid JSON input: {error.msg}")
    if not isinstance(request, dict):
        fail("JSON input must be an object")

    raw_diff = request.get("rawDiff")
    context_window = request.get("contextWindow")
    if not isinstance(raw_diff, str):
        fail("rawDiff must be a string")
    if isinstance(context_window, bool) or not isinstance(context_window, int):
        fail("contextWindow must be an integer")
    if context_window <= 0:
        fail("contextWindow must be positive")

    try:
        files = parse_diff(raw_diff)
        chunks = chunk(files, compute_budget(context_window))
        digests = emit_all_digests(chunks)
    except ValueError as error:
        fail(str(error))

    payload = []
    for index, (review_chunk, digest) in enumerate(zip(chunks, digests, strict=True)):
        chunk_files = [
            {
                "path": diff_file.path,
                "oldPath": diff_file.old_path,
                "hunk": diff_file.hunk_text,
            }
            for diff_file in review_chunk.files
        ]
        payload.append(
            {
                "index": index,
                "delta": review_chunk.paths,
                "diff": "\n\n".join(item["hunk"] for item in chunk_files),
                "files": chunk_files,
                "digest": format_digest_for_agent(digest),
            }
        )

    print(json.dumps({"ok": True, "chunks": payload}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
