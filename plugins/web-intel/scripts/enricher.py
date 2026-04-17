#!/usr/bin/env python3
"""
LLM-based content enrichment for scraped URLs.

Shared extraction layer used by roxabi-intel (`make intel digest`) and
Lyra's `#links` Discord flow. Produces a unified 5-field schema so both
surfaces render from the same data.

Output schema:
    - title: str         — page title, site suffix stripped
    - tags: list[str]    — 3-5 short noun phrases
    - summary: str       — one-sentence teaser (<200 chars, plain text)
    - key_points: list[str] — 2-5 factual bullets (<150 chars each)
    - reply: str         — prose paragraph (2-5 sentences) for human reader

Model profiles:
    - glm-fast (default) — Fireworks glm-5-fast via local proxy; batch use
    - claude             — claude-cli subprocess; real-time chat use

CLI:
    echo '{"text": "...", "title": "..."}' | uv run python enricher.py
    uv run python enricher.py <url>                     # scrape + enrich
    uv run python enricher.py --model claude <url>
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def _get_fireworks_token() -> str:
    """Get Fireworks API token from multiple sources."""
    # 1. Check env var
    token = os.environ.get("FIREWORKS_TOKEN", "")
    if token:
        return token

    # 2. Check ~/.env file
    env_path = Path.home() / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("FIREWORKS_TOKEN="):
                return line.split("=", 1)[1].strip().strip("\"'")

    # 3. Parse from ~/.bash_aliases
    aliases_path = Path.home() / ".bash_aliases"
    if aliases_path.exists():
        content = aliases_path.read_text()
        # Look for token in _cc_fireworks function
        import re
        match = re.search(r'ANTHROPIC_AUTH_TOKEN="([^"]+)"', content)
        if match:
            return match.group(1)
        # Also check for FIREWORKS_TOKEN
        match = re.search(r'FIREWORKS_TOKEN="([^"]+)"', content)
        if match:
            return match.group(1)

    return ""


# Model configuration
FIREWORKS_PROXY = "http://localhost:4000/fw-anthropic"
FIREWORKS_TOKEN = _get_fireworks_token()
GLM_MODEL_ID = "accounts/fireworks/routers/glm-5-fast"
MAX_TOKENS = 4000

# Model profile aliases for the --model flag.
MODEL_PROFILES = ("glm-fast", "claude")
DEFAULT_PROFILE = "glm-fast"

ENRICHMENT_PROMPT = """Extract metadata from the web content below and write a
helpful summary for a human reader.

Output exactly one JSON object on a single line. No prose, no reasoning, no
markdown, no code fences, no explanation before or after. Start with `{{` and
end with `}}`.

Schema (replace example values — do NOT keep literal "..." placeholders):
{{"title":"...","tags":["kw","kw"],"summary":"one sentence","key_points":["fact","fact"],"reply":"paragraph"}}

Rules:
- title: the page's real title, no site suffix (e.g. " - GitHub")
- tags: 3-5 short noun phrases, each under 4 words, no punctuation other than
  hyphens/spaces, no backticks, no parentheses, no question marks
- summary: one complete sentence under 200 chars, plain text, no markdown,
  no "Draft", no meta-commentary about your answer
- key_points: 2-5 short factual bullets, each under 150 chars, plain text
- reply: a clear, concise prose paragraph (2-5 sentences) for a human reader;
  may use light markdown (bold, inline code); do NOT repeat summary verbatim

Title hint: {title}
Platform: {platform}
Content: {content}

JSON:"""

# Second-attempt prompt used when the first response fails validation.
STRICT_RETRY_PROMPT = """Your previous answer was not valid JSON. Reply with exactly one
minified JSON object and nothing else. Do not think out loud. Do not wrap in
markdown. Do not prefix with "JSON:" or similar.

Schema: {{"title":"...","tags":["kw","kw"],"summary":"one sentence","key_points":["p","p"],"reply":"paragraph"}}

Title hint: {title}
Platform: {platform}
Content: {content}

