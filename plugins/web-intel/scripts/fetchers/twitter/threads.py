"""Thread fetching and reconstruction."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Optional

# Add paths for imports
SHARED_DIR = Path(__file__).resolve().parents[2] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parents[1]
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import DEFAULT_MAX_CONTENT_SIZE, sanitize_content, safe_fetch
from twitter.tweets import fetch_tweet_syndication

logger = logging.getLogger(__name__)


def fetch_thread_fxtwitter(
    tweet_id: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> Optional[dict[str, Any]]:
    """Fetch full thread via FxTwitter API.

    FxTwitter provides a thread endpoint that returns the full conversation.

    Args:
        tweet_id: Any tweet ID in the thread
        max_content_size: Maximum response size in bytes

    Returns:
        Dict with thread data or None if failed
    """
    url = f"https://api.fxtwitter.com/status/{tweet_id}"

    result = safe_fetch(
        url,
        headers={"User-Agent": "RoxabiWebIntel/1.0"},
        max_size=max_content_size,
        fetcher_name="twitter",
    )

    if not result["success"] or result["status_code"] != 200:
        return None

    try:
        data = json.loads(result["content"].decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None

    tweet = data.get("tweet")
    if not tweet:
        return None

    # Check if FxTwitter returned thread info
    thread_tweets = tweet.get("thread", [])
    if not thread_tweets:
        return None

    # Build thread from FxTwitter data
    tweets = []
    author = tweet.get("author", {})
    thread_author = f"@{author.get('screen_name', 'unknown')}"

    for t in thread_tweets:
        t_author = t.get("author", {})
        tweets.append(
            {
                "success": True,
                "type": "tweet",
                "id": t.get("id", ""),
                "text": sanitize_content(t.get("text", "")),
                "author": f"@{t_author.get('screen_name', 'unknown')}",
                "author_name": t_author.get("name", ""),
                "created_at": t.get("created_at", ""),
                "likes": t.get("likes", 0),
                "retweets": t.get("retweets", 0),
            }
        )

    if len(tweets) < 2:
        return None

    # Build combined thread result
    first_tweet = tweets[0]
    combined_text = "\n\n---\n\n".join(
        f"[{i + 1}/{len(tweets)}] {t.get('text', '')}" for i, t in enumerate(tweets)
    )

    return {
        "success": True,
        "type": "thread",
        "thread_size": len(tweets),
        "tweets": tweets,
        "text": sanitize_content(combined_text),
        "author": thread_author,
        "author_name": author.get("name", ""),
        "created_at": first_tweet.get("created_at", ""),
        "id": tweet_id,
        "first_tweet_id": first_tweet.get("id", ""),
    }


def fetch_thread_reconstruction(
    tweet_id: str,
    thread_author: str,
    max_depth: int = 20,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Reconstruct a Twitter thread by traversing in both directions.

    First traverses upward (via in_reply_to) to find the thread root,
    then collects all tweets from the same author.

    Args:
        tweet_id: Starting tweet ID (any position in thread)
        thread_author: Author handle (e.g., "@user") - only includes tweets from this author
        max_depth: Maximum number of tweets to fetch (default: 20)
        max_content_size: Maximum content size per request

    Returns:
        Dict with:
        - success: bool
        - type: "thread" if multiple tweets, "tweet" if single
        - thread_size: number of tweets in thread
        - tweets: list of tweet dicts in chronological order
        - text: combined text of all tweets (separated by newlines)
        - author: thread author (from first tweet)
        - error: str (only if success=False)

    Note:
        This makes N API calls for N tweets in the thread (~500ms each).
        Only includes tweets from the same author (self-thread).
        Deleted tweets in the chain will stop reconstruction.
    """
    # Try FxTwitter first for full thread support
    fx_thread = fetch_thread_fxtwitter(tweet_id, max_content_size)
    if fx_thread:
        logger.info("Got full thread from FxTwitter API")
        return fx_thread

    # Fallback: manual traversal upward
    logger.info("FxTwitter thread not available, traversing upward manually")

    tweets: list[dict[str, Any]] = []
    current_id: Optional[str] = tweet_id
    seen_ids: set[str] = set()

    while current_id and len(tweets) < max_depth:
        # Prevent infinite loops
        if current_id in seen_ids:
            logger.warning("Thread loop detected at tweet %s", current_id)
            break
        seen_ids.add(current_id)

        # Fetch current tweet
        result = fetch_tweet_syndication(current_id, max_content_size=max_content_size)
        if not result.get("success"):
            logger.warning(
                "Failed to fetch tweet %s in thread: %s", current_id, result.get("error")
            )
            break

        # Check if this tweet is from the same author
        tweet_author = result.get("author", "")
        if tweet_author.lower() != thread_author.lower():
            logger.info(
                "Tweet %s is from %s, not %s - stopping thread reconstruction",
                current_id,
                tweet_author,
                thread_author,
            )
            break

        # Insert at beginning for chronological order
        tweets.insert(0, result)

        # Get parent tweet ID
        current_id = result.get("in_reply_to_status_id")
        if current_id:
            current_id = str(current_id)

    if not tweets:
        return {"success": False, "error": "No tweets found in thread"}

    # If only one tweet, return as regular tweet
    if len(tweets) == 1:
        return tweets[0]

    # Build combined thread result
    first_tweet = tweets[0]
    combined_text = "\n\n---\n\n".join(
        f"[{i + 1}/{len(tweets)}] {t.get('text', '')}" for i, t in enumerate(tweets)
    )

    return {
        "success": True,
        "type": "thread",
        "thread_size": len(tweets),
        "tweets": tweets,
        "text": sanitize_content(combined_text),
        "author": first_tweet.get("author", ""),
        "author_name": first_tweet.get("author_name", ""),
        "created_at": first_tweet.get("created_at", ""),
        "id": tweet_id,  # Original requested tweet ID
        "first_tweet_id": first_tweet.get("id", ""),
    }
