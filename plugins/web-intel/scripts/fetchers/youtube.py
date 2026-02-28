#!/usr/bin/env python3
"""
YouTube content extraction module.

Fetches video metadata (oEmbed) and transcript (youtube-transcript-api).

Security:
- SSRF protection via validate_url_ssrf
- Content size limits via streaming download
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Optional

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

# Optional - graceful handling if not installed
try:
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import (
        TranscriptsDisabled,
        NoTranscriptFound,
        VideoUnavailable,
    )

    TRANSCRIPT_AVAILABLE = True
except ImportError:
    TRANSCRIPT_AVAILABLE = False


def extract_video_id(url: str) -> Optional[str]:
    """Extract YouTube video ID from various URL formats."""
    return extract_id_from_url(
        url,
        [
            r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/)([a-zA-Z0-9_-]{11})",
            r"(?:youtube\.com/watch\?.*&v=)([a-zA-Z0-9_-]{11})",
        ],
    )


def fetch_metadata_oembed(
    video_id: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch video metadata via oEmbed API (no auth required).

    Args:
        video_id: YouTube video ID
        max_content_size: Maximum response size in bytes (default: 5MB)

    Returns:
        Dict with metadata or error

    Security:
        - Validates URL against SSRF attacks
        - Limits response size to prevent memory exhaustion
    """
    oembed_url = (
        f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    )

    result = safe_fetch(oembed_url, max_size=max_content_size, fetcher_name="youtube")

    if not result["success"]:
        return {"success": False, "error": result["error"]}

    status_code = result["status_code"]

    if status_code == 200:
        data = json.loads(result["content"].decode("utf-8"))
        return {
            "success": True,
            "title": data.get("title", ""),
            "author": data.get("author_name", ""),
            "author_url": data.get("author_url", ""),
            "thumbnail_url": data.get("thumbnail_url", ""),
        }
    elif status_code == 404:
        return {"success": False, "error": "Video not found"}
    else:
        return {"success": False, "error": f"HTTP {status_code}"}


def fetch_transcript(video_id: str, languages: Optional[list[str]] = None) -> dict[str, Any]:
    """Fetch transcript with timestamps."""
    if not TRANSCRIPT_AVAILABLE:
        return {
            "success": False,
            "error": "youtube-transcript-api not installed. Run: uv sync --extra youtube",
            "_do_not_cache": True,  # Don't cache missing dependency errors
        }

    languages = languages or ["en", "fr", "auto"]

    try:
        api = YouTubeTranscriptApi()

        # Try specified languages, fallback to auto-generated
        transcript = None
        transcript_lang = None

        try:
            transcript_list = api.list_transcripts(video_id)

            # Try manual transcripts first (better quality)
            for lang in languages:
                try:
                    transcript = transcript_list.find_transcript([lang]).fetch()
                    transcript_lang = lang
                    break
                except Exception:
                    continue

            # Fallback to auto-generated
            if not transcript:
                try:
                    transcript = transcript_list.find_generated_transcript(languages).fetch()
                    transcript_lang = "auto"
                except Exception:
                    pass

        except Exception:
            # Direct fetch if list fails
            transcript = api.fetch(video_id)
            transcript_lang = "unknown"

        if not transcript:
            return {"success": False, "error": "No transcript available"}

        # Format with timestamps
        # Handle both dict-like and object-like snippets (API changed in newer versions)
        lines = []
        full_text_parts = []
        last_start = 0
        for snippet in transcript:
            # Try attribute access first (newer API), then dict access (older API)
            if hasattr(snippet, "start"):
                start = int(snippet.start)
                text = str(snippet.text).strip()
            else:
                start = int(snippet.get("start", 0))
                text = snippet.get("text", "").strip()

            last_start = start
            mins, secs = divmod(start, 60)
            timestamp = f"[{mins}:{secs:02d}]"
            lines.append(f"{timestamp} {text}")
            full_text_parts.append(text)

        return {
            "success": True,
            "transcript_with_timestamps": "\n".join(lines),
            "transcript_text": " ".join(full_text_parts),
            "language": transcript_lang,
            "segments_count": len(lines),
            "duration_seconds": last_start,
        }

    except TranscriptsDisabled:
        return {"success": False, "error": "Transcripts are disabled for this video"}
    except NoTranscriptFound:
        return {"success": False, "error": "No transcript found for this video"}
    except VideoUnavailable:
        return {"success": False, "error": "Video is unavailable"}
    except Exception as e:
        return {"success": False, "error": f"Transcript error: {str(e)}"}


