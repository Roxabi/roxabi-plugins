"""Use case: generate a CV from structured data."""
from __future__ import annotations

import sys
from pathlib import Path

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for _p in [_plugin_root, _repo_root]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

from domain.models import CVConfig
from ports.config import ConfigLoader


class GenerateCVUseCase:
    """Load config and resolve generation parameters.

    Rendering and I/O remain in the CLI shell — this use case owns
    config resolution and language validation only.
    """

    def __init__(self, config_loader: ConfigLoader[CVConfig]):
        self._loader = config_loader

    def load_config(self, path: Path) -> CVConfig:
        return self._loader.load(path)

    def resolve_languages(self, lang_arg: str | None, config: CVConfig) -> list[str]:
        supported = list(config.supported_languages)
        if lang_arg is None:
            return [config.default_language]
        if lang_arg == 'all':
            return supported
        if lang_arg not in supported:
            raise ValueError(f"unsupported language '{lang_arg}'. Supported: {', '.join(supported)}")
        return [lang_arg]
