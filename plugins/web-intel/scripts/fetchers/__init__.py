"""
Content fetchers for different URL types.

Each fetcher returns a dict with:
- success: bool
- content_type: str (platform identifier)
- url: str (original URL)
- data: dict with type-specific fields (on success)
- error: str (on failure)

All fetchers inherit from BaseFetcher and provide both:
- Module-level functions (e.g., fetch_twitter(url)) for backward compatibility
- Class-based API (e.g., TwitterFetcher().fetch(url)) for new code
"""

import sys
from pathlib import Path

# Add paths for imports (needed when running as script or from tests)
SHARED_DIR = Path(__file__).resolve().parents[1] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parent
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import BaseFetcher, FetchFunction
from twitter import fetch_twitter, TwitterFetcher
from github import fetch_github, GitHubFetcher
from gist import fetch_gist, GistFetcher
from youtube import fetch_youtube, YouTubeFetcher
from reddit import fetch_reddit, RedditFetcher
from generic import fetch_generic, GenericWebFetcher

__all__ = [
    # Base class
    "BaseFetcher",
    "FetchFunction",
    # Module-level functions (backward compatible)
    "fetch_twitter",
    "fetch_github",
    "fetch_gist",
    "fetch_youtube",
    "fetch_reddit",
    "fetch_generic",
    # Class-based fetchers
    "TwitterFetcher",
    "GitHubFetcher",
    "GistFetcher",
    "YouTubeFetcher",
    "RedditFetcher",
    "GenericWebFetcher",
]
