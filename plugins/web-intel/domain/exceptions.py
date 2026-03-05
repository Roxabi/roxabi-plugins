"""Web-intel exception hierarchy."""


class PluginError(Exception):
    """Base exception for all Roxabi plugin errors."""


class WebIntelError(PluginError):
    """Base exception for web-intel plugin."""


class FetchError(WebIntelError):
    """Error fetching content from a URL."""
    def __init__(self, url: str, reason: str):
        self.url = url
        super().__init__(f"Failed to fetch {url}: {reason}")


class ContentParseError(WebIntelError):
    """Error parsing fetched content."""


class UnsupportedURLError(WebIntelError):
    """URL type is not supported by any fetcher."""
