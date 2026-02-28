#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Subprocess argument sanitization utilities.

Provides validation to prevent command injection attacks.
"""

from __future__ import annotations

import re

from validators_url import URLValidationError

# Caractères dangereux pour les arguments subprocess
DANGEROUS_CHARS_PATTERN = re.compile(r"[;&|`$(){}[\]<>\\'\"]")


def sanitize_subprocess_args(args: list[str]) -> list[str]:
    """
    Nettoie une liste d'arguments pour utilisation avec subprocess.

    Vérifie et échappe les arguments pour éviter l'injection de commandes.
    IMPORTANT: Cette fonction est une protection supplémentaire, mais
    utilisez toujours subprocess avec shell=False (comportement par défaut).

    Args:
        args: Liste d'arguments à nettoyer

    Returns:
        Liste d'arguments nettoyés

    Raises:
        ValidationError: Si un argument contient des caractères dangereux

    Example:
        >>> safe_args = sanitize_subprocess_args(["--file", "data.json"])
        >>> subprocess.run([sys.executable, "script.py"] + safe_args)
    """
    sanitized = []

    for i, arg in enumerate(args):
        if not isinstance(arg, str):
            raise URLValidationError(
                f"Argument {i} n'est pas une chaîne", field=f"args[{i}]", value=str(arg)
            )

        # Détecter les caractères dangereux
        if DANGEROUS_CHARS_PATTERN.search(arg):
            raise URLValidationError(
                f"Caractères non autorisés dans l'argument: {arg}",
                field=f"args[{i}]",
                value=arg,
            )

        # Vérifier les tentatives d'injection via chemins
        if ".." in arg or arg.startswith("/etc/") or arg.startswith("/proc/"):
            raise URLValidationError(
                f"Chemin suspect dans l'argument: {arg}", field=f"args[{i}]", value=arg
            )

        sanitized.append(arg)

    return sanitized
