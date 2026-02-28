#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Utilitaires de validation d'input.

Ce module est une façade qui réexporte toutes les fonctions de validation
depuis les modules spécialisés pour maintenir la rétro-compatibilité.

Modules:
- validators_url: URL validation with domain whitelist
- validators_ssrf: SSRF protection
- validators_subprocess: Subprocess argument sanitization
- sanitizers: HTML/Markdown sanitization, content size limits

Pour les nouveaux usages, préférez importer directement depuis les modules spécialisés.
"""

from __future__ import annotations

# URL validation
from validators_url import (
    URLValidationError,
    ValidationError,  # Alias for backward compatibility
    validate_url,
    validate_url_strict,
    DEFAULT_ALLOWED_DOMAINS,
    ALLOWED_SCHEMES,
)

# SSRF protection
from validators_ssrf import (
    SSRFError,
    is_private_ip,
    is_blocked_hostname,
    validate_url_ssrf,
    validate_url_ssrf_strict,
    PRIVATE_IP_NETWORKS,
    BLOCKED_HOSTNAMES,
)

# Subprocess sanitization
from validators_subprocess import (
    sanitize_subprocess_args,
    DANGEROUS_CHARS_PATTERN,
)

# Content sanitization and size limits
from sanitizers import (
    ContentSizeError,
    sanitize_html,
    sanitize_markdown,
    sanitize_content,
    sanitize_filename,
    validate_json_string,
    fetch_with_size_limit,
    fetch_text_with_size_limit,
    validate_content_length,
    check_content_size,
    DEFAULT_MAX_CONTENT_SIZE,
    SAFE_HTML_TAGS,
    SAFE_HTML_ATTRIBUTES,
)

# Re-export all for backwards compatibility
__all__ = [
    # URL validation
    "URLValidationError",
    "ValidationError",  # Alias for backward compatibility
    "validate_url",
    "validate_url_strict",
    "DEFAULT_ALLOWED_DOMAINS",
    "ALLOWED_SCHEMES",
    # SSRF protection
    "SSRFError",
    "is_private_ip",
    "is_blocked_hostname",
    "validate_url_ssrf",
    "validate_url_ssrf_strict",
    "PRIVATE_IP_NETWORKS",
    "BLOCKED_HOSTNAMES",
    # Subprocess
    "sanitize_subprocess_args",
    "DANGEROUS_CHARS_PATTERN",
    # Sanitizers
    "ContentSizeError",
    "sanitize_html",
    "sanitize_markdown",
    "sanitize_content",
    "sanitize_filename",
    "validate_json_string",
    "fetch_with_size_limit",
    "fetch_text_with_size_limit",
    "validate_content_length",
    "check_content_size",
    "DEFAULT_MAX_CONTENT_SIZE",
    "SAFE_HTML_TAGS",
    "SAFE_HTML_ATTRIBUTES",
]
