#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Content sanitization and size limit utilities.

Provides:
- HTML/Markdown sanitization to prevent XSS
- Content size limits for fetching
- Secure fetch functions with streaming
- Filename sanitization
- JSON validation
"""

from __future__ import annotations

import html
import re
from typing import Optional, Tuple

from validators_url import URLValidationError
from validators_ssrf import validate_url_ssrf_strict

# ==============================================================================
# Content Size Limits
# ==============================================================================

# Default max content size: 5 MB
DEFAULT_MAX_CONTENT_SIZE = 5_000_000


class ContentSizeError(URLValidationError):
    """
    Content size limit exceeded error.

    Raised when fetched content exceeds the maximum allowed size.
    """

    def __init__(
        self,
        message: str,
        actual_size: Optional[int] = None,
        max_size: Optional[int] = None,
    ):
        super().__init__(message, field="content_size")
        self.actual_size = actual_size
        self.max_size = max_size


def validate_content_length(
    content_length: Optional[int],
    max_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> Tuple[bool, Optional[str]]:
    """
    Validate Content-Length header against max size.

    Args:
        content_length: Content-Length header value (None if missing)
        max_size: Maximum allowed size in bytes

    Returns:
        Tuple (is_valid: bool, error_message: str | None)
    """
    if content_length is None:
        # No Content-Length header - can't validate upfront
        return True, None

    if content_length > max_size:
        return False, (
            f"Contenu trop volumineux: {content_length:,} bytes " f"(max: {max_size:,} bytes)"
        )

    return True, None


def check_content_size(
    current_size: int,
    max_size: int = DEFAULT_MAX_CONTENT_SIZE,
) -> None:
    """
    Check if current downloaded size exceeds limit.

    Args:
        current_size: Current downloaded size in bytes
        max_size: Maximum allowed size in bytes

    Raises:
        ContentSizeError: If size exceeds limit
    """
    if current_size > max_size:
        raise ContentSizeError(
            f"Contenu trop volumineux: {current_size:,} bytes dépasse la limite de {max_size:,} bytes",
            actual_size=current_size,
            max_size=max_size,
        )


def fetch_with_size_limit(
    url: str,
    max_size: int = DEFAULT_MAX_CONTENT_SIZE,
    timeout: int = 30,
    validate_ssrf: bool = True,
    headers: Optional[dict] = None,
    chunk_size: int = 8192,
) -> bytes:
    """
    Fetch URL content with SSRF validation and size limit.

    This is a helper function that combines SSRF protection and size limits.
    Uses streaming to avoid loading large files into memory.

    Args:
        url: URL to fetch
        max_size: Maximum content size in bytes (default: 5MB)
        timeout: Request timeout in seconds
        validate_ssrf: Whether to validate for SSRF (default: True)
        headers: Optional request headers
        chunk_size: Size of chunks for streaming download

    Returns:
        Fetched content as bytes

    Raises:
        SSRFError: If URL is unsafe
        ContentSizeError: If content exceeds max_size
        requests.RequestException: For network errors

    Example:
        >>> content = fetch_with_size_limit(
        ...     "https://api.example.com/data.json",
        ...     max_size=1_000_000  # 1MB limit
        ... )
    """
    import requests

    # SSRF validation
    if validate_ssrf:
        validate_url_ssrf_strict(url)

    # Prepare headers
    request_headers = headers.copy() if headers else {}

    # Make request with streaming
    with requests.get(
        url,
        headers=request_headers,
        timeout=timeout,
        stream=True,
    ) as response:
        response.raise_for_status()

        # Check Content-Length header first
        content_length_str = response.headers.get("Content-Length")
        if content_length_str:
            content_length = int(content_length_str)
            is_valid, error = validate_content_length(content_length, max_size)
            if not is_valid:
                raise ContentSizeError(
                    error or "Contenu trop volumineux",
                    actual_size=content_length,
                    max_size=max_size,
                )

        # Stream download with size check
        chunks = []
        total_size = 0

        for chunk in response.iter_content(chunk_size=chunk_size):
            total_size += len(chunk)
            check_content_size(total_size, max_size)
            chunks.append(chunk)

        return b"".join(chunks)


def fetch_text_with_size_limit(
    url: str,
    max_size: int = DEFAULT_MAX_CONTENT_SIZE,
    timeout: int = 30,
    validate_ssrf: bool = True,
    headers: Optional[dict] = None,
    encoding: Optional[str] = None,
) -> str:
    """
    Fetch URL content as text with SSRF validation and size limit.

    Convenience wrapper around fetch_with_size_limit that decodes to string.

    Args:
        url: URL to fetch
        max_size: Maximum content size in bytes
        timeout: Request timeout in seconds
        validate_ssrf: Whether to validate for SSRF
        headers: Optional request headers
        encoding: Text encoding (default: auto-detect)

    Returns:
        Fetched content as string

    Raises:
        SSRFError: If URL is unsafe
        ContentSizeError: If content exceeds max_size
    """
    content = fetch_with_size_limit(
        url,
        max_size=max_size,
        timeout=timeout,
        validate_ssrf=validate_ssrf,
        headers=headers,
    )

    if encoding:
        return content.decode(encoding)

    # Try UTF-8, fall back to latin-1
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("latin-1")


# ==============================================================================
# Filename and JSON Validation
# ==============================================================================


def sanitize_filename(filename: str, max_length: int = 255) -> str:
    """
    Nettoie un nom de fichier pour utilisation sécurisée.

    Args:
        filename: Nom de fichier à nettoyer
        max_length: Longueur maximale (défaut: 255)

    Returns:
        Nom de fichier nettoyé

    Raises:
        ValidationError: Si le nom est vide ou invalide après nettoyage
    """
    if not filename:
        raise URLValidationError("Nom de fichier vide", field="filename")

    # Caractères interdits dans les noms de fichiers
    forbidden_chars = r'<>:"/\|?*'
    for char in forbidden_chars:
        filename = filename.replace(char, "_")

    # Supprimer les caractères de contrôle
    filename = "".join(c for c in filename if ord(c) >= 32)

    # Supprimer les espaces en début/fin et les points en fin
    filename = filename.strip().rstrip(".")

    # Tronquer si trop long
    if len(filename) > max_length:
        # Préserver l'extension si possible
        if "." in filename:
            name, ext = filename.rsplit(".", 1)
            max_name_len = max_length - len(ext) - 1
            if max_name_len > 0:
                filename = f"{name[:max_name_len]}.{ext}"
            else:
                filename = filename[:max_length]
        else:
            filename = filename[:max_length]

    if not filename:
        raise URLValidationError("Nom de fichier invalide après nettoyage", field="filename")

    return filename


def validate_json_string(value: str, field_name: str = "json") -> dict:
    """
    Valide et parse une chaîne JSON.

    Args:
        value: Chaîne JSON à parser
        field_name: Nom du champ pour les messages d'erreur

    Returns:
        Dict parsé

    Raises:
        ValidationError: Si le JSON est invalide
    """
    import json

    try:
        result = json.loads(value)
        if not isinstance(result, dict):
            raise URLValidationError(
                f"{field_name} doit être un objet JSON (dict)", field=field_name, value=value[:100]
            )
        return result
    except json.JSONDecodeError as e:
        raise URLValidationError(f"JSON invalide: {e}", field=field_name, value=value[:100]) from e


# ==============================================================================
# HTML/Markdown Sanitization
# ==============================================================================

# Safe HTML tags allowed after sanitization
SAFE_HTML_TAGS: frozenset[str] = frozenset(
    [
        "p",
        "a",
        "b",
        "i",
        "em",
        "strong",
        "ul",
        "ol",
        "li",
        "br",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "pre",
        "code",
        "blockquote",
        "span",
        "div",
        "hr",
        "dl",
        "dt",
        "dd",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "sup",
        "sub",
        "abbr",
    ]
)

# Safe attributes allowed on HTML tags
SAFE_HTML_ATTRIBUTES: dict[str, frozenset[str]] = {
    "a": frozenset(["href", "title"]),
    "abbr": frozenset(["title"]),
    "img": frozenset(),  # img is not in safe tags, but listed for completeness
}

# Regex patterns for dangerous HTML constructs
_RE_SCRIPT_TAG = re.compile(r"<script[\s>].*?</script>", re.IGNORECASE | re.DOTALL)
_RE_STYLE_TAG = re.compile(r"<style[\s>].*?</style>", re.IGNORECASE | re.DOTALL)
_RE_IFRAME_TAG = re.compile(r"<iframe[\s>].*?(?:</iframe>|/>)", re.IGNORECASE | re.DOTALL)
_RE_OBJECT_TAG = re.compile(r"<object[\s>].*?(?:</object>|/>)", re.IGNORECASE | re.DOTALL)
_RE_EMBED_TAG = re.compile(r"<embed[\s>].*?(?:</embed>|/>)", re.IGNORECASE | re.DOTALL)
_RE_FORM_TAG = re.compile(r"<form[\s>].*?(?:</form>|/>)", re.IGNORECASE | re.DOTALL)
_RE_INPUT_TAG = re.compile(r"<input[\s>].*?/?>", re.IGNORECASE)
_RE_SVG_TAG = re.compile(r"<svg[\s>].*?</svg>", re.IGNORECASE | re.DOTALL)
_RE_MATH_TAG = re.compile(r"<math[\s>].*?</math>", re.IGNORECASE | re.DOTALL)
_RE_BASE_TAG = re.compile(r"<base[\s>].*?/?>", re.IGNORECASE)
_RE_META_TAG = re.compile(r"<meta[\s>].*?/?>", re.IGNORECASE)
_RE_LINK_TAG = re.compile(r"<link[\s>].*?/?>", re.IGNORECASE)

# Event handler attributes (on*) - also catches /onclick patterns parsed by browsers
_RE_EVENT_HANDLER = re.compile(r"[\s/]+on\w+\s*=\s*[\"'][^\"']*[\"']", re.IGNORECASE)
_RE_EVENT_HANDLER_UNQUOTED = re.compile(r"[\s/]+on\w+\s*=\s*\S+", re.IGNORECASE)

# javascript: and data: URI schemes in attributes (with whitespace/tab bypass protection)
_RE_JAVASCRIPT_URI = re.compile(
    r"""(href|src|action|formaction|data)\s*=\s*["']?\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a)\s*:""",
    re.IGNORECASE,
)

