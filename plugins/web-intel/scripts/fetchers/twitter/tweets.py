"""Tweet fetching via syndication and FxTwitter APIs."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Add paths for imports
SHARED_DIR = Path(__file__).resolve().parents[2] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parents[1]
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import DEFAULT_MAX_CONTENT_SIZE, sanitize_content, safe_fetch


def fetch_tweet_syndication(
    tweet_id: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch tweet data via syndication API.

    Args:
        tweet_id: Twitter/X tweet ID
        max_content_size: Maximum response size in bytes (default: 5MB)

    Returns:
        Dict with tweet data or error
    """
    url = f"https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&token=1"

    result = safe_fetch(url, max_size=max_content_size, fetcher_name="twitter")

    if not result["success"]:
        return {"success": False, "error": result["error"]}

    status_code = result["status_code"]

    if status_code == 200:
        data = json.loads(result["content"].decode("utf-8"))
        is_note_tweet = "note_tweet" in data

        # Extract in_reply_to for thread reconstruction
        in_reply_to = data.get("in_reply_to_status_id_str") or data.get("in_reply_to_status_id")
        parent_data = data.get("parent", {})
        if not in_reply_to and parent_data:
            in_reply_to = parent_data.get("id_str")

        return {
            "success": True,
            "type": "tweet",
            "id": tweet_id,
            "text": sanitize_content(data.get("text", "")),
            "author": f"@{data.get('user', {}).get('screen_name', 'unknown')}",
            "author_name": data.get("user", {}).get("name", ""),
            "created_at": data.get("created_at", ""),
            "likes": data.get("favorite_count", 0),
            "retweets": data.get("conversation_count", 0),
            "media": [m.get("media_url_https") for m in data.get("mediaDetails", [])],
            "is_note_tweet": is_note_tweet,
            "in_reply_to_status_id": in_reply_to,
        }
    elif status_code == 404:
        return {"success": False, "error": "Tweet not found or is an article"}
    else:
        return {"success": False, "error": f"HTTP {status_code}"}


def fetch_tweet_fxtwitter(
    tweet_id: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch full tweet data via FxTwitter API.

    FxTwitter returns the complete text for note tweets (> 280 chars)
    that the syndication API truncates.

    Args:
        tweet_id: Twitter/X tweet ID
        max_content_size: Maximum response size in bytes

    Returns:
        Dict with tweet data or error
    """
    url = f"https://api.fxtwitter.com/status/{tweet_id}"

    result = safe_fetch(
        url,
        headers={"User-Agent": "RoxabiWebIntel/1.0"},
        max_size=max_content_size,
        fetcher_name="twitter",
    )

    if not result["success"]:
        return {"success": False, "error": f"FxTwitter: {result['error']}"}

    if result["status_code"] != 200:
        return {"success": False, "error": f"FxTwitter HTTP {result['status_code']}"}

    try:
        data = json.loads(result["content"].decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return {"success": False, "error": f"FxTwitter parse error: {e}"}

    tweet = data.get("tweet")
    if not tweet:
        return {"success": False, "error": "FxTwitter: no tweet data in response"}

    author = tweet.get("author", {})
    return {
        "success": True,
        "type": "tweet",
        "id": tweet_id,
        "text": sanitize_content(tweet.get("text", "")),
        "author": f"@{author.get('screen_name', 'unknown')}",
        "author_name": author.get("name", ""),
        "created_at": tweet.get("created_at", ""),
        "likes": tweet.get("likes", 0),
        "retweets": tweet.get("retweets", 0),
        "media": [p.get("url", "") for p in (tweet.get("media", {}) or {}).get("photos", [])],
        "is_note_tweet": tweet.get("is_note_tweet", False),
    }
