#!/usr/bin/env python3
"""
GitHub content extraction module.

Fetches repository information using GitHub CLI (gh) or API.
Returns structured data for use in knowledge base.

Security:
- SSRF protection via validate_url_ssrf (for URL validation)
- Input sanitization for subprocess calls
- Content size limits for README fetching
"""

from __future__ import annotations

import base64
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

# Maximum README size (default: 100KB - READMEs shouldn't be huge)
MAX_README_SIZE = 100_000


def extract_repo_info(url: str) -> Optional[dict]:
    """Extract owner and repo from GitHub URL.

    Args:
        url: GitHub repository URL or owner/repo format

    Returns:
        Dict with 'owner' and 'repo' keys, or None if extraction fails

    Security:
        - Validates that URL is for github.com (if full URL)
        - Sanitizes owner/repo to prevent injection
    """
    if not url or not isinstance(url, str):
        return None

    # Clean URL
    url = url.strip()
    url = url.split("?")[0].split("#")[0].rstrip("/")

    # Pattern for github.com/owner/repo
    patterns = [
        r"github\.com/([^/]+)/([^/]+)",
        r"^([^/]+)/([^/]+)$",  # Direct owner/repo format
    ]

    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            owner = match.group(1)
            repo = match.group(2)
            # Clean repo name (remove .git suffix)
            repo = repo.replace(".git", "")

            # Validate owner/repo format (alphanumeric, hyphens, underscores)
            # GitHub usernames: alphanumeric + hyphens, no double hyphens, max 39 chars
            # Repo names: alphanumeric + hyphens + underscores + dots
            owner_pattern = r"^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$"
            repo_pattern = r"^[a-zA-Z0-9._-]+$"

            if not re.match(owner_pattern, owner):
                return None
            if not re.match(repo_pattern, repo) or len(repo) > 100:
                return None

            return {"owner": owner, "repo": repo}

    return None


