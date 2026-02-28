#!/usr/bin/env python3
"""
Reddit content extraction module.

Fetches post content and top comments via Reddit's native JSON API.
No authentication required.

Security:
- SSRF protection via validate_url_ssrf
- Content size limits via streaming download
"""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx

# Add paths for imports (needed when running as script or from tests)
SHARED_DIR = Path(__file__).resolve().parents[1] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parent
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import (
    BaseFetcher,
    DEFAULT_MAX_CONTENT_SIZE,
    sanitize_content,
    safe_fetch,
    extract_id_from_url,
)

logger = logging.getLogger(__name__)

# Custom User-Agent (Reddit requires one)
USER_AGENT = "Mozilla/5.0 (compatible; RoxabiWebIntel/1.0; +https://github.com/Roxabi)"

# Pattern for Reddit share links: /r/subreddit/s/CODE
REDDIT_SHARE_LINK_RE = re.compile(r"/r/[^/]+/s/[a-zA-Z0-9]+$")


def resolve_reddit_share_link(url: str) -> str:
    """Resolve a Reddit share link (/r/sub/s/CODE) to the actual post URL.

    Reddit share links redirect to the real post URL with /comments/.
    Returns the original URL if resolution fails.
    """
    try:
        with httpx.Client(
            follow_redirects=True,
            max_redirects=5,
            timeout=10.0,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            response = client.head(url)
            resolved = str(response.url)
            if "/comments/" in resolved:
                logger.debug("Resolved Reddit share link: %s -> %s", url, resolved)
                return resolved
    except Exception as e:
        logger.warning("Failed to resolve Reddit share link %s: %s", url, e)
    return url


def normalize_reddit_url(url: str) -> str:
    """Normalize Reddit URL for JSON API call."""
    # Remove trailing slash and query params
    url = url.split("?")[0].rstrip("/")

    # Handle old.reddit.com and www.reddit.com
    url = url.replace("old.reddit.com", "reddit.com")
    url = url.replace("www.reddit.com", "reddit.com")

    # Handle redd.it short links
    match = re.search(r"redd\.it/([a-zA-Z0-9]+)", url)
    if match:
        post_id = match.group(1)
        url = f"https://reddit.com/comments/{post_id}"

    # Ensure https
    if not url.startswith("https://"):
        url = "https://" + url.lstrip("http://")

    return url


def extract_post_id(url: str) -> Optional[str]:
    """Extract Reddit post ID from URL."""
    # Pattern: /comments/POST_ID/ or /r/sub/comments/POST_ID/
    return extract_id_from_url(url, [r"/comments/([a-zA-Z0-9]+)"])


def extract_comment_id(url: str) -> Optional[str]:
    """Extract specific comment ID if URL points to a comment."""
    # Pattern: /comments/postid/title/COMMENT_ID
    # The comment ID is the last segment after the title slug
    return extract_id_from_url(url, [r"/comments/[a-zA-Z0-9]+/[^/]+/([a-zA-Z0-9]+)"])


def fetch_reddit_json(
    url: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch Reddit JSON data.

    Args:
        url: Reddit post URL (without .json suffix)
        max_content_size: Maximum response size in bytes (default: 5MB)

    Returns:
        Dict with 'success' and either 'data' or 'error'

    Security:
        - Validates URL against SSRF attacks via safe_fetch
        - Limits response size to prevent memory exhaustion
    """
    json_url = f"{url}.json"

    result = safe_fetch(
        json_url,
        headers={"User-Agent": USER_AGENT},
        max_size=max_content_size,
        fetcher_name="reddit",
    )

    if not result["success"]:
        return {"success": False, "error": result["error"]}

    status_code = result["status_code"]

    if status_code == 200:
        data = json.loads(result["content"].decode("utf-8"))
        return {"success": True, "data": data}
    elif status_code == 404:
        return {"success": False, "error": "Post not found or deleted"}
    elif status_code == 403:
        return {"success": False, "error": "Subreddit is private or quarantined"}
    elif status_code == 429:
        return {"success": False, "error": "Rate limited by Reddit"}
    else:
        return {"success": False, "error": f"HTTP {status_code}"}


def format_timestamp(utc_timestamp: float) -> str:
    """Format Unix timestamp to ISO format."""
    if not utc_timestamp:
        return ""
    try:
        dt = datetime.fromtimestamp(utc_timestamp, tz=timezone.utc)
        return dt.isoformat()
    except Exception:
        return ""


def extract_post_content(post_data: dict[str, Any]) -> dict[str, Any]:
    """Extract post content from Reddit JSON."""
    return {
        "id": post_data.get("id", ""),
        "title": post_data.get("title", ""),
        "author": post_data.get("author", "[deleted]"),
        "selftext": post_data.get("selftext", ""),  # Text content for self posts
        "url": post_data.get("url", ""),  # External URL for link posts
        "subreddit": post_data.get("subreddit", ""),
        "score": post_data.get("score", 0),
        "upvote_ratio": post_data.get("upvote_ratio", 0),
        "num_comments": post_data.get("num_comments", 0),
        "created_utc": format_timestamp(post_data.get("created_utc", 0.0)),
        "is_self": post_data.get("is_self", False),
        "is_video": post_data.get("is_video", False),
        "permalink": f"https://reddit.com{post_data.get('permalink', '')}",
        "flair": post_data.get("link_flair_text", ""),
    }


def extract_comments(
    comments_data: list[dict[str, Any]],
    max_comments: int = 15,
    max_depth: int = 2,
) -> list[dict[str, Any]]:
    """Extract top comments with limited depth."""
    comments: list[dict[str, Any]] = []

    def extract_comment(item: dict[str, Any], depth: int = 0) -> Optional[dict[str, Any]]:
        if item.get("kind") != "t1":  # Not a comment
            return None

        data = item.get("data", {})

        comment = {
            "id": data.get("id", ""),
            "author": data.get("author", "[deleted]"),
            "body": sanitize_content(data.get("body", "")),
            "score": data.get("score", 0),
            "created_utc": format_timestamp(data.get("created_utc")),
            "depth": depth,
            "is_op": data.get("is_submitter", False),
        }

        # Extract replies (limited depth)
        replies = []
        if depth < max_depth:
            replies_data = data.get("replies")
            if isinstance(replies_data, dict):
                children = replies_data.get("data", {}).get("children", [])
                for child in children[:3]:  # Max 3 replies per comment
                    reply = extract_comment(child, depth + 1)
                    if reply:
                        replies.append(reply)

        if replies:
            comment["replies"] = replies

        return comment

    for item in comments_data:
        if len(comments) >= max_comments:
            break
        comment = extract_comment(item, depth=0)
        if comment:
            comments.append(comment)

    return comments


def format_comments_text(comments: list[dict[str, Any]], indent: str = "") -> str:
    """Format comments as readable text."""
    lines = []

    for c in comments:
        author = c.get("author", "[deleted]")
        score = c.get("score", 0)
        body = c.get("body", "").strip()
        is_op = " [OP]" if c.get("is_op") else ""

        lines.append(f"{indent}> **{author}**{is_op} ({score} points)")
        # Indent body
        for line in body.split("\n"):
            lines.append(f"{indent}> {line}")
        lines.append("")

        # Format replies
        if c.get("replies"):
            lines.append(format_comments_text(c["replies"], indent + "  "))

    return "\n".join(lines)


class RedditFetcher(BaseFetcher):
    """Reddit post and comments fetcher.

    Fetches post content and top comments via Reddit's native JSON API.
    No authentication required.

    Example:
        >>> fetcher = RedditFetcher()
        >>> result = fetcher.fetch("https://reddit.com/r/Python/comments/abc123/title/")
        >>> if result["success"]:
        ...     print(result["data"]["subreddit"])
    """

    content_type = "reddit"

    def _fetch_impl(
        self,
        url: str,
        max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
    ) -> dict[str, Any]:
        """
        Core implementation: fetch Reddit post and comments.

        Returns combined data for knowledge base integration.

        Args:
            url: Reddit post URL
            max_content_size: Maximum content size in bytes (default: 5MB)

        Returns:
            Dict with post data, comments, and formatted text

        Security:
            - Validates URL against SSRF attacks
            - Limits response size to prevent memory exhaustion
        """
        # Normalize URL
        normalized_url = normalize_reddit_url(url)
        post_id = extract_post_id(normalized_url)
        target_comment_id = extract_comment_id(url)

        # Handle Reddit share links (/r/sub/s/CODE) by resolving redirect
        if not post_id and REDDIT_SHARE_LINK_RE.search(normalized_url):
            resolved_url = resolve_reddit_share_link(url)
            normalized_url = normalize_reddit_url(resolved_url)
            post_id = extract_post_id(normalized_url)
            target_comment_id = extract_comment_id(resolved_url)

        if not post_id:
            return {"success": False, "error": "Could not extract post ID from URL"}

        # Fetch JSON
        result = fetch_reddit_json(normalized_url, max_content_size=max_content_size)
        if not result.get("success"):
            return {
                "success": False,
                "type": "reddit",
                "url": url,
                "error": result.get("error", "Fetch failed"),
            }

        data = result["data"]

        # Reddit returns [post_listing, comments_listing]
        if not isinstance(data, list) or len(data) < 2:
            return {
                "success": False,
                "type": "reddit",
                "url": url,
                "error": "Unexpected Reddit API response format",
            }

        # Extract post
        post_listing = data[0].get("data", {}).get("children", [])
        if not post_listing:
            return {
                "success": False,
                "type": "reddit",
                "url": url,
                "error": "No post data found",
            }

        post_raw = post_listing[0].get("data", {})
        post = extract_post_content(post_raw)

        # Extract comments
        comments_listing = data[1].get("data", {}).get("children", [])
        comments = extract_comments(comments_listing)

        # Build formatted text
        text_parts = [
            f"# {post['title']}",
            "",
            f"**Subreddit:** r/{post['subreddit']}",
            f"**Author:** u/{post['author']}",
            f"**Score:** {post['score']} ({int(post['upvote_ratio'] * 100)}% upvoted)",
            f"**Comments:** {post['num_comments']}",
            f"**Date:** {post['created_utc'][:10] if post['created_utc'] else 'Unknown'}",
            "",
        ]

        if post.get("flair"):
            text_parts.append(f"**Flair:** {post['flair']}")
            text_parts.append("")

        # Post content
        if post["is_self"] and post["selftext"]:
            text_parts.append("## Post Content")
            text_parts.append("")
            text_parts.append(sanitize_content(post["selftext"]))
            text_parts.append("")
        elif not post["is_self"]:
            text_parts.append(f"**Link:** {post['url']}")
            text_parts.append("")

        # Comments
        if comments:
            text_parts.append(f"## Top Comments ({len(comments)})")
            text_parts.append("")
            text_parts.append(format_comments_text(comments))

        # Build result
        content_type = "reddit_post"
        if target_comment_id:
            content_type = "reddit_comment"

        return {
            "success": True,
            "type": content_type,
            "url": url,
            "post_id": post_id,
            "title": post["title"],
            "author": f"u/{post['author']}",
            "subreddit": f"r/{post['subreddit']}",
            "text": sanitize_content("\n".join(text_parts)),
            "selftext": sanitize_content(post["selftext"]),
            "created_at": post["created_utc"],
            "score": post["score"],
            "num_comments": post["num_comments"],
            "upvote_ratio": post["upvote_ratio"],
            "is_self": post["is_self"],
            "external_url": post["url"] if not post["is_self"] else None,
            "comments_count": len(comments),
            "comments": comments,
            "target_comment_id": target_comment_id,
            "metadata": {
                "flair": post.get("flair"),
                "is_video": post.get("is_video"),
                "permalink": post["permalink"],
            },
        }

    def _transform_data(self, raw_result: dict[str, Any]) -> dict[str, Any]:
        """Transform raw Reddit result to standardized data dict."""
        return {
            "text": raw_result.get("text", ""),
            "selftext": raw_result.get("selftext", ""),
            "title": raw_result.get("title", ""),
            "author": raw_result.get("author", ""),
            "subreddit": raw_result.get("subreddit", ""),
            "score": raw_result.get("score", 0),
            "upvote_ratio": raw_result.get("upvote_ratio", 0),
            "num_comments": raw_result.get("num_comments", 0),
            "created_at": raw_result.get("created_at", ""),
            "is_self": raw_result.get("is_self", False),
            "external_url": raw_result.get("external_url"),
            "post_id": raw_result.get("post_id", ""),
            "comments_count": raw_result.get("comments_count", 0),
            "comments": raw_result.get("comments", []),
            "metadata": raw_result.get("metadata", {}),
        }


# Backward-compatible module-level function
def fetch_reddit(url: str) -> dict[str, Any]:
    """
    Fetch content from a Reddit post URL.

    Args:
        url: Reddit post or comment URL

    Returns:
        Dict with:
        - success: bool
        - content_type: "reddit"
        - url: original URL
        - data: dict with text, title, author, subreddit, score, num_comments, etc.
        - error: str (only if success=False)

    Example:
        >>> result = fetch_reddit("https://www.reddit.com/r/Python/comments/abc123/title/")
        >>> if result["success"]:
        ...     print(result["data"]["subreddit"])
    """
    return RedditFetcher().fetch(url)


def main():
    """CLI interface for testing."""
    RedditFetcher.run_cli()


if __name__ == "__main__":
    main()
