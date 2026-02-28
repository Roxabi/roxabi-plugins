"""
Cache fichier pour les content fetchers.

Evite de re-fetcher le meme contenu (meme URL) en stockant les resultats
sur disque avec un TTL configurable.

Fonctionnalites:
- Cle basee sur l'URL (normalisee + hashee)
- TTL configurable (defaut: 1h metadata, 24h contenu complet)
- Stockage fichier pour persister entre les redemarrages
- Taille max configurable (defaut: 100 entrees, 50MB)
- Invalidation par URL ou globale
- Thread-safe via file locking

Configuration via variables d'environnement:
- CACHE_DIR: Repertoire de stockage (defaut: ~/.cache/roxabi/scraper)
- CACHE_TTL_METADATA: TTL metadata en secondes (defaut: 3600 = 1h)
- CACHE_TTL_CONTENT: TTL contenu complet en secondes (defaut: 86400 = 24h)
- CACHE_MAX_ENTRIES: Nombre max d'entrees (defaut: 100)
- CACHE_MAX_SIZE_MB: Taille max en MB (defaut: 50)
- CACHE_ENABLED: Activer/desactiver le cache (defaut: true)

Usage:
    from content_cache import ContentCache, cached_fetch

    # Utilisation directe
    cache = ContentCache()
    result = cache.get("https://example.com/page")
    if result is None:
        result = fetch_content(url)
        cache.set("https://example.com/page", result, ttl_type="content")

    # Decorateur pour fonctions de fetch
    @cached_fetch(ttl_type="content")
    def fetch_twitter_content(url, **kwargs):
        ...

    # Invalidation
    cache.invalidate("https://example.com/page")
    cache.clear()
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Default TTLs (seconds)
DEFAULT_TTL_METADATA = 3600  # 1 hour
DEFAULT_TTL_CONTENT = 86400  # 24 hours

# Default limits
DEFAULT_MAX_ENTRIES = 100
DEFAULT_MAX_SIZE_MB = 50

# Default cache directory
DEFAULT_CACHE_DIR = Path.home() / ".cache" / "roxabi" / "scraper"


@dataclass
class CacheConfig:
    """
    Configuration du cache content fetcher.

    Attributes:
        cache_dir: Repertoire de stockage des fichiers cache
        ttl_metadata: TTL pour les metadonnees en secondes (defaut: 1h)
        ttl_content: TTL pour le contenu complet en secondes (defaut: 24h)
        max_entries: Nombre maximum d'entrees dans le cache (defaut: 100)
        max_size_mb: Taille maximale du cache en MB (defaut: 50)
        enabled: Cache actif ou non (defaut: True)

    Example:
        >>> config = CacheConfig()
        >>> config.ttl_content
        86400

        >>> config = CacheConfig.from_env()
        >>> # Reads CACHE_TTL_CONTENT, CACHE_MAX_ENTRIES, etc.
    """

    cache_dir: Path = field(default_factory=lambda: DEFAULT_CACHE_DIR)
    ttl_metadata: int = DEFAULT_TTL_METADATA
    ttl_content: int = DEFAULT_TTL_CONTENT
    max_entries: int = DEFAULT_MAX_ENTRIES
    max_size_mb: int = DEFAULT_MAX_SIZE_MB
    enabled: bool = True

    @classmethod
    def from_env(cls) -> "CacheConfig":
        """
        Cree une config depuis les variables d'environnement.

        Variables supportees:
        - CACHE_DIR: Chemin du repertoire cache
        - CACHE_TTL_METADATA: TTL metadata en secondes
        - CACHE_TTL_CONTENT: TTL contenu en secondes
        - CACHE_MAX_ENTRIES: Nombre max d'entrees
        - CACHE_MAX_SIZE_MB: Taille max en MB
        - CACHE_ENABLED: "true"/"false"

        Returns:
            CacheConfig avec valeurs de l'environnement
        """
        defaults = cls()

        def _int_env(name: str, default: int) -> int:
            val = os.getenv(name)
            if val is not None:
                try:
                    return int(val)
                except ValueError:
                    pass
            return default

        cache_dir_str = os.getenv("CACHE_DIR")
        cache_dir = Path(cache_dir_str) if cache_dir_str else defaults.cache_dir

        enabled_str = os.getenv("CACHE_ENABLED", "true").lower()
        enabled = enabled_str not in ("false", "0", "no", "off")

        return cls(
            cache_dir=cache_dir,
            ttl_metadata=_int_env("CACHE_TTL_METADATA", defaults.ttl_metadata),
            ttl_content=_int_env("CACHE_TTL_CONTENT", defaults.ttl_content),
            max_entries=_int_env("CACHE_MAX_ENTRIES", defaults.max_entries),
            max_size_mb=_int_env("CACHE_MAX_SIZE_MB", defaults.max_size_mb),
            enabled=enabled,
        )

    def get_ttl(self, ttl_type: str) -> int:
        """
        Retourne le TTL selon le type.

        Args:
            ttl_type: "metadata" ou "content"

        Returns:
            TTL en secondes
        """
        if ttl_type == "metadata":
            return self.ttl_metadata
        return self.ttl_content


def _normalize_url(url: str) -> str:
    """
    Normalise une URL pour utilisation comme cle de cache.

    Supprime les fragments, normalise le scheme et le domaine.
    Deux URLs equivalentes doivent produire la meme cle.

    Args:
        url: URL brute

    Returns:
        URL normalisee
    """
    if not url:
        return ""

    # Strip whitespace
    url = url.strip()

    # Remove fragment
    url = url.split("#")[0]

    # Normalize common domain variations
    url = url.replace("www.twitter.com", "x.com")
    url = url.replace("twitter.com", "x.com")
    url = url.replace("old.reddit.com", "reddit.com")
    url = url.replace("www.reddit.com", "reddit.com")

    # Remove trailing slash
    url = url.rstrip("/")

    # Lowercase scheme and domain
    if "://" in url:
        scheme_rest = url.split("://", 1)
        if len(scheme_rest) == 2:
            scheme = scheme_rest[0].lower()
            rest = scheme_rest[1]
            # Lowercase the domain part only
            if "/" in rest:
                domain, path = rest.split("/", 1)
                url = f"{scheme}://{domain.lower()}/{path}"
            else:
                url = f"{scheme}://{rest.lower()}"

    return url


def _url_to_key(url: str) -> str:
    """
    Convertit une URL normalisee en cle de fichier cache.

    Utilise SHA256 pour un hash deterministe et filesystem-safe.

    Args:
        url: URL (sera normalisee)

    Returns:
        Hash SHA256 de l'URL normalisee (64 chars hex)
    """
    normalized = _normalize_url(url)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


@dataclass
class CacheEntry:
    """
    Entree de cache avec metadata.

    Attributes:
        url: URL originale
        data: Donnees cachees (dict JSON-serializable)
        created_at: Timestamp de creation (epoch)
        ttl: TTL en secondes
        ttl_type: Type de TTL ("metadata" ou "content")
        fetcher: Nom du fetcher source (twitter, youtube, etc.)
    """

    url: str
    data: dict[str, Any]
    created_at: float
    ttl: int
    ttl_type: str = "content"
    fetcher: str = ""

    @property
    def expires_at(self) -> float:
        """Timestamp d'expiration."""
        return self.created_at + self.ttl

    @property
    def is_expired(self) -> bool:
        """Verifie si l'entree a expire."""
        return time.time() > self.expires_at

    @property
    def age_seconds(self) -> float:
        """Age de l'entree en secondes."""
        return time.time() - self.created_at

    def to_dict(self) -> dict[str, Any]:
        """Serialise en dict pour stockage JSON."""
        return {
            "url": self.url,
            "data": self.data,
            "created_at": self.created_at,
            "ttl": self.ttl,
            "ttl_type": self.ttl_type,
            "fetcher": self.fetcher,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CacheEntry":
        """Deserialise depuis un dict JSON."""
        return cls(
            url=d["url"],
            data=d["data"],
            created_at=d["created_at"],
            ttl=d["ttl"],
            ttl_type=d.get("ttl_type", "content"),
            fetcher=d.get("fetcher", ""),
        )


class ContentCache:
    """
    Cache fichier pour les content fetchers.

    Stocke les resultats de fetch sur disque avec TTL configurable.
    Thread-safe via threading.Lock.

    Example:
        >>> cache = ContentCache()
        >>> # Check cache
        >>> result = cache.get("https://x.com/user/status/123")
        >>> if result is None:
        ...     result = fetch_content(url)
        ...     cache.set("https://x.com/user/status/123", result, ttl_type="content")
        >>> # Invalidation
        >>> cache.invalidate("https://x.com/user/status/123")
        >>> cache.clear()
    """

    def __init__(self, config: Optional[CacheConfig] = None):
        """
        Initialise le cache.

        Args:
            config: Configuration (si None, charge depuis env vars)
        """
        self._config = config or CacheConfig.from_env()
        self._lock = threading.Lock()
        self._ensure_cache_dir()

    @property
    def config(self) -> CacheConfig:
        """Configuration du cache."""
        return self._config

    def _ensure_cache_dir(self) -> None:
        """Cree le repertoire de cache s'il n'existe pas."""
        try:
            self._config.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            logger.warning("Cannot create cache directory %s: %s", self._config.cache_dir, e)

    def _entry_path(self, key: str) -> Path:
        """Chemin du fichier cache pour une cle donnee."""
        return self._config.cache_dir / f"{key}.json"

    def get(self, url: str) -> Optional[dict[str, Any]]:
        """
        Recupere une entree du cache.

        Retourne None si l'entree n'existe pas, a expire, ou si le cache
        est desactive.

        Args:
            url: URL a chercher dans le cache

        Returns:
            Donnees cachees (dict) ou None si cache miss

        Example:
            >>> cache = ContentCache()
            >>> result = cache.get("https://x.com/user/status/123")
            >>> if result is not None:
            ...     print("Cache hit!")
        """
        if not self._config.enabled:
            return None

        key = _url_to_key(url)
        entry_path = self._entry_path(key)

        with self._lock:
            try:
                if not entry_path.exists():
                    return None

                raw = entry_path.read_text(encoding="utf-8")
                entry_dict = json.loads(raw)
                entry = CacheEntry.from_dict(entry_dict)

                if entry.is_expired:
                    # Remove expired entry
                    self._remove_entry(entry_path)
                    logger.debug(
                        "Cache expired for %s (age: %.0fs, ttl: %ds)",
                        url,
                        entry.age_seconds,
                        entry.ttl,
                    )
                    return None

                logger.debug(
                    "Cache hit for %s (age: %.0fs, ttl: %ds, fetcher: %s)",
                    url,
                    entry.age_seconds,
                    entry.ttl,
                    entry.fetcher,
                )
                return entry.data

            except (json.JSONDecodeError, KeyError, TypeError) as e:
                logger.warning("Corrupt cache entry for %s: %s", url, e)
                self._remove_entry(entry_path)
                return None
            except OSError as e:
                logger.warning("Cannot read cache for %s: %s", url, e)
                return None

    def set(
        self,
        url: str,
        data: dict[str, Any],
        ttl_type: str = "content",
        fetcher: str = "",
    ) -> bool:
        """
        Stocke une entree dans le cache.

        Applique les limites de taille et nombre d'entrees. N'ecrit pas
        si le cache est desactive ou si les donnees ne sont pas succes.

        Args:
            url: URL source du contenu
            data: Donnees a cacher (dict JSON-serializable)
            ttl_type: Type de TTL ("metadata" ou "content")
            fetcher: Nom du fetcher source (pour debug/stats)

        Returns:
            True si l'ecriture a reussi, False sinon

        Example:
            >>> cache = ContentCache()
            >>> result = {"success": True, "text": "Hello"}
            >>> cache.set("https://example.com", result, ttl_type="content", fetcher="twitter")
            True
        """
        if not self._config.enabled:
            return False

        # Don't cache failed fetches
        if not data.get("success", False):
            return False

        key = _url_to_key(url)
        entry_path = self._entry_path(key)

        entry = CacheEntry(
            url=url,
            data=data,
            created_at=time.time(),
            ttl=self._config.get_ttl(ttl_type),
            ttl_type=ttl_type,
            fetcher=fetcher,
        )

        with self._lock:
            try:
                # Serialize
                entry_json = json.dumps(entry.to_dict(), ensure_ascii=False)

                # Check if this single entry exceeds reasonable size (1MB)
                entry_size = len(entry_json.encode("utf-8"))
                if entry_size > 1_000_000:
                    logger.warning(
                        "Cache entry too large for %s: %d bytes, skipping",
                        url,
                        entry_size,
                    )
                    return False

                # Enforce limits before writing
                self._enforce_limits()

                # Write atomically (write to tmp then rename)
                tmp_path = entry_path.with_suffix(".tmp")
                tmp_path.write_text(entry_json, encoding="utf-8")
                tmp_path.rename(entry_path)

                logger.debug(
                    "Cache set for %s (ttl_type: %s, ttl: %ds, size: %d bytes, fetcher: %s)",
                    url,
                    ttl_type,
                    entry.ttl,
                    entry_size,
                    fetcher,
                )
                return True

            except OSError as e:
                logger.warning("Cannot write cache for %s: %s", url, e)
                return False
            except (TypeError, ValueError) as e:
                logger.warning("Cannot serialize cache data for %s: %s", url, e)
                return False

    def invalidate(self, url: str) -> bool:
        """
        Supprime une entree specifique du cache.

        Args:
            url: URL a supprimer du cache

        Returns:
            True si l'entree existait et a ete supprimee

        Example:
            >>> cache = ContentCache()
            >>> cache.invalidate("https://x.com/user/status/123")
            True
        """
        key = _url_to_key(url)
        entry_path = self._entry_path(key)

        with self._lock:
            if entry_path.exists():
                self._remove_entry(entry_path)
                logger.debug("Cache invalidated for %s", url)
                return True
            return False

    def clear(self) -> int:
        """
        Supprime toutes les entrees du cache.

        Returns:
            Nombre d'entrees supprimees

        Example:
            >>> cache = ContentCache()
            >>> count = cache.clear()
            >>> print(f"{count} entries cleared")
        """
        with self._lock:
            count = 0
            try:
                for entry_path in self._config.cache_dir.glob("*.json"):
                    self._remove_entry(entry_path)
                    count += 1
                logger.info("Cache cleared: %d entries removed", count)
            except OSError as e:
                logger.warning("Error clearing cache: %s", e)
            return count

    def stats(self) -> dict[str, Any]:
        """
        Retourne les statistiques du cache.

        Returns:
            Dict avec total_entries, total_size_bytes, expired_count,
            by_fetcher, oldest_entry, newest_entry

        Example:
            >>> cache = ContentCache()
            >>> stats = cache.stats()
            >>> print(f"Entries: {stats['total_entries']}, Size: {stats['total_size_mb']:.1f}MB")
        """
        with self._lock:
            total_entries = 0
            total_size = 0
            expired_count = 0
            by_fetcher: dict[str, int] = {}
            oldest: Optional[float] = None
            newest: Optional[float] = None

            try:
                for entry_path in self._config.cache_dir.glob("*.json"):
                    total_entries += 1
                    try:
                        stat = entry_path.stat()
                        total_size += stat.st_size

                        raw = entry_path.read_text(encoding="utf-8")
                        entry_dict = json.loads(raw)
                        entry = CacheEntry.from_dict(entry_dict)

                        if entry.is_expired:
                            expired_count += 1

                        fetcher = entry.fetcher or "unknown"
                        by_fetcher[fetcher] = by_fetcher.get(fetcher, 0) + 1

                        if oldest is None or entry.created_at < oldest:
                            oldest = entry.created_at
                        if newest is None or entry.created_at > newest:
                            newest = entry.created_at

                    except (json.JSONDecodeError, KeyError, OSError):
                        expired_count += 1  # Count corrupt entries as expired

            except OSError:
                pass

            return {
                "enabled": self._config.enabled,
                "cache_dir": str(self._config.cache_dir),
                "total_entries": total_entries,
                "total_size_bytes": total_size,
                "total_size_mb": round(total_size / (1024 * 1024), 2),
                "expired_count": expired_count,
                "valid_entries": total_entries - expired_count,
                "by_fetcher": by_fetcher,
                "max_entries": self._config.max_entries,
                "max_size_mb": self._config.max_size_mb,
                "ttl_metadata_seconds": self._config.ttl_metadata,
                "ttl_content_seconds": self._config.ttl_content,
            }

    def cleanup(self) -> int:
        """
        Supprime les entrees expirees et corruptes.

        Returns:
            Nombre d'entrees supprimees

        Example:
            >>> cache = ContentCache()
            >>> removed = cache.cleanup()
            >>> print(f"{removed} expired entries removed")
        """
        with self._lock:
            return self._cleanup_expired()

    def _remove_entry(self, path: Path) -> None:
        """Supprime un fichier cache (sans lock, appeler depuis un contexte locke)."""
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def _cleanup_expired(self) -> int:
        """Supprime les entrees expirees (sans lock)."""
        removed = 0
        try:
            for entry_path in self._config.cache_dir.glob("*.json"):
                try:
                    raw = entry_path.read_text(encoding="utf-8")
                    entry_dict = json.loads(raw)
                    entry = CacheEntry.from_dict(entry_dict)

                    if entry.is_expired:
                        self._remove_entry(entry_path)
                        removed += 1

                except (json.JSONDecodeError, KeyError, TypeError):
                    # Corrupt entry, remove it
                    self._remove_entry(entry_path)
                    removed += 1
                except OSError:
                    pass

        except OSError:
            pass

        if removed > 0:
            logger.debug("Cleanup: %d expired/corrupt entries removed", removed)
        return removed

    def _enforce_limits(self) -> None:
        """
        Applique les limites de taille et nombre d'entrees (sans lock).

        Strategie d'eviction: supprime d'abord les expirees, puis les
        plus anciennes (LRU-like base sur created_at).
        """
        # 1. Clean expired first
        self._cleanup_expired()

        # 2. Check entry count
        entries = self._list_entries_sorted()
        while len(entries) >= self._config.max_entries and entries:
            # Remove oldest
            oldest_path = entries.pop(0)[1]
            self._remove_entry(oldest_path)
            logger.debug("Evicted oldest cache entry (max entries: %d)", self._config.max_entries)

        # 3. Check total size
        max_bytes = self._config.max_size_mb * 1024 * 1024
        total_size = self._get_total_size()

        if total_size > max_bytes:
            # Re-fetch sorted entries after possible eviction above
            entries = self._list_entries_sorted()
            while total_size > max_bytes and entries:
                oldest_created_at, oldest_path = entries.pop(0)
                try:
                    entry_size = oldest_path.stat().st_size
                    self._remove_entry(oldest_path)
                    total_size -= entry_size
                    logger.debug(
                        "Evicted cache entry for size (%.1fMB / %.1fMB max)",
                        total_size / (1024 * 1024),
                        self._config.max_size_mb,
                    )
                except OSError:
                    self._remove_entry(oldest_path)

    def _list_entries_sorted(self) -> list[tuple[float, Path]]:
        """
        Liste les entrees triees par created_at (plus ancien en premier).

        Returns:
            Liste de tuples (created_at, path) triee par age decroissant
        """
        entries: list[tuple[float, Path]] = []
        try:
            for entry_path in self._config.cache_dir.glob("*.json"):
                try:
                    raw = entry_path.read_text(encoding="utf-8")
                    entry_dict = json.loads(raw)
                    created_at = entry_dict.get("created_at", 0)
                    entries.append((created_at, entry_path))
                except (json.JSONDecodeError, OSError):
                    # Corrupt entry - put at front for eviction
                    entries.append((0, entry_path))
        except OSError:
            pass

        entries.sort(key=lambda x: x[0])
        return entries

    def _get_total_size(self) -> int:
        """Taille totale du cache en bytes."""
        total = 0
        try:
            for entry_path in self._config.cache_dir.glob("*.json"):
                try:
                    total += entry_path.stat().st_size
                except OSError:
                    pass
        except OSError:
            pass
        return total


# Global cache instance (lazy-initialized)
_global_cache: Optional[ContentCache] = None
_global_cache_lock = threading.Lock()


def get_cache() -> ContentCache:
    """
    Retourne l'instance globale du cache.

    Cree une instance au premier appel avec configuration depuis env vars.

    Returns:
        ContentCache global

    Example:
        >>> cache = get_cache()
        >>> result = cache.get("https://example.com")
    """
    global _global_cache
    if _global_cache is None:
        with _global_cache_lock:
            if _global_cache is None:
                _global_cache = ContentCache()
    return _global_cache


def reset_cache() -> None:
    """
    Reinitialise l'instance globale du cache.

    Utile pour les tests ou apres modification des env vars.
    """
    global _global_cache
    with _global_cache_lock:
        _global_cache = None


def cached_fetch(
    ttl_type: str = "content",
    fetcher: str = "",
) -> Callable:
    """
    Decorateur pour ajouter du caching transparent a une fonction de fetch.

    La fonction decoree doit:
    - Accepter une URL comme premier argument
    - Retourner un dict avec au minimum une cle "success"

    Le cache n'est utilise que si la fonction retourne {"success": True}.
    Les resultats en erreur ne sont pas caches.

    Args:
        ttl_type: Type de TTL ("metadata" ou "content")
        fetcher: Nom du fetcher (auto-detecte depuis le nom de la fonction si vide)

    Returns:
        Decorateur

    Example:
        >>> @cached_fetch(ttl_type="content", fetcher="twitter")
        ... def fetch_twitter_content(url, **kwargs):
        ...     # actual fetch logic
        ...     return {"success": True, "text": "..."}
        >>>
        >>> # Premier appel: fetch reel
        >>> result = fetch_twitter_content("https://x.com/user/status/123")
        >>> # Deuxieme appel: retourne depuis le cache
        >>> result = fetch_twitter_content("https://x.com/user/status/123")
    """

    def decorator(func: Callable[..., dict[str, Any]]) -> Callable[..., dict[str, Any]]:
        _fetcher = fetcher or func.__name__.replace("fetch_", "").replace("_content", "")

        def wrapper(url: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
            cache = get_cache()

            # Try cache first
            cached = cache.get(url)
            if cached is not None:
                # Add cache metadata
                cached["_from_cache"] = True
                return cached

            # Cache miss - call actual function
            result = func(url, *args, **kwargs)

            # Cache successful results
            if isinstance(result, dict) and result.get("success", False):
                cache.set(url, result, ttl_type=ttl_type, fetcher=_fetcher)

            return result

        # Preserve original function attributes
        wrapper.__name__ = func.__name__
        wrapper.__doc__ = func.__doc__
        wrapper.__module__ = func.__module__
        wrapper.__qualname__ = func.__qualname__

        return wrapper

    return decorator
