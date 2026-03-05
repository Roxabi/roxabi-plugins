"""LinkedIn-apply matcher port — abstract interface for job matching."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class MatcherPort(ABC):
    """Abstract interface for LLM-based job matching.

    Parameter and return types reference domain types that will be moved to
    domain/models.py in Slice 3. For now, they use Any to avoid importing
    from scripts/.
    """

    @abstractmethod
    async def match(self, job: Any, cv_data: dict,
                    criteria: dict | None = None) -> Any: ...
