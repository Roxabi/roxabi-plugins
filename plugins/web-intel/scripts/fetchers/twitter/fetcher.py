#!/usr/bin/env python3
"""
Twitter/X content extraction — main fetcher and CLI.

Supports:
- Regular tweets via cdn.syndication.twimg.com
- Note tweets (long tweets > 280 chars) via FxTwitter API fallback
- X Articles via Playwright (headless browser)

Security:
- SSRF protection via validate_url_ssrf
- Content size limits via fetch_with_size_limit
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any, Optional

# Add paths for imports (needed when running as script or from tests)
SHARED_DIR = Path(__file__).resolve().parents[2] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parents[1]
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import BaseFetcher, DEFAULT_MAX_CONTENT_SIZE, extract_id_from_url
from twitter.tweets import fetch_tweet_syndication, fetch_tweet_fxtwitter
from twitter.threads import fetch_thread_reconstruction
from twitter.articles import fetch_article
from twitter.tco import is_tco_only_tweet, resolve_tco_link

logger = logging.getLogger(__name__)


def extract_tweet_id(url: str) -> Optional[str]:
    """Extract tweet ID from various Twitter/X URL formats."""
    # Clean URL
    url = url.split("?")[0]

    return extract_id_from_url(
        url,
        [
            r"/status/(\d+)",
            r"/i/article/(\d+)",
        ],
    )


def is_article_url(url: str) -> bool:
    """Check if URL is an X Article."""
    return "/i/article/" in url


class TwitterFetcher(BaseFetcher):
    """Twitter/X content fetcher.

    Supports regular tweets, note tweets (> 280 chars), and X Articles.
    Uses multiple APIs for best content extraction.

    Example:
        >>> fetcher = TwitterFetcher()
        >>> result = fetcher.fetch("https://x.com/user/status/123")
        >>> if result["success"]:
        ...     print(result["data"]["text"])
    """

    content_type = "twitter"

    def _fetch_impl(
        self,
        url: str,
        max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
    ) -> dict:
        """
        Core implementation: fetch content from any Twitter/X URL.

        Automatically detects if URL is a tweet or article and uses
        the appropriate method.

        Args:
            url: Twitter/X URL to fetch
            max_content_size: Maximum content size in bytes (default: 5MB)

        Returns:
            Dict with content data or error

        Security:
            - Validates URL against SSRF attacks
            - Limits response size to prevent memory exhaustion
        """
        # Normalize URL
        url = url.replace("twitter.com", "x.com")

        # Check if it's an article
        if is_article_url(url):
            article_id = extract_tweet_id(url)
            if not article_id:
                return {"success": False, "error": "Could not extract article ID from URL"}
            article_res = fetch_article(article_id)
            return (
                article_res if article_res else {"success": False, "error": "Article fetch failed"}
            )

        # Regular tweet
        tweet_id = extract_tweet_id(url)
        if not tweet_id:
            return {"success": False, "error": "Could not extract tweet ID from URL"}

        # Try syndication API first
        result = fetch_tweet_syndication(tweet_id, max_content_size=max_content_size)

        # If syndication fails with 404, it might be an article linked from a tweet
        # Try to fetch as article
        if not result.get("success") and "not found" in result.get("error", "").lower():
            # The tweet might contain an article link - try article extraction
            article_result = fetch_article(tweet_id)
            if article_result and article_result.get("success"):
                return article_result

        # If syndication succeeded but tweet is a note tweet (> 280 chars, truncated),
        # use FxTwitter to get the full text
        if result.get("success") and result.get("is_note_tweet"):
            logger.info("Note tweet detected (id=%s), fetching full text via FxTwitter", tweet_id)
            fx_result = fetch_tweet_fxtwitter(tweet_id, max_content_size=max_content_size)
            if fx_result.get("success"):
                return fx_result
            logger.warning(
                "FxTwitter fallback failed: %s, using truncated syndication text",
                fx_result.get("error"),
            )

        # Check if tweet is part of a self-thread (reply to same author)
        if result.get("success") and result.get("in_reply_to_status_id"):
            parent_id = str(result.get("in_reply_to_status_id"))
            tweet_author = result.get("author", "")

            # Fetch parent to check if it's a self-thread
            parent_result = fetch_tweet_syndication(parent_id, max_content_size=max_content_size)
            parent_author = parent_result.get("author", "") if parent_result.get("success") else ""

            if parent_author.lower() == tweet_author.lower():
                # Self-thread detected, reconstruct
                logger.info(
                    "Tweet %s is a self-thread (same author: %s), reconstructing",
                    tweet_id,
                    tweet_author,
                )
                thread_result = fetch_thread_reconstruction(
                    tweet_id,
                    thread_author=tweet_author,
                    max_content_size=max_content_size,
                )
                if thread_result.get("success") and thread_result.get("type") == "thread":
                    return thread_result
                # If thread reconstruction failed or returned single tweet, continue with original
            else:
                logger.info(
                    "Tweet %s is a reply to %s (different author: %s), not a self-thread",
                    tweet_id,
                    parent_id,
                    parent_author,
                )

        # Check if tweet is primarily sharing a link (t.co)
        if result.get("success"):
            tco_url = is_tco_only_tweet(result.get("text", ""))
            if tco_url:
                logger.info("Tweet is primarily a t.co link share, resolving: %s", tco_url)
                resolved = resolve_tco_link(tco_url)

                if resolved and resolved.get("success"):
                    resolved_url = resolved["resolved_url"]

                    # Case 1: t.co → Twitter Article
                    if resolved.get("is_twitter") and is_article_url(resolved_url):
                        logger.info("t.co resolved to X Article: %s", resolved_url)
                        article_id = extract_tweet_id(resolved_url)
                        if article_id:
                            article_result = fetch_article(article_id)
                            if article_result and article_result.get("success"):
                                # Add reference to original tweet
                                article_result["shared_via_tweet"] = url
                                return article_result
                            # Article fetch failed — propagate error instead of
                            # returning useless tweet with only t.co URL
                            if article_result:
                                article_result["shared_via_tweet"] = url
                                return article_result
                            return {
                                "success": False,
                                "error": "Article fetch failed",
                                "shared_via_tweet": url,
                            }

                    # Case 2: t.co → Another Twitter/X URL (not article)
                    elif resolved.get("is_twitter"):
                        logger.info(
                            "t.co resolved to Twitter URL (not article): %s, returning redirect",
                            resolved_url,
                        )
                        return {
                            "success": True,
                            "redirect": True,
                            "resolved_url": resolved_url,
                            "original_tweet_url": url,
                            "original_tweet_text": result.get("text", ""),
                            "original_tweet_author": result.get("author", ""),
                            "_do_not_cache": True,  # Don't cache redirects to Twitter
                        }

                    # Case 3: t.co → External URL
                    else:
                        logger.info(
                            "t.co resolved to external domain: %s, returning redirect",
                            resolved_url,
                        )
                        return {
                            "success": True,
                            "redirect": True,
                            "resolved_url": resolved_url,
                            "original_tweet_url": url,
                            "original_tweet_text": result.get("text", ""),
                            "original_tweet_author": result.get("author", ""),
                        }

                # t.co resolution failed - don't cache incomplete result
                result["_do_not_cache"] = True
                logger.info("Tweet is t.co-only but resolution failed, marking as non-cacheable")

        return result

    def _transform_data(self, raw_result: dict[str, Any]) -> dict[str, Any]:
        """Transform raw Twitter result to standardized data dict."""
        text = raw_result.get("text", "")
        author = raw_result.get("author", "")
        author_name = raw_result.get("author_name", "")
        title = raw_result.get("title", "")
        tweet_type = raw_result.get("type", "tweet")

        # Build formatted text for easy consumption
        formatted_text = text
        if author or author_name:
            type_label = tweet_type
            if tweet_type == "thread":
                type_label = f"thread ({raw_result.get('thread_size', 1)} tweets)"
            formatted_text = f"Auteur: {author} ({author_name})\nType: {type_label}\nTitre: {title}\n\nContenu:\n{text}"

        result = {
            "text": formatted_text,
            "raw_text": text,
            "author": author,
            "author_name": author_name,
            "title": title,
            "type": tweet_type,
            "created_at": raw_result.get("created_at", ""),
            "likes": raw_result.get("likes", 0),
            "retweets": raw_result.get("retweets", 0),
            "media": raw_result.get("media", []),
            "is_note_tweet": raw_result.get("is_note_tweet", False),
        }

        # Add thread-specific fields
        if tweet_type == "thread":
            result["thread_size"] = raw_result.get("thread_size", 1)
            result["tweets"] = raw_result.get("tweets", [])
            result["first_tweet_id"] = raw_result.get("first_tweet_id", "")

        return result


# Backward-compatible module-level function
def fetch_twitter(url: str) -> dict[str, Any]:
    """
    Fetch content from a Twitter/X URL.

    Args:
        url: Twitter/X URL (tweet, article, or note)

    Returns:
        Dict with:
        - success: bool
        - content_type: "twitter"
        - url: original URL
        - data: dict with text, author, author_name, title, type, created_at
        - error: str (only if success=False)

    Example:
        >>> result = fetch_twitter("https://x.com/user/status/123")
        >>> if result["success"]:
        ...     print(result["data"]["text"])
    """
    return TwitterFetcher().fetch(url)


def main():
    """CLI interface for testing."""
    TwitterFetcher.run_cli()


if __name__ == "__main__":
    main()
