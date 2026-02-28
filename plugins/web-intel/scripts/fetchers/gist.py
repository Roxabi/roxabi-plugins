#!/usr/bin/env python3
"""
GitHub Gist content extraction module.

Fetches gist information using GitHub CLI (gh) API.
Returns structured data for use in knowledge base.

Security:
- SSRF protection via validate_url_ssrf (for URL validation)
- Input sanitization for gist IDs
- Content size limits for file fetching
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

# Add paths for imports (needed when running as script or from tests)
SHARED_DIR = Path(__file__).resolve().parents[1] / "_shared"
FETCHERS_DIR = Path(__file__).resolve().parent
for _dir in [SHARED_DIR, FETCHERS_DIR]:
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from base import (
    BaseFetcher,
    sanitize_content,
    build_result,
)
from validators import validate_url_ssrf
from timeouts import get_timeout
from retry import retry_call, RetryConfig

# Maximum total content size for all gist files (default: 200KB)
MAX_GIST_CONTENT_SIZE = 200_000


def extract_gist_id(url: str) -> Optional[str]:
    """Extract gist ID from a gist.github.com URL.

    Args:
        url: Gist URL (e.g., https://gist.github.com/user/abc123)

    Returns:
        Gist ID string, or None if extraction fails

    Security:
        - Validates that URL is for gist.github.com
        - Sanitizes gist ID to prevent injection (hex only)
    """
    if not url or not isinstance(url, str):
        return None

    url = url.strip().split("?")[0].split("#")[0].rstrip("/")

    # Pattern: gist.github.com/user/gist_id or gist.github.com/gist_id
    match = re.search(r"gist\.github\.com/(?:[^/]+/)?([a-f0-9]+)", url)
    if match:
        gist_id = match.group(1)
        # Gist IDs are hex strings, typically 20-32 chars
        if re.match(r"^[a-f0-9]+$", gist_id) and len(gist_id) >= 4:
            return gist_id

    return None


def _run_gh_api(*args: str) -> subprocess.CompletedProcess:
    """Run a gh API command with retry on transient errors."""
    _retry_config = RetryConfig(
        max_retries=2,
        initial_delay=1.0,
        transient_exceptions=(
            subprocess.TimeoutExpired,
            ConnectionError,
        ),
    )

    cmd = list(args)

    def _do_run() -> subprocess.CompletedProcess:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=get_timeout("subprocess"),
        )

    return retry_call(_do_run, config=_retry_config)


def fetch_gist_gh_api(gist_id: str) -> dict:
    """Fetch gist info using GitHub API via gh CLI."""
    try:
        result = _run_gh_api(
            "gh",
            "api",
            f"/gists/{gist_id}",
            "--jq",
            "{description, html_url, public, created_at, updated_at, comments, owner_login: .owner.login, files: [.files | to_entries[] | {name: .key, language: .value.language, size: .value.size, content: .value.content}]}",
        )

        if result.returncode != 0:
            return {"success": False, "error": f"gh api error: {result.stderr.strip()}"}

        data = json.loads(result.stdout)

        # Build file list and aggregate content
        files = []
        total_content = []
        total_size = 0

        for f in data.get("files", []):
            file_info = {
                "name": f.get("name", ""),
                "language": f.get("language", ""),
                "size": f.get("size", 0),
            }
            files.append(file_info)

            content = f.get("content", "")
            if content and total_size + len(content) <= MAX_GIST_CONTENT_SIZE:
                total_content.append(
                    f"### {f.get('name', 'unnamed')}\n\n```{(f.get('language') or '').lower()}\n{content}\n```"
                )
                total_size += len(content)

        owner = data.get("owner_login", "")
        description = data.get("description", "") or ""
        gist_url = data.get("html_url", f"https://gist.github.com/{gist_id}")

        # Build title from description or first filename
        title = description if description else (files[0]["name"] if files else f"Gist {gist_id}")

        return build_result(
            title=title,
            description=description,
            url=gist_url,
            type_name="gist",
            gist_id=gist_id,
            owner=owner,
            public=data.get("public", True),
            files=files,
            file_count=len(files),
            comments=data.get("comments", 0),
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
            content=sanitize_content("\n\n".join(total_content), content_format="markdown"),
        )

    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout fetching gist info"}
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"JSON parse error: {e}"}
    except FileNotFoundError:
        return {"success": False, "error": "gh CLI not installed. Install: https://cli.github.com/"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def format_for_prompt(data: dict) -> str:
    """Format gist data as text for Claude prompt."""
    if not data.get("success"):
        return f"Error fetching gist: {data.get('error', 'Unknown error')}"

    lines = [
        f"# Gist: {data.get('title', 'Untitled')}",
        "",
        f"**URL:** {data.get('url', '')}",
        f"**Author:** {data.get('owner', 'Unknown')}",
    ]

    if data.get("description"):
        lines.append(f"**Description:** {data['description']}")

    file_count = data.get("file_count", 0)
    lines.append(f"**Files:** {file_count}")

    if data.get("files"):
        file_names = [f.get("name", "") for f in data["files"]]
        lines.append(f"**File names:** {', '.join(file_names)}")

    lines.append(f"**Last updated:** {data.get('updated_at', 'Unknown')[:10]}")

    if data.get("content"):
        lines.extend(["", "## Content", "", data["content"]])

    return "\n".join(lines)


class GistFetcher(BaseFetcher):
    """GitHub Gist content fetcher.

    Fetches gist information using GitHub API via gh CLI.
    Returns structured data including file contents.

    Example:
        >>> fetcher = GistFetcher()
        >>> result = fetcher.fetch("https://gist.github.com/user/abc123")
        >>> if result["success"]:
        ...     print(result["data"]["content"])
    """

    content_type = "gist"

    def _fetch_impl(self, url: str) -> dict:
        """Core implementation: fetch content from a GitHub Gist URL."""
        # Validate URL
        if "://" in url:
            is_valid, error = validate_url_ssrf(url, resolve_hostname=False)
            if not is_valid:
                return {"success": False, "error": f"URL validation failed: {error}"}

            parsed = urlparse(url)
            hostname = parsed.netloc.lower()
            if ":" in hostname:
                hostname = hostname.split(":")[0]
            if hostname.startswith("www."):
                hostname = hostname[4:]

            if hostname != "gist.github.com":
                return {
                    "success": False,
                    "error": f"Only gist.github.com URLs are supported, got: {hostname}",
                }

        gist_id = extract_gist_id(url)
        if not gist_id:
            return {"success": False, "error": "Could not extract gist ID from URL"}

        result = fetch_gist_gh_api(gist_id)

        if result.get("success"):
            result["text"] = sanitize_content(format_for_prompt(result), content_format="markdown")

        return result

    def _transform_data(self, raw_result: dict[str, Any]) -> dict[str, Any]:
        """Transform raw gist result to standardized data dict."""
        return {
            "text": raw_result.get("text", ""),
            "gist_id": raw_result.get("gist_id", ""),
            "owner": raw_result.get("owner", ""),
            "title": raw_result.get("title", ""),
            "description": raw_result.get("description", ""),
            "public": raw_result.get("public", True),
            "files": raw_result.get("files", []),
            "file_count": raw_result.get("file_count", 0),
            "comments": raw_result.get("comments", 0),
            "content": raw_result.get("content", ""),
            "created_at": raw_result.get("created_at", ""),
            "updated_at": raw_result.get("updated_at", ""),
        }


# Backward-compatible module-level function
def fetch_gist(url: str) -> dict[str, Any]:
    """
    Fetch content from a GitHub Gist URL.

    Args:
        url: GitHub Gist URL

    Returns:
        Dict with:
        - success: bool
        - content_type: "gist"
        - url: original URL
        - data: dict with text, gist_id, owner, files, content, etc.
        - error: str (only if success=False)

    Example:
        >>> result = fetch_gist("https://gist.github.com/user/abc123")
        >>> if result["success"]:
        ...     print(result["data"]["content"])
    """
    return GistFetcher().fetch(url)


def main():
    """CLI interface for testing."""
    GistFetcher.run_cli()


if __name__ == "__main__":
    main()
