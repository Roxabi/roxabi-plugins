"""LinkedIn-apply storage port — abstract interface for application persistence."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any


class StoragePort(ABC):
    """Abstract interface for job application storage.

    All methods from the current module-level storage.py functions.
    Return types reference domain types that will be moved to domain/models.py
    in Slice 3. For now, they use Any to avoid importing from scripts/.
    """

    @abstractmethod
    def save_analysis(self, job: Any, match_result: Any) -> Path: ...

    @abstractmethod
    def load_recap(self, job_id: str) -> Any: ...

    @abstractmethod
    def list_applications(self, month: str | None = None,
                          status: str | None = None) -> list[Any]: ...

    @abstractmethod
    def get_daily_count(self) -> int: ...

    @abstractmethod
    def get_stats(self) -> dict: ...

    @abstractmethod
    def find_existing_analysis(self, job_id: str) -> Path | None: ...
