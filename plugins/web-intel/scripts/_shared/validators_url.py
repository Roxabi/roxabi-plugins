#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
URL validation utilities.

Provides URL validation with domain whitelist support.
"""

from __future__ import annotations

from typing import Optional
from urllib.parse import urlparse

# Domaines autorisés par défaut pour les URLs
DEFAULT_ALLOWED_DOMAINS: frozenset[str] = frozenset(
    [
        # Réseaux sociaux
        "twitter.com",
        "x.com",
        "reddit.com",
        "linkedin.com",
        "facebook.com",
        "threads.net",
        "mastodon.social",
        # Développement
        "github.com",
        "gitlab.com",
        "bitbucket.org",
        "stackoverflow.com",
        "dev.to",
        "medium.com",
        "substack.com",
        # Vidéo
        "youtube.com",
        "youtu.be",
        "vimeo.com",
        "twitch.tv",
        # Documentation
        "docs.google.com",
        "notion.so",
        "notion.site",
        "confluence.atlassian.com",
        # News / Articles
        "news.ycombinator.com",
        "techcrunch.com",
        "theverge.com",
        "arstechnica.com",
        "wired.com",
        # IA
        "openai.com",
        "anthropic.com",
        "huggingface.co",
        "arxiv.org",
        # Autres
        "wikipedia.org",
        "archive.org",
    ]
)

# Schémas autorisés
ALLOWED_SCHEMES: frozenset[str] = frozenset(["http", "https"])


class URLValidationError(Exception):
    """
    Erreur de validation d'URL (low-level).

    Note: Ne pas confondre avec exceptions.ValidationError (high-level skill error).
    Cette classe est utilisée pour les erreurs de validation URL/SSRF/subprocess.
    """

    def __init__(self, message: str, field: Optional[str] = None, value: Optional[str] = None):
        super().__init__(message)
        self.field = field
        self.value = value


# Alias for backward compatibility
ValidationError = URLValidationError


def validate_url(
    url: str,
    allowed_domains: Optional[frozenset[str]] = None,
    require_https: bool = False,
    allow_any_domain: bool = False,
) -> tuple[bool, Optional[str]]:
    """
    Valide une URL avec whitelist de domaines optionnelle.

    Args:
        url: URL à valider
        allowed_domains: Set de domaines autorisés (utilise DEFAULT_ALLOWED_DOMAINS si None)
        require_https: Exiger HTTPS uniquement
        allow_any_domain: Si True, accepte n'importe quel domaine (bypass whitelist)

    Returns:
        Tuple (is_valid: bool, error_message: str | None)

    Example:
        >>> valid, error = validate_url("https://github.com/user/repo")
        >>> if not valid:
        ...     print(f"URL invalide: {error}")
    """
    if not url or not isinstance(url, str):
        return False, "URL vide ou invalide"

    url = url.strip()

    try:
        parsed = urlparse(url)
    except Exception as e:
        return False, f"Impossible de parser l'URL: {e}"

    # Vérifier le schéma
    if parsed.scheme not in ALLOWED_SCHEMES:
        return False, f"Schéma non autorisé: {parsed.scheme}. Utilisez http ou https."

    if require_https and parsed.scheme != "https":
        return False, "HTTPS requis"

    # Vérifier le domaine
    if not parsed.netloc:
        return False, "Domaine manquant"

    domain = parsed.netloc.lower()
    # Enlever le port si présent
    if ":" in domain:
        domain = domain.split(":")[0]
    # Enlever www. pour la comparaison
    if domain.startswith("www."):
        domain = domain[4:]

    # Si whitelist désactivée, accepter tout domaine valide
    if allow_any_domain:
        return True, None

    # Vérifier contre la whitelist
    domains_to_check = allowed_domains if allowed_domains is not None else DEFAULT_ALLOWED_DOMAINS

    # Vérifier domaine exact ou sous-domaine
    domain_valid = False
    for allowed in domains_to_check:
        if domain == allowed or domain.endswith(f".{allowed}"):
            domain_valid = True
            break

    if not domain_valid:
        return False, f"Domaine non autorisé: {domain}"

    return True, None


def validate_url_strict(url: str) -> str:
    """
    Valide une URL et lève une exception si invalide.

    Version stricte de validate_url pour utilisation avec try/except.

    Args:
        url: URL à valider

    Returns:
        URL nettoyée

    Raises:
        ValidationError: Si l'URL est invalide
    """
    is_valid, error = validate_url(url)
    if not is_valid:
        raise ValidationError(error or "URL invalide", field="url", value=url)
    return url.strip()
