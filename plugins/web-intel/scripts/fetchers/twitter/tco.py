"""t.co link detection and resolution."""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path
from typing import Any, Optional

# Add paths for imports
SHARED_DIR = Path(__file__).resolve().parents[2] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parents[1]
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from resolve_redirects import resolve_redirects, is_twitter_domain

logger = logging.getLogger(__name__)


def is_tco_only_tweet(text: str) -> Optional[str]:
    """Check if tweet is primarily a t.co link share.

    Detects tweets where the main content is a t.co shortened URL,
    even if they contain hashtags, mentions, or emoji.

    Args:
        text: Tweet text content

    Returns:
        The t.co URL if tweet is primarily a link share, None otherwise
    """
    if not text:
        return None

    # Find t.co link in the text
    match = re.search(r"(https?://t\.co/\w+)", text)
    if not match:
        return None

    tco_url = match.group(1)

    # Remove the t.co URL and check what's left
    remaining = text.replace(tco_url, "").strip()

    # Remove hashtags, mentions, and common punctuation
    remaining = re.sub(r"[#@]\w+", "", remaining)  # Remove hashtags and mentions
    remaining = re.sub(
        r"[\s\u200d\ufe0f\u2764\U0001F300-\U0001F9FF]+", "", remaining
    )  # Whitespace + emoji
    remaining = re.sub(r"[.,!?:;\-–—…]+", "", remaining)  # Punctuation

    # If remaining content is minimal (< 20 chars), it's primarily a link share
    if len(remaining) < 20:
        return tco_url

    return None


def resolve_tco_link(tco_url: str, timeout: float = 10.0) -> Optional[dict[str, Any]]:
    """Resolve a t.co shortened URL to its final destination.

    Uses the shared resolve_redirects utility with SSRF protection.

    Args:
        tco_url: URL like https://t.co/abc123
        timeout: Request timeout in seconds

    Returns:
        Dict with:
        - success: bool
        - resolved_url: str (final URL after redirects)
        - is_twitter: bool (True if resolved to x.com/twitter.com)
        - error: str (only if success=False)

        Returns None if resolution fails completely.
    """
    result = resolve_redirects(tco_url, timeout=timeout)

    if not result["success"]:
        logger.warning("Failed to resolve t.co link %s: %s", tco_url, result.get("error"))
        return None

    resolved_url = result["resolved_url"]
    is_twitter = is_twitter_domain(resolved_url)

    return {
        "success": True,
        "resolved_url": resolved_url,
        "is_twitter": is_twitter,
        "was_shortened": result["was_shortened"],
    }