JSON:"""


def _call_glm_fast(prompt: str) -> str:
    """Call glm-5-fast via Fireworks proxy (Anthropic-compatible API)."""
    import httpx

    url = f"{FIREWORKS_PROXY}/v1/messages"

    payload = {
        "model": GLM_MODEL_ID,
        "max_tokens": MAX_TOKENS,
        "messages": [{"role": "user", "content": prompt}],
    }

    headers = {
        "Content-Type": "application/json",
        "x-api-key": FIREWORKS_TOKEN,
        "anthropic-version": "2023-06-01",
    }

    try:
        with httpx.Client(timeout=120.0) as client:
            response = client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            for block in data.get("content", []):
                if block.get("type") == "text":
                    return block.get("text", "")
            raise RuntimeError("No text block in response")
    except Exception as e:
        raise RuntimeError(f"LLM call failed (glm-fast): {e}")


def _call_claude_cli(prompt: str) -> str:
    """Call Claude via `claude` CLI in one-shot non-interactive mode."""
    try:
        proc = subprocess.run(
            ["claude", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=60.0,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError("claude CLI not found in PATH")
    except subprocess.TimeoutExpired:
        raise RuntimeError("LLM call failed (claude): timeout after 60s")

    if proc.returncode != 0:
        raise RuntimeError(
            f"LLM call failed (claude): exit={proc.returncode} stderr={proc.stderr.strip()[:200]}"
        )
    return proc.stdout


def call_llm(prompt: str, model: str = DEFAULT_PROFILE) -> str:
    """Dispatch to the selected model backend."""
    if model == "claude":
        return _call_claude_cli(prompt)
    if model == "glm-fast":
        return _call_glm_fast(prompt)
    raise ValueError(f"Unknown model profile: {model!r} (expected one of {MODEL_PROFILES})")


def parse_llm_response(text: str) -> dict[str, Any]:
    """Parse LLM response, extracting from reasoning or JSON."""
    import re

    text = text.strip()

    # Bleed-signal words that show up when the model ignores "JSON only" and
    # echoes prompt language or its own chain-of-thought. Case-insensitive.
    _BLEED_WORDS = re.compile(
        r'\b(draft|encapsulat|one sentence|keywords?\?|refinement|let me|'
        r'thinking|first,|finally,|here(?:\'s| is) (?:my|the|a)|'
        r'revised)\b',
        re.IGNORECASE,
    )

    def is_valid_tag(t: str) -> bool:
        """Reject reasoning-text noise. Real tags are short keyword phrases."""
        t = t.strip()
        if not t or len(t) > 40:
            return False
        if t in ('tag1', 'tag2', 'keyword', 'kw'):
            return False
        # Disallow any punctuation that indicates prose rather than a keyword:
        # brackets, parentheses, question marks, backticks, asterisks, braces.
        if any(ch in t for ch in (':', '[', ']', '{', '}', '(', ')', '?', '`', '*', '\n')):
            return False
        # Reject "tags" that are just punctuation
        if not re.search(r'[a-zA-Z0-9]', t):
            return False
        # Reject sentence-like fragments (more than ~4 words)
        if len(t.split()) > 4:
            return False
        # Reject tags that echo prompt / reasoning vocabulary.
        if _BLEED_WORDS.search(t):
            return False
        return True

    def is_valid_summary(s: str) -> bool:
        """Reject summaries that contain markdown bleed or meta-commentary."""
        s = s.strip()
        if not s or len(s) < 10:
            return False
        # Leading markdown bullet / bold / italic.
        if s.startswith(('*', '-', '`', '#', '>')):
            return False
        # Bleed words anywhere.
        if _BLEED_WORDS.search(s):
            return False
        return True

    def sanitize_tags(tags: list) -> list:
        return [t.strip() for t in tags if is_valid_tag(t)]

    def clean_summary(s: str) -> str:
        """Clean up summary: remove drafts, newlines, artifacts."""
        # Remove "Draft 1:", "Draft 2:", "Refinement:" prefixes
        s = re.sub(r'\*?\*?Draft\s*\d*:?\s*', '', s, flags=re.IGNORECASE)
        s = re.sub(r'\*?\*?Refinement:?\s*', '', s, flags=re.IGNORECASE)
        # Remove newlines and extra spaces
        s = s.replace('\\n', ' ').replace('\n', ' ')
        s = re.sub(r'\s+', ' ', s)
        # Remove markdown bold/italic artifacts
        s = re.sub(r'\*+', '', s)
        # Truncate at sentence end if possible, else at 200 chars
        if len(s) > 200:
            # Find last complete sentence
            match = re.search(r'^(.+?[.!?])\s', s[:250])
            if match:
                s = match.group(1)
            else:
                s = s[:200].rsplit(' ', 1)[0]
        return s.strip()

    # Try to find JSON - but skip if it's the example schema (tag1, tag2, point1, point2)
    # Use greedy match to capture full nested object with reply/key_points arrays.
    json_match = re.search(r'\{.*"tags".*\}', text, re.DOTALL)
    if json_match:
        json_str = json_match.group(0)
        # Skip if it looks like the example schema
        if 'tag1' in json_str or 'tag2' in json_str or 'point1' in json_str:
            pass  # Skip example schema
        else:
            try:
                result = json.loads(json_str)
                if result.get("summary"):
                    cleaned = clean_summary(result["summary"])
                    result["summary"] = cleaned if is_valid_summary(cleaned) else ""
                if result.get("tags"):
                    result["tags"] = sanitize_tags(result["tags"])
                return result
            except json.JSONDecodeError:
                pass

    # Extract from reasoning text
    result = {"title": "", "tags": [], "summary": "", "key_points": [], "reply": ""}

    # Look for title in JSON
    title_in_json = re.search(r'"title"\s*:\s*"([^"]+)"', text)
    if title_in_json:
        result["title"] = title_in_json.group(1).strip()

    # Look for actual tag values in reasoning
    tags_in_json = re.search(r'"tags"\s*:\s*\[([^\]]+)\]', text)
    if tags_in_json:
        tags_str = tags_in_json.group(1)
        tags = re.findall(r'"([^"]+)"', tags_str)
        tags = sanitize_tags(tags)
        if tags:
            result["tags"] = tags[:5]

    # Look for summary in JSON
    summary_in_json = re.search(r'"summary"\s*:\s*"([^"]+)"', text)
    if summary_in_json:
        summary = summary_in_json.group(1)
        if summary != "one sentence summary":
            result["summary"] = clean_summary(summary)

    # Look for key_points in JSON
    points_in_json = re.search(r'"key_points"\s*:\s*\[([^\]]+)\]', text)
    if points_in_json:
        points_str = points_in_json.group(1)
        points = re.findall(r'"([^"]+)"', points_str)
        points = [p for p in points if p not in ('point1', 'point2')]
        if points:
            result["key_points"] = points[:5]

    # Look for reply in JSON — greedy across newlines, stops at next quoted key.
    reply_in_json = re.search(
        r'"reply"\s*:\s*"((?:[^"\\]|\\.)*)"', text, re.DOTALL
    )
    if reply_in_json:
        reply = reply_in_json.group(1)
        # Unescape common JSON escapes.
        reply = reply.replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')
        result["reply"] = reply.strip()

    # If we got meaningful values, return them
    if result["tags"] or result["summary"] or result["key_points"] or result["reply"]:
        return result

    # Fallback: extract from reasoning sections
    tags_section = re.search(r'Tags:\s*\n?(.*?)(?=Summary:|$)', text, re.DOTALL | re.IGNORECASE)
    if tags_section:
        tags_text = tags_section.group(1)
        tags = re.findall(r'["\']([^"\']+)["\']', tags_text)
        if not tags:
            tags = re.findall(r'^\s*[-*]\s*(.+?)$', tags_text, re.MULTILINE)
        result["tags"] = sanitize_tags([t.lower() for t in tags])[:5]

    # Summary from reasoning
    summary_section = re.search(r'Summary:\s*["\']?([^"\']+)["\']?', text, re.IGNORECASE)
    if summary_section:
        cleaned = clean_summary(summary_section.group(1))
        if is_valid_summary(cleaned):
            result["summary"] = cleaned

    # Final gate on summary regardless of which branch produced it.
    if result.get("summary") and not is_valid_summary(result["summary"]):
        result["summary"] = ""

    return result


_EMPTY_RESULT = {
    "title": "",
    "tags": [],
    "summary": "",
    "key_points": [],
    "reply": "",
}


def enrich_content(
    scraped_data: dict[str, Any],
    model: str = DEFAULT_PROFILE,
) -> dict[str, Any]:
    """
    Enrich scraped content with LLM-extracted metadata.

    Args:
        scraped_data: Dict from scraper.py with at least:
            - title: str
            - text or content: str
            - platform: str (optional)
        model: Model profile ("glm-fast" or "claude").

    Returns:
        Dict with:
            - title: str
            - tags: list[str]
            - summary: str
            - key_points: list[str]
            - reply: str
    """
    title = scraped_data.get("title", "Untitled")
    platform = scraped_data.get("platform", scraped_data.get("content_type", "web"))
    content = scraped_data.get("text") or scraped_data.get("content") or ""

    # Truncate content if too long (GLM5 has context limits)
    max_content = 4000
    if len(content) > max_content:
        content = content[:max_content] + "\n... (truncated)"

    if not content.strip():
        return dict(_EMPTY_RESULT)

    def _has_content(enriched: dict) -> bool:
        """True if enrichment produced at least one usable field."""
        return bool(
            enriched.get("tags")
            or enriched.get("summary")
            or enriched.get("key_points")
            or enriched.get("reply")
        )

    # First attempt with the main prompt.
    try:
        response = call_llm(
            ENRICHMENT_PROMPT.format(title=title, platform=platform, content=content),
            model=model,
        )
        enriched = parse_llm_response(response)
    except Exception as e:
        print(f"  Enrichment failed: {e}", file=sys.stderr)
        enriched = {}

    # Retry once with the stricter prompt if the first round yielded nothing.
    # Don't retry on a partially-valid result — accept what we got.
    if not _has_content(enriched):
        try:
            print("  Enrichment empty, retrying with strict prompt", file=sys.stderr)
            response = call_llm(
                STRICT_RETRY_PROMPT.format(title=title, platform=platform, content=content),
                model=model,
            )
            enriched = parse_llm_response(response)
        except Exception as e:
            print(f"  Strict retry failed: {e}", file=sys.stderr)
            enriched = enriched or {}

    return {
        "title": (enriched.get("title") or "").strip(),
        "tags": enriched.get("tags", [])[:5],
        "summary": enriched.get("summary", ""),
        "key_points": enriched.get("key_points", [])[:5],
        "reply": (enriched.get("reply") or "").strip(),
    }


def main():
    """CLI interface for testing."""
    parser = argparse.ArgumentParser(description="LLM enrichment for scraped URLs.")
    parser.add_argument(
        "--model",
        choices=MODEL_PROFILES,
        default=DEFAULT_PROFILE,
        help="Model profile (glm-fast = Fireworks batch, claude = claude-cli chat)",
    )
    parser.add_argument(
        "url",
        nargs="?",
        help="URL to scrape+enrich. If omitted, read scraped JSON from stdin.",
    )
    args = parser.parse_args()

    if args.url:
        print(f"Scraping {args.url}...", file=sys.stderr)
        from scraper import scrape_content

        scraped = scrape_content(args.url)
        if not scraped.get("success"):
            print(json.dumps({"error": scraped.get("error")}, indent=2))
            return

        print(f"Enriching with {args.model}...", file=sys.stderr)
        enriched = enrich_content(scraped.get("data", {}), model=args.model)
        result = {**scraped, "enriched": enriched}
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        try:
            data = json.load(sys.stdin)
            enriched = enrich_content(data, model=args.model)
            print(json.dumps(enriched, indent=2, ensure_ascii=False))
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
