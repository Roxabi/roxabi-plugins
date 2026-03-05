"""Tests for web-intel domain models and exceptions."""
import pytest


def test_fetch_result_frozen():
    from domain.models import FetchResult
    r = FetchResult(success=True, content_type="twitter", url="https://x.com/test",
                    data={"text": "hello"})
    assert r.content_type == "twitter"
    assert r.data["text"] == "hello"
    with pytest.raises(AttributeError):
        r.url = "modified"


def test_fetch_result_error():
    from domain.models import FetchResult
    r = FetchResult(success=False, content_type="unknown", url="https://bad.com",
                    error="Not found")
    assert not r.success
    assert r.error == "Not found"
    assert r.data is None


def test_fetch_result_defaults():
    from domain.models import FetchResult
    r = FetchResult(success=True, content_type="webpage", url="https://example.com",
                    data={"text": "content"})
    assert r.error is None
    assert r.raw is None
    assert r.resolved_url is None


def test_web_intel_exceptions_hierarchy():
    from domain.exceptions import PluginError, WebIntelError, FetchError, ContentParseError
    assert issubclass(WebIntelError, PluginError)
    assert issubclass(FetchError, WebIntelError)
    assert issubclass(ContentParseError, WebIntelError)


def test_fetcher_port_is_abstract():
    from ports.fetcher import FetcherPort
    with pytest.raises(TypeError):
        FetcherPort()
