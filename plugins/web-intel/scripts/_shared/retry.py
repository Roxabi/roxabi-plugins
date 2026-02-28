"""
Retry avec backoff exponentiel pour les appels HTTP.

Fournit un decorateur et une fonction utilitaire pour retenter
automatiquement les operations qui echouent sur des erreurs transient
(timeout, 429, 5xx, ConnectionError).

Ne retry PAS sur les erreurs permanentes (400, 401, 403, 404).

Usage:
    from retry import retry_on_transient, retry_call

    # Comme decorateur
    @retry_on_transient(max_retries=3, initial_delay=1.0)
    def fetch_data(url):
        return requests.get(url, timeout=10)

    # Comme fonction utilitaire
    response = retry_call(
        lambda: requests.get(url, timeout=10),
        max_retries=3,
        initial_delay=1.0,
    )
"""

from __future__ import annotations

import logging
import random
import time
from functools import wraps
from typing import Any, Callable, Optional, TypeVar

import requests

logger = logging.getLogger(__name__)

T = TypeVar("T")

# HTTP status codes considered transient (retryable)
TRANSIENT_STATUS_CODES: frozenset[int] = frozenset([429, 500, 502, 503, 504])

# HTTP status codes considered permanent (NOT retryable)
PERMANENT_STATUS_CODES: frozenset[int] = frozenset([400, 401, 403, 404])

# Exception types considered transient (retryable)
TRANSIENT_EXCEPTIONS: tuple[type[Exception], ...] = (
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
    ConnectionError,
    TimeoutError,
    OSError,
)

# Default retry parameters
DEFAULT_MAX_RETRIES = 3
DEFAULT_INITIAL_DELAY = 1.0
DEFAULT_MULTIPLIER = 2.0
DEFAULT_MAX_DELAY = 30.0
DEFAULT_JITTER_RANGE = 0.5  # +/- 50% of computed delay


class RetryConfig:
    """
    Configuration pour le retry avec backoff exponentiel.

    Attributes:
        max_retries: Nombre maximum de tentatives (defaut: 3)
        initial_delay: Delai initial en secondes (defaut: 1.0)
        multiplier: Facteur multiplicatif pour le backoff (defaut: 2.0)
        max_delay: Delai maximum en secondes (defaut: 30.0)
        jitter_range: Amplitude du jitter aleatoire 0.0-1.0 (defaut: 0.5)
        transient_status_codes: Codes HTTP retryables
        transient_exceptions: Types d'exceptions retryables

    Example:
        >>> config = RetryConfig(max_retries=5, initial_delay=0.5)
        >>> config.compute_delay(attempt=2)
        2.0  # 0.5 * 2^2 (sans jitter)
    """

    def __init__(
        self,
        max_retries: int = DEFAULT_MAX_RETRIES,
        initial_delay: float = DEFAULT_INITIAL_DELAY,
        multiplier: float = DEFAULT_MULTIPLIER,
        max_delay: float = DEFAULT_MAX_DELAY,
        jitter_range: float = DEFAULT_JITTER_RANGE,
        transient_status_codes: Optional[frozenset[int]] = None,
        transient_exceptions: Optional[tuple[type[Exception], ...]] = None,
    ):
        self.max_retries = max_retries
        self.initial_delay = initial_delay
        self.multiplier = multiplier
        self.max_delay = max_delay
        self.jitter_range = jitter_range
        self.transient_status_codes = (
            transient_status_codes if transient_status_codes is not None else TRANSIENT_STATUS_CODES
        )
        self.transient_exceptions = (
            transient_exceptions if transient_exceptions is not None else TRANSIENT_EXCEPTIONS
        )

    def compute_delay(self, attempt: int) -> float:
        """
        Calcule le delai avec backoff exponentiel et jitter.

        Args:
            attempt: Numero de la tentative (0-indexed)

        Returns:
            Delai en secondes avec jitter aleatoire

        Example:
            >>> config = RetryConfig(initial_delay=1.0, multiplier=2.0)
            >>> # attempt 0: ~1s, attempt 1: ~2s, attempt 2: ~4s
        """
        base_delay = self.initial_delay * (self.multiplier**attempt)
        base_delay = min(base_delay, self.max_delay)

        # Apply jitter: delay * (1 +/- jitter_range * random)
        if self.jitter_range > 0:
            jitter = 1.0 + self.jitter_range * (2 * random.random() - 1)
            base_delay *= jitter

        return max(0, base_delay)


def is_transient_error(
    exception: Exception,
    config: Optional[RetryConfig] = None,
) -> bool:
    """
    Determine si une exception represente une erreur transient (retryable).

    Retryable:
    - requests.exceptions.ConnectionError
    - requests.exceptions.Timeout
    - ConnectionError, TimeoutError, OSError
    - requests.exceptions.HTTPError with status 429, 500, 502, 503, 504

    NOT retryable:
    - requests.exceptions.HTTPError with status 400, 401, 403, 404
    - ValueError, TypeError, KeyError, etc.
    - Any other non-network exception

    Args:
        exception: Exception a evaluer
        config: Configuration (utilise les defauts si None)

    Returns:
        True si l'erreur est transient et doit etre retentee
    """
    cfg = config or RetryConfig()

    # Check transient exception types
    if isinstance(exception, cfg.transient_exceptions):
        return True

    # Check HTTP errors by status code
    if isinstance(exception, requests.exceptions.HTTPError):
        response = exception.response
        if response is not None:
            return response.status_code in cfg.transient_status_codes
        # No response object - treat as transient (network issue)
        return True

    return False