# HTML comments (can contain conditional execution in IE)
_RE_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)

# General tag pattern for stripping unsafe tags
_RE_HTML_TAG = re.compile(r"<(/?)(\w+)(\s[^>]*)?>", re.IGNORECASE)

# Attribute pattern for _filter_attributes (compiled once at module level)
_RE_ATTR_PATTERN = re.compile(
    r"""(\w+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?""",
    re.IGNORECASE,
)

# Markdown injection patterns
_RE_MD_HTML_BLOCK = re.compile(r"<script[\s>].*?</script>", re.IGNORECASE | re.DOTALL)
_RE_MD_JAVASCRIPT_LINK = re.compile(
    r"\[([^\]]*)\]\(\s*(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t)\s*:[^)]*\)",
    re.IGNORECASE,
)
_RE_MD_VBSCRIPT_LINK = re.compile(r"\[([^\]]*)\]\(\s*vbscript\s*:[^)]*\)", re.IGNORECASE)
_RE_MD_DATA_LINK = re.compile(r"\[([^\]]*)\]\(\s*data\s*:[^)]*\)", re.IGNORECASE)


def sanitize_html(content: str) -> str:
    """
    Sanitize HTML content to prevent XSS attacks.

    Removes dangerous elements (script, iframe, style, object, embed, form,
    svg, math, base, meta, link) and event handler attributes (onclick, etc.).
    Strips javascript:/vbscript:/data: URI schemes from href/src attributes.
    Removes HTML comments. Preserves only safe tags and safe attributes.

    Args:
        content: Raw HTML content string

    Returns:
        Sanitized HTML content with only safe tags and attributes

    Example:
        >>> sanitize_html('<p>Hello</p><script>alert("xss")</script>')
        '<p>Hello</p>'
        >>> sanitize_html('<a href="javascript:alert(1)">click</a>')
        '<a>click</a>'
    """
    if not content or not isinstance(content, str):
        return ""

    # Decode HTML entities first to prevent bypass via entity encoding
    # (e.g., &#106;avascript: -> javascript:)
    content = html.unescape(content)

    result = content

    # 1. Remove HTML comments (can contain IE conditional execution)
    result = _RE_HTML_COMMENT.sub("", result)

    # 2. Remove dangerous block-level elements entirely (including content)
    result = _RE_SCRIPT_TAG.sub("", result)
    result = _RE_STYLE_TAG.sub("", result)
    result = _RE_IFRAME_TAG.sub("", result)
    result = _RE_OBJECT_TAG.sub("", result)
    result = _RE_EMBED_TAG.sub("", result)
    result = _RE_FORM_TAG.sub("", result)
    result = _RE_INPUT_TAG.sub("", result)
    result = _RE_SVG_TAG.sub("", result)
    result = _RE_MATH_TAG.sub("", result)
    result = _RE_BASE_TAG.sub("", result)
    result = _RE_META_TAG.sub("", result)
    result = _RE_LINK_TAG.sub("", result)

    # 3. Remove event handler attributes (onclick, onload, onerror, etc.)
    result = _RE_EVENT_HANDLER.sub("", result)
    result = _RE_EVENT_HANDLER_UNQUOTED.sub("", result)

    # 4. Remove javascript:/vbscript:/data: URI schemes in attributes
    result = _RE_JAVASCRIPT_URI.sub(r"\1=", result)

    # 5. Strip unsafe tags (keep content, remove the tag itself)
    def _filter_tag(match: re.Match) -> str:
        closing_slash = match.group(1)  # "/" for closing tags
        tag_name = match.group(2).lower()
        attrs = match.group(3) or ""

        if tag_name not in SAFE_HTML_TAGS:
            return ""  # Strip the tag but keep surrounding text

        # For safe tags, filter attributes
        safe_attrs = SAFE_HTML_ATTRIBUTES.get(tag_name, frozenset())
        if attrs and safe_attrs:
            filtered_attrs = _filter_attributes(attrs, safe_attrs)
            return f"<{closing_slash}{tag_name}{filtered_attrs}>"
        elif attrs and not safe_attrs:
            # Tag is safe but has no allowed attributes - strip all attributes
            return f"<{closing_slash}{tag_name}>"
        else:
            return f"<{closing_slash}{tag_name}>"

    result = _RE_HTML_TAG.sub(_filter_tag, result)

    return result


