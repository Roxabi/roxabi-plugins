"""JSON file adapter for ConfigLoader[T] port."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Generic, TypeVar

_plugin_root = str(Path(__file__).resolve().parents[1])
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)
from _sdk_bootstrap import ensure_sdk_on_path
ensure_sdk_on_path(__file__)

from ports.config import ConfigLoader

T = TypeVar('T')


class JsonConfigLoader(ConfigLoader[T], Generic[T]):
    """Concrete ConfigLoader backed by JSON files with fail-fast validation."""

    def __init__(self, model_class: type[T]):
        self._model = model_class

    def load(self, path: Path) -> T:
        if not path.exists():
            from domain.exceptions import ConfigError
            raise ConfigError(f'Config file not found: {path}')
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except json.JSONDecodeError as e:
            from domain.exceptions import ConfigError
            raise ConfigError(f'Invalid JSON in {path}: {e}')
        return self._model.from_dict(data)