class YouTubeFetcher(BaseFetcher):
    """YouTube video content fetcher.

    Fetches video metadata via oEmbed API and transcript via
    youtube-transcript-api (if available).

    Example:
        >>> fetcher = YouTubeFetcher()
        >>> result = fetcher.fetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        >>> if result["success"]:
        ...     print(result["data"]["title"])
    """

    content_type = "youtube"

    def _fetch_impl(
        self,
        url: str,
        max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
    ) -> dict[str, Any]:
        """
        Core implementation: fetch YouTube video metadata and transcript.

        Returns combined data for knowledge base integration.

        Args:
            url: YouTube video URL
            max_content_size: Maximum content size in bytes (default: 5MB)

        Returns:
            Dict with video metadata, transcript, and formatted text

        Security:
            - Validates URL against SSRF attacks
            - Limits response size to prevent memory exhaustion
        """
        video_id = extract_video_id(url)
        if not video_id:
            return {"success": False, "error": "Could not extract video ID from URL"}

        # 1. Fetch metadata
        metadata = fetch_metadata_oembed(video_id, max_content_size=max_content_size)
        if not metadata.get("success"):
            return {
                "success": False,
                "type": "youtube",
                "url": url,
                "video_id": video_id,
                "error": metadata.get("error", "Metadata fetch failed"),
            }

        # 2. Fetch transcript
        transcript = fetch_transcript(video_id)

        # Build result
        result = {
            "success": True,
            "type": "youtube",
            "url": url,
            "video_id": video_id,
            "title": metadata.get("title", ""),
            "author": metadata.get("author", ""),
            "author_url": metadata.get("author_url", ""),
            "thumbnail_url": metadata.get("thumbnail_url", ""),
        }

        if transcript.get("success"):
            result["text"] = sanitize_content(transcript["transcript_with_timestamps"])
            result["transcript_text"] = sanitize_content(transcript["transcript_text"])
            result["transcript_language"] = transcript.get("language", "unknown")
            result["duration_seconds"] = transcript.get("duration_seconds", 0)
            result["segments_count"] = transcript.get("segments_count", 0)
            result["has_transcript"] = True
        else:
            # Video without transcript - still return metadata
            result["text"] = sanitize_content(
                f"Video: {metadata.get('title', 'Unknown')}\n"
                f"Author: {metadata.get('author', 'Unknown')}\n\n"
                f"[Transcript not available: {transcript.get('error', 'Unknown error')}]"
            )
            result["has_transcript"] = False
            result["transcript_error"] = transcript.get("error", "Unknown error")
            # Propagate non-cacheable flag (e.g., missing dependency)
            if transcript.get("_do_not_cache"):
                result["_do_not_cache"] = True

        return result

    def _transform_data(self, raw_result: dict[str, Any]) -> dict[str, Any]:
        """Transform raw YouTube result to standardized data dict."""
        return {
            "text": raw_result.get("text", ""),
            "transcript_text": raw_result.get("transcript_text", ""),
            "title": raw_result.get("title", ""),
            "author": raw_result.get("author", ""),
            "author_url": raw_result.get("author_url", ""),
            "thumbnail_url": raw_result.get("thumbnail_url", ""),
            "video_id": raw_result.get("video_id", ""),
            "has_transcript": raw_result.get("has_transcript", False),
            "transcript_language": raw_result.get("transcript_language", ""),
            "transcript_error": raw_result.get("transcript_error"),
            "duration_seconds": raw_result.get("duration_seconds", 0),
            "segments_count": raw_result.get("segments_count", 0),
        }


# Backward-compatible module-level function
def fetch_youtube(url: str) -> dict[str, Any]:
    """
    Fetch content from a YouTube video URL.

    Args:
        url: YouTube video URL

    Returns:
        Dict with:
        - success: bool
        - content_type: "youtube"
        - url: original URL
        - data: dict with text, title, author, has_transcript, duration_seconds, etc.
        - error: str (only if success=False)

    Example:
        >>> result = fetch_youtube("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        >>> if result["success"]:
        ...     print(result["data"]["title"])
    """
    return YouTubeFetcher().fetch(url)


def main():
    """CLI interface for testing."""
    YouTubeFetcher.run_cli()


if __name__ == "__main__":
    main()
