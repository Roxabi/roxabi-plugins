"""Tests for cv domain models and exceptions."""
import pytest


def test_cv_config_defaults():
    from domain.models import CVConfig
    c = CVConfig(default_language="en")
    assert c.default_language == "en"
    assert c.default_format == "md"
    assert c.supported_languages == ("en",)


def test_cv_config_frozen():
    from domain.models import CVConfig
    c = CVConfig(default_language="en")
    with pytest.raises(AttributeError):
        c.default_language = "fr"


def test_cv_config_from_dict():
    from domain.models import CVConfig
    c = CVConfig.from_dict({"default_language": "fr", "supported_languages": ["fr", "en"],
                            "default_format": "html"})
    assert c.default_language == "fr"
    assert c.default_format == "html"
    assert "en" in c.supported_languages


def test_cv_config_from_dict_rejects_missing_language():
    from domain.models import CVConfig
    from domain.exceptions import ConfigError
    with pytest.raises(ConfigError):
        CVConfig.from_dict({})


def test_cv_exceptions_hierarchy():
    from domain.exceptions import PluginError, CVError, ConfigError
    assert issubclass(CVError, PluginError)
    assert issubclass(ConfigError, CVError)


def test_config_loader_is_abstract():
    from ports.config import ConfigLoader
    with pytest.raises(TypeError):
        ConfigLoader()
