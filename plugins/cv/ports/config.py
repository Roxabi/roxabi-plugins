"""CV config port — generic abstract interface for config loading."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Generic, TypeVar

T = TypeVar('T')


class ConfigLoader(ABC, Generic[T]):
    """Abstract interface for loading and validating configuration files."""

    @abstractmethod
    def load(self, path: Path) -> T: ...