def is_transient_status_code(
    status_code: int,
    config: Optional[RetryConfig] = None,
) -> bool:
    """
    Determine si un code HTTP est transient (retryable).

    Args:
        status_code: Code HTTP a evaluer
        config: Configuration (utilise les defauts si None)

    Returns:
        True si le code est transient (429, 500, 502, 503, 504)
    """
    cfg = config or RetryConfig()
    return status_code in cfg.transient_status_codes


def retry_call(
    func: Callable[[], T],
    max_retries: int = DEFAULT_MAX_RETRIES,
    initial_delay: float = DEFAULT_INITIAL_DELAY,
    multiplier: float = DEFAULT_MULTIPLIER,
    max_delay: float = DEFAULT_MAX_DELAY,
    jitter_range: float = DEFAULT_JITTER_RANGE,
    on_retry: Optional[Callable[[int, Exception, float], None]] = None,
    config: Optional[RetryConfig] = None,
) -> T:
    """
    Execute une fonction avec retry et backoff exponentiel.

    Retente uniquement sur les erreurs transient (timeout, 429, 5xx,
    ConnectionError). Les erreurs permanentes (400, 401, 403, 404)
    sont propagees immediatement.

    Args:
        func: Fonction a executer (sans arguments)
        max_retries: Nombre maximum de retries (defaut: 3)
        initial_delay: Delai initial en secondes (defaut: 1.0)
        multiplier: Facteur multiplicatif (defaut: 2.0)
        max_delay: Delai maximum en secondes (defaut: 30.0)
        jitter_range: Amplitude du jitter 0.0-1.0 (defaut: 0.5)
        on_retry: Callback appele avant chaque retry (attempt, exception, delay)
        config: RetryConfig (override les parametres individuels si fourni)

    Returns:
        Resultat de la fonction

    Raises:
        Exception: Derniere exception si tous les retries echouent,
                   ou exception permanente immediatement

    Example:
        >>> import requests
        >>> response = retry_call(
        ...     lambda: requests.get("https://api.example.com/data", timeout=10),
        ...     max_retries=3,
        ...     initial_delay=1.0,
        ... )
    """
    cfg = config or RetryConfig(
        max_retries=max_retries,
        initial_delay=initial_delay,
        multiplier=multiplier,
        max_delay=max_delay,
        jitter_range=jitter_range,
    )

    last_exception: Optional[Exception] = None

    for attempt in range(cfg.max_retries + 1):  # +1 for the initial attempt
        try:
            return func()

        except Exception as e:
            last_exception = e

            # Check if error is transient
            if not is_transient_error(e, cfg):
                logger.debug(
                    "Permanent error (not retrying): %s: %s",
                    type(e).__name__,
                    e,
                )
                raise

            # Check if we have retries left
            if attempt >= cfg.max_retries:
                logger.warning(
                    "All %d retries exhausted. Last error: %s: %s",
                    cfg.max_retries,
                    type(e).__name__,
                    e,
                )
                raise

            # Compute delay and wait
            delay = cfg.compute_delay(attempt)

            logger.info(
                "Transient error (attempt %d/%d), retrying in %.1fs: %s: %s",
                attempt + 1,
                cfg.max_retries + 1,
                delay,
                type(e).__name__,
                e,
            )

            # Callback before retry
            if on_retry:
                try:
                    on_retry(attempt, e, delay)
                except Exception as cb_err:
                    logger.warning("Error in on_retry callback: %s", cb_err)

            time.sleep(delay)

    # Should not reach here, but just in case
    if last_exception:
        raise last_exception
    raise RuntimeError("Retry loop completed without result or exception")


def retry_on_transient(
    max_retries: int = DEFAULT_MAX_RETRIES,
    initial_delay: float = DEFAULT_INITIAL_DELAY,
    multiplier: float = DEFAULT_MULTIPLIER,
    max_delay: float = DEFAULT_MAX_DELAY,
    jitter_range: float = DEFAULT_JITTER_RANGE,
    on_retry: Optional[Callable[[int, Exception, float], None]] = None,
) -> Callable:
    """
    Decorateur pour retry avec backoff exponentiel.

    Retente uniquement sur les erreurs transient (timeout, 429, 5xx,
    ConnectionError). Les erreurs permanentes sont propagees immediatement.

    Args:
        max_retries: Nombre maximum de retries (defaut: 3)
        initial_delay: Delai initial en secondes (defaut: 1.0)
        multiplier: Facteur multiplicatif (defaut: 2.0)
        max_delay: Delai maximum en secondes (defaut: 30.0)
        jitter_range: Amplitude du jitter 0.0-1.0 (defaut: 0.5)
        on_retry: Callback appele avant chaque retry

    Returns:
        Decorateur

    Example:
        >>> @retry_on_transient(max_retries=3, initial_delay=1.0)
        ... def fetch_data(url):
        ...     response = requests.get(url, timeout=10)
        ...     response.raise_for_status()
        ...     return response.json()
    """
    config = RetryConfig(
        max_retries=max_retries,
        initial_delay=initial_delay,
        multiplier=multiplier,
        max_delay=max_delay,
        jitter_range=jitter_range,
    )

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> T:
            return retry_call(
                lambda: func(*args, **kwargs),
                config=config,
                on_retry=on_retry,
            )

        return wrapper

    return decorator
