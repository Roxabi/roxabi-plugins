"""LinkedIn-apply matcher port — abstract interface for job matching."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from scripts.scraper import LinkedInJob
    from scripts.matcher import MatchResult


class MatcherPort(ABC):
    """Abstract interface for LLM-based job matching."""

    @abstractmethod
    async def match(self, job: LinkedInJob, cv_data: dict,
                    criteria: dict | None = None) -> MatchResult: ...