def _filter_attributes(attrs_str: str, allowed: frozenset[str]) -> str:
    """
    Filter HTML attributes, keeping only those in the allowed set.

    Also validates attribute values (removes javascript: URIs, etc.).

    Args:
        attrs_str: Raw attribute string from an HTML tag
        allowed: Set of allowed attribute names

    Returns:
        Filtered attribute string (with leading space if non-empty)
    """
    safe_parts = []
    for match in _RE_ATTR_PATTERN.finditer(attrs_str):
        attr_name = match.group(1).lower()
        if attr_name not in allowed:
            continue

        # Get value from whichever group matched
        value = match.group(2) or match.group(3) or match.group(4) or ""

        # Validate attribute value - reject dangerous URIs
        # Decode entities in value to prevent bypass (e.g., &#106;avascript:)
        value_lower = html.unescape(value.strip()).lower()
        if any(value_lower.startswith(scheme) for scheme in ("javascript:", "vbscript:", "data:")):
            continue

        if value:
            # Escape the value for safe embedding
            escaped_value = value.replace('"', "&quot;")
            safe_parts.append(f'{attr_name}="{escaped_value}"')
        else:
            safe_parts.append(attr_name)

    if safe_parts:
        return " " + " ".join(safe_parts)
    return ""


def sanitize_markdown(content: str) -> str:
    """
    Sanitize Markdown content to prevent injection attacks.

    Removes:
    - Inline HTML script tags embedded in Markdown
    - javascript:/vbscript:/data: URIs in Markdown links
    - HTML event handlers in any inline HTML within Markdown

    Preserves all standard Markdown formatting (headers, bold, italic,
    lists, code blocks, blockquotes, images, regular links).

    Args:
        content: Raw Markdown content string

    Returns:
        Sanitized Markdown content

    Example:
        >>> sanitize_markdown('[click](javascript:alert(1))')
        'click'
        >>> sanitize_markdown('# Title\\n<script>alert(1)</script>')
        '# Title\\n'
    """
    if not content or not isinstance(content, str):
        return ""

    result = content

    # 1. Remove inline HTML script/style/iframe tags in Markdown
    result = _RE_SCRIPT_TAG.sub("", result)
    result = _RE_STYLE_TAG.sub("", result)
    result = _RE_IFRAME_TAG.sub("", result)
    result = _RE_OBJECT_TAG.sub("", result)
    result = _RE_EMBED_TAG.sub("", result)
    result = _RE_SVG_TAG.sub("", result)
    result = _RE_FORM_TAG.sub("", result)

    # 2. Remove event handlers from any inline HTML
    result = _RE_EVENT_HANDLER.sub("", result)
    result = _RE_EVENT_HANDLER_UNQUOTED.sub("", result)

    # 3. Neutralize javascript:/vbscript:/data: links in Markdown syntax
    # [text](javascript:...) -> text
    result = _RE_MD_JAVASCRIPT_LINK.sub(r"\1", result)
    result = _RE_MD_VBSCRIPT_LINK.sub(r"\1", result)
    result = _RE_MD_DATA_LINK.sub(r"\1", result)

    # 4. Remove HTML comments
    result = _RE_HTML_COMMENT.sub("", result)

    # 5. Neutralize javascript: in inline HTML href/src within Markdown
    result = _RE_JAVASCRIPT_URI.sub(r"\1=", result)

    return result


