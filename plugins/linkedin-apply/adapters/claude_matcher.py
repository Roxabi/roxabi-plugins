"""Claude-based adapter for MatcherPort — wraps existing matcher.py."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for _p in [_plugin_root, _repo_root]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

from ports.matcher import MatcherPort


class ClaudeMatcherAdapter(MatcherPort):
    """Concrete MatcherPort backed by Claude LLM via existing matcher.py."""

    async def match(self, job: Any, cv_data: dict,
                    criteria: dict | None = None) -> Any:
        from scripts.matcher import match_job
        return await match_job(job, cv_data, criteria)
