#!/usr/bin/env python3
"""
YouTube content extraction module.

Primary: yt-dlp for rich metadata + subtitles.
Fallback: oEmbed (metadata) + youtube-transcript-api (transcript).

Security:
- SSRF protection via validate_url_ssrf
- Content size limits via streaming download
"""

from __future__ import annotations

import json
import re
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

# Optional — yt-dlp (preferred, rich metadata + subtitles)
try:
    import yt_dlp

    YTDLP_AVAILABLE = True
except ImportError:
    YTDLP_AVAILABLE = False

# Optional — youtube-transcript-api (fallback transcript source)
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


# ---------------------------------------------------------------------------
# yt-dlp layer (primary)
# ---------------------------------------------------------------------------

def fetch_metadata_ytdlp(video_id: str) -> dict[str, Any]:
    """Fetch rich video metadata via yt-dlp (no video download).

    Returns title, author, description, view/like counts, upload date,
    duration, tags, categories, chapters, and raw subtitle maps.
    """
    if not YTDLP_AVAILABLE:
        return {"success": False, "error": "yt-dlp not installed. Run: uv sync --extra youtube"}

    url = f"https://www.youtube.com/watch?v={video_id}"
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        # Request subtitle info without downloading files
        "listsubtitles": False,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        upload_date = info.get("upload_date", "")  # YYYYMMDD
        if upload_date and len(upload_date) == 8:
            upload_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"

        return {
            "success": True,
            "title": info.get("title", ""),
            "author": info.get("uploader") or info.get("channel", ""),
            "author_url": info.get("channel_url") or info.get("uploader_url", ""),
            "thumbnail_url": info.get("thumbnail", ""),
            "description": (info.get("description") or "")[:2000],  # cap at 2 000 chars
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
            "upload_date": upload_date,
            "duration": info.get("duration"),  # seconds (int)
            "tags": info.get("tags") or [],
            "categories": info.get("categories") or [],
            "chapters": info.get("chapters"),  # list[{start_time, end_time, title}] | None
            # Raw subtitle maps — consumed by fetch_transcript_ytdlp, then dropped
            "_subtitles": info.get("subtitles") or {},
            "_automatic_captions": info.get("automatic_captions") or {},
        }
    except Exception as e:
        return {"success": False, "error": f"yt-dlp error: {e}"}


