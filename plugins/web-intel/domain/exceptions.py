"""Web-intel exception hierarchy."""


class PluginError(Exception):
    """Base exception for all Roxabi plugin errors."""


class WebIntelError(PluginError):
    """Base exception for web-intel plugin."""


class FetchError(WebIntelError):
    """Error fetching content from a URL."""
    def __init__(self, url: str, reason: str):
        self.url = _sanitize_url(url)
        super().__init__(f"Failed to fetch {self.url}: {reason}")


def _sanitize_url(url: str) -> str:
    """Strip query parameters and fragments to avoid leaking secrets in logs."""
    from urllib.parse import urlsplit, urlunsplit
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, '', ''))


class ContentParseError(WebIntelError):
    """Error parsing fetched content."""


class UnsupportedURLError(WebIntelError):
    """URL type is not supported by any fetcher."""
