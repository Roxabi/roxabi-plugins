"""Tests for CV use cases — mocked ports, no I/O."""
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for p in [_plugin_root, _repo_root]:
    if p not in sys.path:
        sys.path.insert(0, p)

from domain.exceptions import DataError
from domain.models import CVConfig
from use_cases.generate_cv import GenerateCVUseCase


class TestGenerateCVUseCase:

    def test_delegates_to_config_loader(self, tmp_path):
        mock_loader = MagicMock()
        mock_loader.load.return_value = CVConfig(
            default_language='en', default_format='md',
            supported_languages=('en', 'fr'),
        )
        uc = GenerateCVUseCase(config_loader=mock_loader)
        config = uc.load_config(tmp_path / 'cv.json')
        mock_loader.load.assert_called_once()
        assert config.default_language == 'en'

    def test_resolve_languages_default(self):
        config = CVConfig(default_language='fr', default_format='md',
                          supported_languages=('en', 'fr'))
        uc = GenerateCVUseCase(config_loader=MagicMock())
        langs = uc.resolve_languages(None, config)
        assert langs == ['fr']

    def test_resolve_languages_all(self):
        config = CVConfig(default_language='en', default_format='md',
                          supported_languages=('en', 'fr', 'de'))
        uc = GenerateCVUseCase(config_loader=MagicMock())
        langs = uc.resolve_languages('all', config)
        assert langs == ['en', 'fr', 'de']

    def test_resolve_languages_specific(self):
        config = CVConfig(default_language='en', default_format='md',
                          supported_languages=('en', 'fr'))
        uc = GenerateCVUseCase(config_loader=MagicMock())
        langs = uc.resolve_languages('fr', config)
        assert langs == ['fr']

    def test_resolve_languages_unsupported_raises(self):
        config = CVConfig(default_language='en', default_format='md',
                          supported_languages=('en', 'fr'))
        uc = GenerateCVUseCase(config_loader=MagicMock())
        with pytest.raises(DataError, match='unsupported'):
            uc.resolve_languages('de', config)
