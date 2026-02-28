"""Twitter/X content extraction package.

Re-exports the public API: fetch_twitter() and TwitterFetcher.
"""

from twitter.fetcher import TwitterFetcher, fetch_twitter

__all__ = ["TwitterFetcher", "fetch_twitter"]
