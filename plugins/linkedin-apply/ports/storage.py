"""LinkedIn-apply storage port — abstract interface for application persistence."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from scripts.storage import ApplicationRecap


class StoragePort(ABC):
    """Abstract interface for job application storage.

    All methods from the current module-level storage.py functions.
    """

    @abstractmethod
    def save_analysis(self, job: Any, match_result: Any) -> Path: ...

    @abstractmethod
    def load_recap(self, job_id: str) -> ApplicationRecap | None: ...

    @abstractmethod
    def list_applications(self, month: str | None = None,
                          status: str | None = None) -> list[ApplicationRecap]: ...

    @abstractmethod
    def get_daily_count(self) -> int: ...

    @abstractmethod
    def get_stats(self) -> dict: ...

    @abstractmethod
    def find_existing_analysis(self, job_id: str) -> Path | None: ...
