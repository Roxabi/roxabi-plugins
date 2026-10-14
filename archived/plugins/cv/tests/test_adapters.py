"""Tests for CV JsonConfigLoader adapter."""
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
from domain.models import CVConfig
from domain.exceptions import ConfigError


class TestCVJsonConfigLoader:

    def test_load_valid_config(self, tmp_path):
        config_file = tmp_path / 'cv.json'
        config_file.write_text(json.dumps({
            'default_language': 'en',
            'default_format': 'pdf',
            'supported_languages': ['en', 'fr'],
        }))
        loader = JsonConfigLoader(CVConfig)
        config = loader.load(config_file)
        assert isinstance(config, CVConfig)
        assert config.default_language == 'en'
        assert config.default_format == 'pdf'
        assert config.supported_languages == ('en', 'fr')

    def test_load_minimal_config(self, tmp_path):
        config_file = tmp_path / 'cv.json'
        config_file.write_text(json.dumps({'default_language': 'fr'}))
        loader = JsonConfigLoader(CVConfig)
        config = loader.load(config_file)
        assert config.default_language == 'fr'
        assert config.default_format == 'md'

    def test_load_missing_file_raises(self, tmp_path):
        loader = JsonConfigLoader(CVConfig)
        with pytest.raises(ConfigError, match='not found'):
            loader.load(tmp_path / 'nonexistent.json')

    def test_load_invalid_json_raises(self, tmp_path):
        config_file = tmp_path / 'bad.json'
        config_file.write_text('not json!')
        loader = JsonConfigLoader(CVConfig)
        with pytest.raises(ConfigError, match='Invalid JSON'):
            loader.load(config_file)

    def test_load_missing_required_field_raises(self, tmp_path):
        config_file = tmp_path / 'cv.json'
        config_file.write_text(json.dumps({'default_format': 'pdf'}))
        loader = JsonConfigLoader(CVConfig)
        with pytest.raises(ConfigError):
            loader.load(config_file)
