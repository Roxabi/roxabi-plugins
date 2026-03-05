"""Image-prompt-generator domain models — typed, frozen dataclasses."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class VisualCharter:
    """Brand visual charter for consistent image generation."""
    brand_name: str
    colors: dict[str, str] = field(default_factory=dict)
    style: dict[str, str] = field(default_factory=dict)
    preferences: dict[str, list[str]] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict) -> VisualCharter:
        """Create from dict, with sensible defaults."""
        return cls(
            brand_name=data.get("brand_name", ""),
            colors=data.get("colors", {}),
            style=data.get("style", {}),
            preferences=data.get("preferences", {}),
        )


@dataclass(frozen=True)
class PromptVariant:
    """A single prompt variant for image generation."""
    index: int
    style: str
    category: str
    prompt: str
    lighting: str
    mood: str
    colors: str
    brand_alignment: str = "no-charter"
