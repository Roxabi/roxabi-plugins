"""Web-intel domain models — typed, frozen dataclasses for fetch results."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class FetchResult:
    """Result of fetching content from a URL.

    Field names match the existing raw dict keys for backward compatibility.
    """
    success: bool
    content_type: str
    url: str
    data: dict[str, Any] | None = None
    error: str | None = None
    raw: dict[str, Any] | None = None
    resolved_url: str | None = None