def fetch_transcript_ytdlp(
    subtitles: dict[str, Any],
    automatic_captions: dict[str, Any],
    languages: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Extract transcript from yt-dlp subtitle info (no extra API call).

    Tries manual subtitles before auto-generated captions.
    Prefers json3 format, falls back to vtt.
    """
    import requests  # already a core dep

    languages = languages or ["en", "fr"]

    for sub_dict, sub_type in [(subtitles, "manual"), (automatic_captions, "auto")]:
        for lang in languages:
            if lang not in sub_dict:
                continue
            formats = sub_dict[lang]
            for fmt_pref in ("json3", "vtt"):
                for fmt in formats:
                    if fmt.get("ext") != fmt_pref:
                        continue
                    sub_url = fmt.get("url")
                    if not sub_url:
                        continue
                    try:
                        resp = requests.get(sub_url, timeout=15)
                        resp.raise_for_status()
                    except Exception:
                        continue

                    parsed = (
                        _parse_json3(resp.text)
                        if fmt_pref == "json3"
                        else _parse_vtt(resp.text)
                    )
                    if parsed["success"]:
                        parsed["language"] = lang
                        parsed["source"] = sub_type
                        return parsed

    return {"success": False, "error": "No subtitle found via yt-dlp"}


def _parse_json3(content: str) -> dict[str, Any]:
    """Parse YouTube json3 caption format."""
    try:
        data = json.loads(content)
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"json3 parse error: {e}"}

    lines: list[str] = []
    text_parts: list[str] = []
    last_start = 0

    for event in data.get("events", []):
        segs = event.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if not text or text == "\n":
            continue
        start_s = event.get("tStartMs", 0) // 1000
        last_start = start_s
        mins, secs = divmod(start_s, 60)
        lines.append(f"[{mins}:{secs:02d}] {text}")
        text_parts.append(text)

    if not lines:
        return {"success": False, "error": "json3 contained no caption segments"}

    return {
        "success": True,
        "transcript_with_timestamps": "\n".join(lines),
        "transcript_text": " ".join(text_parts),
        "segments_count": len(lines),
        "duration_seconds": last_start,
    }


def _parse_vtt(content: str) -> dict[str, Any]:
    """Parse WebVTT caption format."""
    lines: list[str] = []
    text_parts: list[str] = []
    last_start = 0

    # Each VTT cue: timestamp line followed by text lines
    cue_re = re.compile(
        r"(\d+):(\d{2}):(\d{2})[\.,](\d+)\s*-->\s*\d+:\d{2}:\d{2}[\.,]\d+"
    )

    current_start: Optional[int] = None
    current_texts: list[str] = []

    def flush():
        nonlocal last_start
        if current_start is not None and current_texts:
            text = " ".join(current_texts)
            # Strip VTT tags like <c>, <00:00:01.000>
            text = re.sub(r"<[^>]+>", "", text).strip()
            if text:
                last_start = current_start
                mins, secs = divmod(current_start, 60)
                lines.append(f"[{mins}:{secs:02d}] {text}")
                text_parts.append(text)

    for line in content.splitlines():
        line = line.strip()
        m = cue_re.match(line)
        if m:
            flush()
            h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
            current_start = h * 3600 + mi * 60 + s
            current_texts = []
        elif line and current_start is not None and not line.isdigit() and "-->" not in line:
            current_texts.append(line)
        elif not line:
            flush()
            current_start = None
            current_texts = []

    flush()

    if not lines:
        return {"success": False, "error": "VTT contained no caption segments"}

    return {
        "success": True,
        "transcript_with_timestamps": "\n".join(lines),
        "transcript_text": " ".join(text_parts),
        "segments_count": len(lines),
        "duration_seconds": last_start,
    }


# ---------------------------------------------------------------------------
# Legacy fallbacks (oEmbed + youtube-transcript-api)
# ---------------------------------------------------------------------------

def fetch_metadata_oembed(
    video_id: str,
    max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> dict[str, Any]:
    """Fetch basic video metadata via oEmbed API (no auth required).

    Used as fallback when yt-dlp is not installed.
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
    """Fetch transcript via youtube-transcript-api (fallback)."""
    if not TRANSCRIPT_AVAILABLE:
        return {
            "success": False,
            "error": "youtube-transcript-api not installed. Run: uv sync --extra youtube",
            "_do_not_cache": True,
        }

    languages = languages or ["en", "fr", "auto"]

    try:
        api = YouTubeTranscriptApi()
        transcript = None
        transcript_lang = None

        try:
            transcript_list = api.list(video_id)

            for lang in languages:
                try:
                    transcript = transcript_list.find_transcript([lang]).fetch()
                    transcript_lang = lang
                    break
                except Exception:
                    continue

            if not transcript:
                try:
                    transcript = transcript_list.find_generated_transcript(languages).fetch()
                    transcript_lang = "auto"
                except Exception:
                    pass
        except Exception:
            transcript = api.fetch(video_id, languages=languages)
            transcript_lang = "unknown"

        if not transcript:
            return {"success": False, "error": "No transcript available"}

        lines = []
        full_text_parts = []
        last_start = 0
        for snippet in transcript:
            if hasattr(snippet, "start"):
                start = int(snippet.start)
                text = str(snippet.text).strip()
            else:
                start = int(snippet.get("start", 0))
                text = snippet.get("text", "").strip()

            last_start = start
            mins, secs = divmod(start, 60)
            lines.append(f"[{mins}:{secs:02d}] {text}")
            full_text_parts.append(text)

        return {
            "success": True,
            "transcript_with_timestamps": "\n".join(lines),
            "transcript_text": " ".join(full_text_parts),
            "language": transcript_lang,
            "source": "youtube-transcript-api",
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
        return {"success": False, "error": f"Transcript error: {e}"}


# ---------------------------------------------------------------------------
# Fetcher class
# ---------------------------------------------------------------------------

class YouTubeFetcher(BaseFetcher):
    """YouTube video content fetcher.

    Primary path (when yt-dlp installed):
      yt-dlp → rich metadata + subtitles in one call.
      Falls back to youtube-transcript-api if yt-dlp has no subtitles.

    Fallback path (yt-dlp absent):
      oEmbed (metadata) + youtube-transcript-api (transcript).

    Install:
      uv sync --extra youtube   # adds youtube-transcript-api
      pip install yt-dlp        # or: uv add yt-dlp
    """

    content_type = "youtube"

    def _fetch_impl(
        self,
        url: str,
        max_content_size: int = DEFAULT_MAX_CONTENT_SIZE,
    ) -> dict[str, Any]:
        video_id = extract_video_id(url)
        if not video_id:
            return {"success": False, "error": "Could not extract video ID from URL"}

        # --- Primary path: yt-dlp ---
        if YTDLP_AVAILABLE:
            metadata = fetch_metadata_ytdlp(video_id)
            if metadata.get("success"):
                subtitles = metadata.pop("_subtitles", {})
                auto_captions = metadata.pop("_automatic_captions", {})

                transcript = fetch_transcript_ytdlp(subtitles, auto_captions)

                # If yt-dlp had no subtitles, try youtube-transcript-api
                if not transcript.get("success") and TRANSCRIPT_AVAILABLE:
                    transcript = fetch_transcript(video_id)

                return self._build_result(url, video_id, metadata, transcript)

        # --- Fallback path: oEmbed + youtube-transcript-api ---
        metadata = fetch_metadata_oembed(video_id, max_content_size=max_content_size)
        if not metadata.get("success"):
            return {
                "success": False,
                "type": "youtube",
                "url": url,
                "video_id": video_id,
                "error": metadata.get("error", "Metadata fetch failed"),
            }

        transcript = fetch_transcript(video_id)
        return self._build_result(url, video_id, metadata, transcript)

    def _build_result(
        self,
        url: str,
        video_id: str,
        metadata: dict[str, Any],
        transcript: dict[str, Any],
    ) -> dict[str, Any]:
        """Assemble final result dict from metadata + transcript."""
        result: dict[str, Any] = {
            "success": True,
            "type": "youtube",
            "url": url,
            "video_id": video_id,
            # Core metadata (always present)
            "title": metadata.get("title", ""),
            "author": metadata.get("author", ""),
            "author_url": metadata.get("author_url", ""),
            "thumbnail_url": metadata.get("thumbnail_url", ""),
            # Rich metadata (yt-dlp only; None when oEmbed fallback)
            "description": metadata.get("description"),
            "view_count": metadata.get("view_count"),
            "like_count": metadata.get("like_count"),
            "upload_date": metadata.get("upload_date"),
            "duration": metadata.get("duration"),
            "tags": metadata.get("tags") or [],
            "categories": metadata.get("categories") or [],
            "chapters": metadata.get("chapters"),
        }

        if transcript.get("success"):
            result["text"] = sanitize_content(transcript["transcript_with_timestamps"])
            result["transcript_text"] = sanitize_content(transcript["transcript_text"])
            result["transcript_language"] = transcript.get("language", "unknown")
            result["transcript_source"] = transcript.get("source", "unknown")
            result["duration_seconds"] = transcript.get("duration_seconds", 0)
            result["segments_count"] = transcript.get("segments_count", 0)
            result["has_transcript"] = True
        else:
            result["text"] = sanitize_content(
                f"Video: {metadata.get('title', 'Unknown')}\n"
                f"Author: {metadata.get('author', 'Unknown')}\n\n"
                f"[Transcript not available: {transcript.get('error', 'Unknown error')}]"
            )
            result["has_transcript"] = False
            result["transcript_error"] = transcript.get("error", "Unknown error")
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
            "description": raw_result.get("description"),
            "view_count": raw_result.get("view_count"),
            "like_count": raw_result.get("like_count"),
            "upload_date": raw_result.get("upload_date"),
            "duration": raw_result.get("duration"),
            "tags": raw_result.get("tags") or [],
            "categories": raw_result.get("categories") or [],
            "chapters": raw_result.get("chapters"),
            "has_transcript": raw_result.get("has_transcript", False),
            "transcript_language": raw_result.get("transcript_language", ""),
            "transcript_source": raw_result.get("transcript_source", ""),
            "transcript_error": raw_result.get("transcript_error"),
            "duration_seconds": raw_result.get("duration_seconds", 0),
            "segments_count": raw_result.get("segments_count", 0),
        }


# Backward-compatible module-level function
def fetch_youtube(url: str) -> dict[str, Any]:
    """Fetch content from a YouTube video URL."""
    return YouTubeFetcher().fetch(url)


def main():
    """CLI interface for testing."""
    YouTubeFetcher.run_cli()


if __name__ == "__main__":
    main()
