"""
Configuration centralisée des timeouts pour tous les skills.

Fournit des valeurs de timeout par défaut sensées avec possibilité
d'override via variables d'environnement.

Usage:
    from timeouts import TimeoutConfig, get_timeout

    # Utiliser les timeouts par défaut
    config = TimeoutConfig()
    response = requests.get(url, timeout=config.api_default)

    # Override via env vars
    # TIMEOUT_API_DEFAULT=60
    # TIMEOUT_SUBPROCESS_DEFAULT=120

    # Utiliser la fonction helper
    timeout = get_timeout('api_default')
"""

import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class TimeoutConfig:
    """
    Configuration des timeouts pour différents types d'opérations.

    Tous les timeouts sont en secondes.
    Peuvent être overridés via variables d'environnement TIMEOUT_<NAME>.

    Attributes:
        api_default: Timeout pour appels API génériques (défaut: 30s)
        subprocess_default: Timeout pour sous-processus (défaut: 60s)
        google_api: Timeout spécifique Google APIs (défaut: 30s)
        github_api: Timeout spécifique GitHub API (défaut: 30s)
        telegram_api: Timeout spécifique Telegram API (défaut: 30s)
        web_fetch: Timeout pour fetch de pages web (défaut: 45s)
        claude_cli: Timeout pour appels Claude CLI (défaut: 120s)
        fetcher_connect: Timeout de connexion pour les content fetchers (défaut: 10s)
        fetcher_read: Timeout de lecture pour les content fetchers (défaut: 30s)
        twitter_connect: Timeout de connexion spécifique Twitter (défaut: fetcher_connect)
        twitter_read: Timeout de lecture spécifique Twitter (défaut: fetcher_read)
        youtube_connect: Timeout de connexion spécifique YouTube (défaut: fetcher_connect)
        youtube_read: Timeout de lecture spécifique YouTube (défaut: fetcher_read)
        reddit_connect: Timeout de connexion spécifique Reddit (défaut: fetcher_connect)
        reddit_read: Timeout de lecture spécifique Reddit (défaut: fetcher_read)
        github_connect: Timeout de connexion spécifique GitHub (défaut: fetcher_connect)
        github_read: Timeout de lecture spécifique GitHub (défaut: fetcher_read)

    Example:
        >>> config = TimeoutConfig()
        >>> config.api_default
        30

        >>> # Avec override env var
        >>> os.environ['TIMEOUT_API_DEFAULT'] = '60'
        >>> config = TimeoutConfig.from_env()
        >>> config.api_default
        60

        >>> # Fetcher timeouts (connect, read) tuple
        >>> config.get_fetcher_timeout('twitter')
        (10, 30)
    """

    api_default: int = 30
    subprocess_default: int = 60
    google_api: int = 30
    github_api: int = 30
    telegram_api: int = 30
    web_fetch: int = 45
    claude_cli: int = 120

    # Content fetcher timeouts (connect, read)
    fetcher_connect: int = 10
    fetcher_read: int = 30

    # Per-fetcher overrides (0 means use fetcher_connect/fetcher_read defaults)
    twitter_connect: int = 0
    twitter_read: int = 0
    youtube_connect: int = 0
    youtube_read: int = 0
    reddit_connect: int = 0
    reddit_read: int = 0
    github_connect: int = 0
    github_read: int = 0

    def get_fetcher_timeout(self, fetcher_name: str) -> tuple[int, int]:
        """
        Retourne le tuple (connect_timeout, read_timeout) pour un fetcher donné.

        Si le fetcher a des valeurs spécifiques (non-zero), elles sont utilisées.
        Sinon, les valeurs par défaut fetcher_connect/fetcher_read sont utilisées.

        Args:
            fetcher_name: Nom du fetcher (twitter, youtube, reddit, github)

        Returns:
            Tuple (connect_timeout, read_timeout) en secondes

        Example:
            >>> config = TimeoutConfig()
            >>> config.get_fetcher_timeout('twitter')
            (10, 30)
            >>> config.twitter_connect = 5
            >>> config.get_fetcher_timeout('twitter')
            (5, 30)
        """
        connect_attr = f"{fetcher_name}_connect"
        read_attr = f"{fetcher_name}_read"

        connect = getattr(self, connect_attr, 0) if hasattr(self, connect_attr) else 0
        read = getattr(self, read_attr, 0) if hasattr(self, read_attr) else 0

        return (
            connect if connect > 0 else self.fetcher_connect,
            read if read > 0 else self.fetcher_read,
        )

    @classmethod
    def from_env(cls) -> "TimeoutConfig":
        """
        Crée une config avec overrides depuis les variables d'environnement.

        Variables supportées:
        - TIMEOUT_API_DEFAULT
        - TIMEOUT_SUBPROCESS_DEFAULT
        - TIMEOUT_GOOGLE_API
        - TIMEOUT_GITHUB_API
        - TIMEOUT_TELEGRAM_API
        - TIMEOUT_WEB_FETCH
        - TIMEOUT_CLAUDE_CLI

        Returns:
            TimeoutConfig avec valeurs overridées si présentes

        Example:
            >>> os.environ['TIMEOUT_GITHUB_API'] = '60'
            >>> config = TimeoutConfig.from_env()
            >>> config.github_api
            60
        """

        def get_timeout_env(name: str, default: int) -> int:
            """Récupère un timeout depuis env var avec fallback."""
            env_var = f"TIMEOUT_{name.upper()}"
            value = os.getenv(env_var)
            if value is not None:
                try:
                    return int(value)
                except ValueError:
                    # Valeur invalide, utiliser le défaut
                    pass
            return default

        defaults = cls()
        return cls(
            api_default=get_timeout_env("API_DEFAULT", defaults.api_default),
            subprocess_default=get_timeout_env("SUBPROCESS_DEFAULT", defaults.subprocess_default),
            google_api=get_timeout_env("GOOGLE_API", defaults.google_api),
            github_api=get_timeout_env("GITHUB_API", defaults.github_api),
            telegram_api=get_timeout_env("TELEGRAM_API", defaults.telegram_api),
            web_fetch=get_timeout_env("WEB_FETCH", defaults.web_fetch),
            claude_cli=get_timeout_env("CLAUDE_CLI", defaults.claude_cli),
            fetcher_connect=get_timeout_env("FETCHER_CONNECT", defaults.fetcher_connect),
            fetcher_read=get_timeout_env("FETCHER_READ", defaults.fetcher_read),
            twitter_connect=get_timeout_env("TWITTER_CONNECT", defaults.twitter_connect),
            twitter_read=get_timeout_env("TWITTER_READ", defaults.twitter_read),
            youtube_connect=get_timeout_env("YOUTUBE_CONNECT", defaults.youtube_connect),
            youtube_read=get_timeout_env("YOUTUBE_READ", defaults.youtube_read),
            reddit_connect=get_timeout_env("REDDIT_CONNECT", defaults.reddit_connect),
            reddit_read=get_timeout_env("REDDIT_READ", defaults.reddit_read),
            github_connect=get_timeout_env("GITHUB_CONNECT", defaults.github_connect),
            github_read=get_timeout_env("GITHUB_READ", defaults.github_read),
        )


