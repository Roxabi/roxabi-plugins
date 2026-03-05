"""Tests for image-prompt-generator domain models and exceptions."""
import pytest


def test_visual_charter_frozen():
    from domain.models import VisualCharter
    c = VisualCharter(brand_name="Test Brand", colors={"primary": "#000"},
                      style={"mood": "minimal"})
    assert c.brand_name == "Test Brand"
    with pytest.raises(AttributeError):
        c.brand_name = "Other"


def test_visual_charter_defaults():
    from domain.models import VisualCharter
    c = VisualCharter(brand_name="Test")
    assert c.colors == {}
    assert c.style == {}
    assert c.preferences == {}


def test_visual_charter_from_dict():
    from domain.models import VisualCharter
    c = VisualCharter.from_dict({"brand_name": "Acme", "colors": {"primary": "#fff"}})
    assert c.brand_name == "Acme"
    assert c.colors["primary"] == "#fff"


def test_prompt_variant_frozen():
    from domain.models import PromptVariant
    v = PromptVariant(index=1, style="Cinematic", category="photography",
                      prompt="a sunset", lighting="golden hour", mood="dramatic",
                      colors="warm palette")
    assert v.style == "Cinematic"
    with pytest.raises(AttributeError):
        v.style = "Other"


def test_image_prompt_exceptions_hierarchy():
    from domain.exceptions import PluginError, ImagePromptError, ConfigError
    assert issubclass(ImagePromptError, PluginError)
    assert issubclass(ConfigError, ImagePromptError)
