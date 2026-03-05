"""Use case: match a job against candidate profile."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_plugin_root = str(Path(__file__).resolve().parents[1])
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

from ports.storage import StoragePort
from ports.matcher import MatcherPort


class MatchJobUseCase:
    """Match a LinkedIn job offer against the candidate's CV.

    Checks for a cached recap first; if none exists, runs the matcher
    and persists the result.
    """

    def __init__(self, storage: StoragePort, matcher: MatcherPort):
        self._storage = storage
        self._matcher = matcher

    async def execute(self, job: Any, cv_data: dict,
                      criteria: dict | None = None) -> Any:
        cached = self._storage.load_recap(job.job_id)
        if cached is not None:
            return cached
        result = await self._matcher.match(job, cv_data, criteria)
        self._storage.save_analysis(job, result)
        return result