def sanitize_content(content: str, content_format: str = "auto") -> str:
    """
    Sanitize content based on its format.

    Convenience function that dispatches to sanitize_html or sanitize_markdown
    depending on the content format. When format is "auto", it detects the
    format based on content characteristics.

    Args:
        content: Raw content string to sanitize
        content_format: One of "html", "markdown", "text", or "auto"
            - "html": Apply HTML sanitization
            - "markdown": Apply Markdown sanitization
            - "text": Apply both HTML and Markdown sanitization (safest)
            - "auto": Detect format and apply appropriate sanitization

    Returns:
        Sanitized content string

    Example:
        >>> sanitize_content('<script>alert(1)</script>Hello', 'html')
        'Hello'
        >>> sanitize_content('[x](javascript:void(0))', 'markdown')
        'x'
    """
    if not content or not isinstance(content, str):
        return ""

    if content_format == "html":
        return sanitize_html(content)
    elif content_format == "markdown":
        return sanitize_markdown(content)
    elif content_format == "text":
        # Apply both for maximum safety
        result = sanitize_html(content)
        result = sanitize_markdown(result)
        return result
    elif content_format == "auto":
        # Detect format: if it has significant HTML tags, treat as HTML
        # Count HTML-like patterns
        html_tag_count = len(re.findall(r"<[a-zA-Z][^>]*>", content))
        md_pattern_count = len(
            re.findall(r"(?:^#{1,6}\s|\*\*|__|\[.+\]\(.+\))", content, re.MULTILINE)
        )

        if html_tag_count > md_pattern_count and html_tag_count > 2:
            return sanitize_html(content)
        elif md_pattern_count > 0:
            return sanitize_markdown(content)
        else:
            # Unknown format - apply both for safety
            result = sanitize_html(content)
            result = sanitize_markdown(result)
            return result
    else:
        # Unknown format, apply both
        result = sanitize_html(content)
        result = sanitize_markdown(result)
        return result