def _run_gh_cli(*args: str) -> subprocess.CompletedProcess:
    """Run a gh CLI command with retry on transient errors.

    Retries on subprocess.TimeoutExpired (transient). Does NOT retry
    on FileNotFoundError (permanent - gh not installed).

    Args:
        *args: Arguments to pass to ``subprocess.run`` (command list first).

    Returns:
        CompletedProcess result.
    """
    _subprocess_retry_config = RetryConfig(
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

    return retry_call(_do_run, config=_subprocess_retry_config)


def fetch_repo_gh_cli(owner: str, repo: str) -> dict:
    """Fetch repository info using GitHub CLI."""
    try:
        # Get repo info
        result = _run_gh_cli(
            "gh",
            "repo",
            "view",
            f"{owner}/{repo}",
            "--json",
            "name,description,url,stargazerCount,forkCount,primaryLanguage,licenseInfo,createdAt,updatedAt,pushedAt,isArchived,isFork,homepageUrl,repositoryTopics",
        )

        if result.returncode != 0:
            return {"success": False, "error": f"gh cli error: {result.stderr}"}

        data = json.loads(result.stdout)

        # Get README content
        readme_content = fetch_readme(owner, repo)

        # Format topics
        topics = []
        if data.get("repositoryTopics"):
            topics = [t.get("name", "") for t in data.get("repositoryTopics", [])]

        return build_result(
            title=f"{owner}/{data.get('name', repo)}",
            description=data.get("description", ""),
            url=data.get("url", f"https://github.com/{owner}/{repo}"),
            type_name="github",
            owner=owner,
            repo=data.get("name", repo),
            stars=data.get("stargazerCount", 0),
            forks=data.get("forkCount", 0),
            language=(
                data.get("primaryLanguage", {}).get("name", "")
                if data.get("primaryLanguage")
                else ""
            ),
            license=(
                data.get("licenseInfo", {}).get("name", "") if data.get("licenseInfo") else ""
            ),
            topics=topics,
            homepage=data.get("homepageUrl", ""),
            is_archived=data.get("isArchived", False),
            is_fork=data.get("isFork", False),
            created_at=data.get("createdAt", ""),
            updated_at=data.get("updatedAt", ""),
            pushed_at=data.get("pushedAt", ""),
            readme=sanitize_content(readme_content, content_format="markdown"),
        )

    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout fetching repo info"}
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"JSON parse error: {e}"}
    except FileNotFoundError:
        return {"success": False, "error": "gh CLI not installed. Install: https://cli.github.com/"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def fetch_readme(owner: str, repo: str, max_size: int = MAX_README_SIZE) -> str:
    """Fetch README content using gh CLI.

    Args:
        owner: Repository owner
        repo: Repository name
        max_size: Maximum README size in bytes (default: 100KB)

    Returns:
        README content (truncated if too large), or empty string on error

    Security:
        - Uses gh CLI (authenticated via user's GitHub token)
        - Limits content size to prevent memory exhaustion
    """
    try:
        # Build the API path safely
        api_path = f"/repos/{owner}/{repo}/readme"

        result = _run_gh_cli("gh", "api", api_path, "--jq", ".content")

        if result.returncode != 0:
            return ""

        # Content is base64 encoded
        try:
            raw_content = result.stdout.strip()

            # Check base64 size (decoded will be ~75% of encoded)
            if len(raw_content) > max_size * 1.4:
                # Too large, truncate base64 and decode what we can
                raw_content = raw_content[: int(max_size * 1.3)]

            content = base64.b64decode(raw_content).decode("utf-8")

            # Final size limit
            if len(content) > max_size:
                content = content[:max_size] + "\n\n[README truncated due to size limit]"

            return content
        except Exception:
            return ""

    except Exception:
        return ""


def format_for_prompt(data: dict) -> str:
    """Format GitHub data as text for Claude prompt."""
    if not data.get("success"):
        return f"Error fetching GitHub repo: {data.get('error', 'Unknown error')}"

    lines = [
        f"# {data['owner']}/{data['repo']}",
        "",
        f"**URL:** {data['url']}",
        f"**Description:** {data.get('description', 'No description')}",
        f"**Language:** {data.get('language', 'Unknown')}",
        f"**Stars:** {data.get('stars', 0)} | **Forks:** {data.get('forks', 0)}",
    ]

    if data.get("license"):
        lines.append(f"**License:** {data['license']}")

    if data.get("topics"):
        lines.append(f"**Topics:** {', '.join(data['topics'])}")

    if data.get("homepage"):
        lines.append(f"**Homepage:** {data['homepage']}")

    if data.get("is_archived"):
        lines.append("**Status:** Archived")

    if data.get("is_fork"):
        lines.append("**Note:** This is a fork")

    lines.append(f"**Last updated:** {data.get('pushed_at', 'Unknown')[:10]}")

    if data.get("readme"):
        lines.extend(
            [
                "",
                "## README (excerpt)",
                "",
                data["readme"][:3000] + ("..." if len(data.get("readme", "")) > 3000 else ""),
            ]
        )

    return "\n".join(lines)


class GitHubFetcher(BaseFetcher):
    """GitHub repository content fetcher.

    Fetches repository information using GitHub CLI (gh) or API.
    Returns structured data including README content.

    Example:
        >>> fetcher = GitHubFetcher()
        >>> result = fetcher.fetch("https://github.com/anthropics/claude-code")
        >>> if result["success"]:
        ...     print(result["data"]["stars"])
    """

    content_type = "github"

    def _fetch_impl(self, url: str) -> dict:
        """
        Core implementation: fetch content from a GitHub URL.

        Returns structured data about the repository.

        Args:
            url: GitHub repository URL or owner/repo format

        Returns:
            Dict with repository data or error

        Security:
            - Validates URL format and extracts only github.com repos
            - Uses gh CLI (no direct HTTP requests to arbitrary URLs)
            - Limits README size to prevent memory exhaustion
        """
        # For full URLs, validate it's actually github.com
        if "://" in url:
            is_valid, error = validate_url_ssrf(url, resolve_hostname=False)
            if not is_valid:
                return {"success": False, "error": f"URL validation failed: {error}"}

            # Ensure it's github.com
            parsed = urlparse(url)
            hostname = parsed.netloc.lower()
            if ":" in hostname:
                hostname = hostname.split(":")[0]
            if hostname.startswith("www."):
                hostname = hostname[4:]

            if hostname != "github.com":
                return {
                    "success": False,
                    "error": f"Only github.com URLs are supported, got: {hostname}",
                }

        repo_info = extract_repo_info(url)
        if not repo_info:
            return {"success": False, "error": "Could not extract owner/repo from URL"}

        result = fetch_repo_gh_cli(repo_info["owner"], repo_info["repo"])

        # Add formatted text for easy use in prompts
        if result.get("success"):
            result["text"] = sanitize_content(format_for_prompt(result), content_format="markdown")

        return result

    def _transform_data(self, raw_result: dict[str, Any]) -> dict[str, Any]:
        """Transform raw GitHub result to standardized data dict."""
        return {
            "text": raw_result.get("text", ""),
            "owner": raw_result.get("owner", ""),
            "repo": raw_result.get("repo", ""),
            "title": raw_result.get("title", ""),
            "description": raw_result.get("description", ""),
            "stars": raw_result.get("stars", 0),
            "forks": raw_result.get("forks", 0),
            "language": raw_result.get("language", ""),
            "license": raw_result.get("license", ""),
            "topics": raw_result.get("topics", []),
            "homepage": raw_result.get("homepage", ""),
            "is_archived": raw_result.get("is_archived", False),
            "is_fork": raw_result.get("is_fork", False),
            "created_at": raw_result.get("created_at", ""),
            "updated_at": raw_result.get("updated_at", ""),
            "pushed_at": raw_result.get("pushed_at", ""),
            "readme": raw_result.get("readme", ""),
        }


# Backward-compatible module-level function
def fetch_github(url: str) -> dict[str, Any]:
    """
    Fetch content from a GitHub repository URL.

    Args:
        url: GitHub repository URL

    Returns:
        Dict with:
        - success: bool
        - content_type: "github"
        - url: original URL
        - data: dict with text, owner, repo, stars, forks, language, readme, etc.
        - error: str (only if success=False)

    Example:
        >>> result = fetch_github("https://github.com/anthropics/claude-code")
        >>> if result["success"]:
        ...     print(result["data"]["stars"])
    """
    return GitHubFetcher().fetch(url)


def main():
    """CLI interface for testing."""
    GitHubFetcher.run_cli()


if __name__ == "__main__":
    main()