# Instance globale avec valeurs par défaut
_default_config: Optional[TimeoutConfig] = None


def get_timeout_config() -> TimeoutConfig:
    """
    Récupère la configuration de timeout globale.

    Crée une instance avec env overrides au premier appel,
    puis retourne la même instance.

    Returns:
        TimeoutConfig global

    Example:
        >>> config = get_timeout_config()
        >>> config.github_api
        30
    """
    global _default_config
    if _default_config is None:
        _default_config = TimeoutConfig.from_env()
    return _default_config


def get_fetcher_timeout(fetcher_name: str) -> tuple[int, int]:
    """
    Récupère le tuple (connect, read) timeout pour un content fetcher.

    Noms supportés: 'twitter', 'youtube', 'reddit', 'github'

    Args:
        fetcher_name: Nom du fetcher

    Returns:
        Tuple (connect_timeout, read_timeout) en secondes

    Example:
        >>> get_fetcher_timeout('twitter')
        (10, 30)
    """
    config = get_timeout_config()
    return config.get_fetcher_timeout(fetcher_name)


def get_timeout(name: str) -> int:
    """
    Récupère un timeout spécifique par son nom.

    Noms supportés:
    - 'api_default' ou 'api'
    - 'subprocess_default' ou 'subprocess'
    - 'google_api' ou 'google'
    - 'github_api' ou 'github'
    - 'telegram_api' ou 'telegram'
    - 'web_fetch' ou 'web'
    - 'claude_cli' ou 'claude'
    - 'fetcher_connect', 'fetcher_read'
    - 'twitter_connect', 'twitter_read', etc.

    Args:
        name: Nom du timeout

    Returns:
        Valeur du timeout en secondes

    Raises:
        ValueError: Si le nom n'est pas reconnu

    Example:
        >>> get_timeout('github_api')
        30
        >>> get_timeout('github')  # Alias
        30
    """
    config = get_timeout_config()

    # Mapping des alias
    aliases = {
        "api": "api_default",
        "subprocess": "subprocess_default",
        "google": "google_api",
        "github": "github_api",
        "telegram": "telegram_api",
        "web": "web_fetch",
        "claude": "claude_cli",
    }

    # Résoudre l'alias si nécessaire
    resolved_name = aliases.get(name, name)

    # Récupérer la valeur
    if hasattr(config, resolved_name):
        return getattr(config, resolved_name)

    raise ValueError(
        f"Timeout '{name}' inconnu. "
        f"Valeurs acceptées: {list(aliases.keys()) + list(vars(config).keys())}"
    )


def reset_timeout_config() -> None:
    """
    Réinitialise la configuration globale.

    Utile pour les tests ou après modification des env vars.

    Example:
        >>> os.environ['TIMEOUT_GITHUB_API'] = '60'
        >>> reset_timeout_config()
        >>> get_timeout('github')
        60
    """
    global _default_config
    _default_config = None
