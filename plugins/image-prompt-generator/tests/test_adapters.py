"""Tests for image-prompt-generator JsonConfigLoader adapter."""
import json
import sys
from pathlib import Path

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for p in [_plugin_root, _repo_root]:
    if p not in sys.path:
        sys.path.insert(0, p)

from adapters.json_config import JsonConfigLoader
from domain.models import VisualCharter
from domain.exceptions import ConfigError


class TestVisualCharterJsonConfigLoader:

    def test_load_valid_charter(self, tmp_path):
        config_file = tmp_path / 'charter.json'
        config_file.write_text(json.dumps({
            'brand_name': 'Acme',
            'colors': {'primary': '#ff0000'},
            'style': {'mood': 'professional'},
        }))
        loader = JsonConfigLoader(VisualCharter)
        charter = loader.load(config_file)
        assert isinstance(charter, VisualCharter)
        assert charter.brand_name == 'Acme'
        assert charter.colors == {'primary': '#ff0000'}

    def test_load_minimal_charter(self, tmp_path):
        config_file = tmp_path / 'charter.json'
        config_file.write_text(json.dumps({}))
        loader = JsonConfigLoader(VisualCharter)
        charter = loader.load(config_file)
        assert charter.brand_name == ''
        assert charter.colors == {}

    def test_load_missing_file_raises(self, tmp_path):
        loader = JsonConfigLoader(VisualCharter)
        with pytest.raises(ConfigError, match='not found'):
            loader.load(tmp_path / 'nonexistent.json')

    def test_load_invalid_json_raises(self, tmp_path):
        config_file = tmp_path / 'bad.json'
        config_file.write_text('{invalid}')
        loader = JsonConfigLoader(VisualCharter)
        with pytest.raises(ConfigError, match='Invalid JSON'):
            loader.load(config_file)
