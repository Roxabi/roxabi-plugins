"""CV domain models — typed, frozen dataclasses for CV configuration."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CVConfig:
    """CV generation configuration with validated defaults."""
    default_language: str
    default_format: str = "md"
    supported_languages: tuple[str, ...] = ("en",)

    @classmethod
    def from_dict(cls, data: dict) -> CVConfig:
        """Create from dict, raising ConfigError on missing required fields."""
        from domain.exceptions import ConfigError
        if "default_language" not in data:
            raise ConfigError("'default_language' is required in CV config")
        langs = data.get("supported_languages", ["en"])
        return cls(
            default_language=data["default_language"],
            default_format=data.get("default_format", "md"),
            supported_languages=tuple(langs),
        )
