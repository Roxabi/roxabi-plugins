#!/usr/bin/env python3
"""
LLM-based content enrichment for scraped URLs.

Takes raw scraped content and uses LLM to extract:
- Relevant tags (3-5)
- Concise summary (1-2 sentences)
- Key points/features (bullet list)

Usage:
    from enricher import enrich_content

    enriched = enrich_content(scraped_data)
    print(enriched["tags"])      # ["AI agent", "knowledge", ...]
    print(enriched["summary"])   # "A system for..."

CLI:
    echo '{"text": "...", "title": "..."}' | uv run python enricher.py
"""

from __future__ import annotations

import json
import os
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


# LLM configuration
FIREWORKS_PROXY = "http://localhost:4000/fw-anthropic"
FIREWORKS_TOKEN = _get_fireworks_token()
DEFAULT_MODEL = "accounts/fireworks/routers/glm-5-fast"

ENRICHMENT_PROMPT = """Extract metadata from this content. Output ONLY a JSON object, no other text.

{{"tags":["tag1","tag2"],"summary":"one sentence summary","key_points":["point1","point2"]}}

Title: {title}
Platform: {platform}
Content: {content}

JSON:"""


def call_llm(prompt: str, model: str = DEFAULT_MODEL) -> str:
    """Call LLM via Fireworks proxy (Anthropic-compatible API)."""
    import httpx

    url = f"{FIREWORKS_PROXY}/v1/messages"

    payload = {
        "model": model,
        "max_tokens": 500,
        "messages": [{"role": "user", "content": prompt}],
    }

    headers = {
        "Content-Type": "application/json",
        "x-api-key": FIREWORKS_TOKEN,
        "anthropic-version": "2023-06-01",
    }

    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            # Response has content array with type: "thinking" and type: "text" blocks
            # Find the text block
            for block in data.get("content", []):
                if block.get("type") == "text":
                    return block.get("text", "")
            raise RuntimeError("No text block in response")
    except Exception as e:
        raise RuntimeError(f"LLM call failed: {e}")


def parse_llm_response(text: str) -> dict[str, Any]:
    """Parse LLM response, extracting from reasoning or JSON."""
    import re

    text = text.strip()

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
    json_match = re.search(r'\{[^{}]*"tags"[^{}]*\}', text, re.DOTALL)
    if json_match:
        json_str = json_match.group(0)
        # Skip if it looks like the example schema
        if 'tag1' in json_str or 'tag2' in json_str or 'point1' in json_str:
            pass  # Skip example schema
        else:
            try:
                result = json.loads(json_str)
                if result.get("summary"):
                    result["summary"] = clean_summary(result["summary"])
                return result
            except json.JSONDecodeError:
                pass

    # Extract from reasoning text
    result = {"tags": [], "summary": "", "key_points": []}

    # Look for actual tag values in reasoning
    tags_in_json = re.search(r'"tags"\s*:\s*\[([^\]]+)\]', text)
    if tags_in_json:
        tags_str = tags_in_json.group(1)
        tags = re.findall(r'"([^"]+)"', tags_str)
        tags = [t for t in tags if t not in ('tag1', 'tag2')]
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

    # If we got meaningful values, return them
    if result["tags"] or result["summary"] or result["key_points"]:
        return result

    # Fallback: extract from reasoning sections
    tags_section = re.search(r'Tags:\s*\n?(.*?)(?=Summary:|$)', text, re.DOTALL | re.IGNORECASE)
    if tags_section:
        tags_text = tags_section.group(1)
        tags = re.findall(r'["\']([^"\']+)["\']', tags_text)
        if not tags:
            tags = re.findall(r'^\s*[-*]\s*(.+?)$', tags_text, re.MULTILINE)
        result["tags"] = [t.strip().lower() for t in tags[:5] if t.strip() and t not in ('tag1', 'tag2')]

    # Summary from reasoning
    summary_section = re.search(r'Summary:\s*["\']?([^"\']+)["\']?', text, re.IGNORECASE)
    if summary_section:
        result["summary"] = clean_summary(summary_section.group(1))

    return result


def enrich_content(scraped_data: dict[str, Any]) -> dict[str, Any]:
    """
    Enrich scraped content with LLM-extracted metadata.

    Args:
        scraped_data: Dict from scraper.py with at least:
            - title: str
            - text or content: str
            - platform: str (optional)

    Returns:
        Dict with:
            - tags: list[str]
            - summary: str
            - key_points: list[str]
    """
    title = scraped_data.get("title", "Untitled")
    platform = scraped_data.get("platform", scraped_data.get("content_type", "web"))
    content = scraped_data.get("text") or scraped_data.get("content") or ""

    # Truncate content if too long (GLM5 has context limits)
    max_content = 4000
    if len(content) > max_content:
        content = content[:max_content] + "\n... (truncated)"

    if not content.strip():
        return {"tags": [], "summary": "", "key_points": []}

    prompt = ENRICHMENT_PROMPT.format(
        title=title, platform=platform, content=content
    )

    try:
        response = call_llm(prompt)
        enriched = parse_llm_response(response)

        # Validate and sanitize
        return {
            "tags": enriched.get("tags", [])[:5],
            "summary": enriched.get("summary", "")[:200],
            "key_points": enriched.get("key_points", [])[:5],
        }
    except Exception as e:
        print(f"  Enrichment failed: {e}", file=sys.stderr)
        return {"tags": [], "summary": "", "key_points": []}


def main():
    """CLI interface for testing."""
    if len(sys.argv) > 1:
        # URL mode: enrich from URL (call scraper first)
        url = sys.argv[1]
        print(f"Scraping {url}...")

        # Import and call scraper
        from scraper import scrape_content

        scraped = scrape_content(url)
        if not scraped.get("success"):
            print(json.dumps({"error": scraped.get("error")}, indent=2))
            return

        print("Enriching...")
        enriched = enrich_content(scraped.get("data", {}))
        result = {**scraped, "enriched": enriched}
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        # stdin mode: read JSON from stdin
        try:
            data = json.load(sys.stdin)
            enriched = enrich_content(data)
            print(json.dumps(enriched, indent=2, ensure_ascii=False))
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
