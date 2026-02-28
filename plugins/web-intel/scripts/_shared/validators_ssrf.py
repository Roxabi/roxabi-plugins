#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SSRF (Server-Side Request Forgery) protection utilities.

Provides validation to prevent requests to internal/private resources.
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Optional, Tuple

from urllib.parse import urlparse

from validators_url import URLValidationError, ALLOWED_SCHEMES

# Private IP ranges (RFC 1918 + RFC 6598 + RFC 5737)
PRIVATE_IP_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),  # Class A private
    ipaddress.ip_network("172.16.0.0/12"),  # Class B private
    ipaddress.ip_network("192.168.0.0/16"),  # Class C private
    ipaddress.ip_network("127.0.0.0/8"),  # Loopback
    ipaddress.ip_network("169.254.0.0/16"),  # Link-local
    ipaddress.ip_network("100.64.0.0/10"),  # Carrier-grade NAT (RFC 6598)
    ipaddress.ip_network("192.0.0.0/24"),  # IETF Protocol Assignments
    ipaddress.ip_network("192.0.2.0/24"),  # TEST-NET-1
    ipaddress.ip_network("198.51.100.0/24"),  # TEST-NET-2
    ipaddress.ip_network("203.0.113.0/24"),  # TEST-NET-3
    ipaddress.ip_network("224.0.0.0/4"),  # Multicast
    ipaddress.ip_network("240.0.0.0/4"),  # Reserved
    ipaddress.ip_network("255.255.255.255/32"),  # Broadcast
    ipaddress.ip_network("0.0.0.0/8"),  # "This Network" (RFC 5735)
    # IPv6 private ranges
    ipaddress.ip_network("::1/128"),  # Loopback
    ipaddress.ip_network("fc00::/7"),  # Unique local addresses
    ipaddress.ip_network("fe80::/10"),  # Link-local
    ipaddress.ip_network("ff00::/8"),  # Multicast
]

# Blocked hostnames patterns
BLOCKED_HOSTNAMES = frozenset(
    [
        "localhost",
        "localhost.localdomain",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "[::1]",
        # AWS metadata endpoints
        "169.254.169.254",
        "metadata.google.internal",
        "metadata",
        # Common internal hostnames
        "internal",
        "local",
        "corp",
        "intranet",
    ]
)


class SSRFError(URLValidationError):
    """
    SSRF (Server-Side Request Forgery) protection error.

    Raised when a URL points to internal/private resources.
    """

    pass


def is_private_ip(ip_str: str) -> bool:
    """
    Check if an IP address is private or reserved.

    Args:
        ip_str: IP address string (IPv4 or IPv6)

    Returns:
        True if IP is private/reserved, False otherwise
    """
    try:
        ip = ipaddress.ip_address(ip_str)
        for network in PRIVATE_IP_NETWORKS:
            if ip in network:
                return True
        return False
    except ValueError:
        # Invalid IP format - consider it potentially unsafe
        return True


def is_blocked_hostname(hostname: str) -> bool:
    """
    Check if a hostname is in the blocked list.

    Args:
        hostname: Hostname to check

    Returns:
        True if hostname is blocked
    """
    hostname_lower = hostname.lower().strip()

    # Direct match
    if hostname_lower in BLOCKED_HOSTNAMES:
        return True

    # Check if it ends with a blocked pattern
    for blocked in BLOCKED_HOSTNAMES:
        if hostname_lower.endswith(f".{blocked}"):
            return True

    return False


def validate_url_ssrf(
    url: str,
    resolve_hostname: bool = True,
    allowed_schemes: Optional[frozenset[str]] = None,
) -> Tuple[bool, Optional[str]]:
    """
    Validate a URL for SSRF vulnerabilities.

    Checks:
    - Scheme is http or https only
    - Hostname is not a private/blocked hostname
    - Resolved IP is not in private ranges (if resolve_hostname=True)

    Args:
        url: URL to validate
        resolve_hostname: Whether to DNS-resolve the hostname and check the IP
        allowed_schemes: Allowed URL schemes (default: http, https)

    Returns:
        Tuple (is_safe: bool, error_message: str | None)

    Example:
        >>> valid, error = validate_url_ssrf("https://api.example.com/data")
        >>> if not valid:
        ...     raise SSRFError(error)
    """
    if not url or not isinstance(url, str):
        return False, "URL vide ou invalide"

    url = url.strip()
    schemes = allowed_schemes or ALLOWED_SCHEMES

    try:
        parsed = urlparse(url)
    except Exception as e:
        return False, f"Impossible de parser l'URL: {e}"

    # Check scheme
    if parsed.scheme not in schemes:
        return False, f"Schéma non autorisé: {parsed.scheme}. Utilisez http ou https."

    # Check for missing hostname
    if not parsed.netloc:
        return False, "Hostname manquant dans l'URL"

    # Extract hostname (remove port if present)
    hostname = parsed.netloc.lower()
    if "@" in hostname:
        # Handle user:pass@host format (could be used for bypass)
        hostname = hostname.split("@")[-1]
    # Handle IPv6 brackets before port stripping
    if hostname.startswith("["):
        bracket_end = hostname.find("]")
        if bracket_end != -1:
            hostname = hostname[1:bracket_end]
        else:
            return False, "Malformed IPv6 address (missing closing bracket)"
    elif ":" in hostname:
        hostname = hostname.rsplit(":", 1)[0]

    # Check blocked hostnames
    if is_blocked_hostname(hostname):
        return False, f"Hostname bloqué (interne/réservé): {hostname}"

    # Check if hostname is a direct IP
    try:
        ip = ipaddress.ip_address(hostname)
        if is_private_ip(str(ip)):
            return False, f"Adresse IP privée/réservée non autorisée: {hostname}"
    except ValueError:
        # Not a direct IP - it's a hostname, proceed to DNS resolution
        pass

    # DNS resolution check
    if resolve_hostname:
        try:
            # Get all IPs for hostname
            addr_info = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC)
            for family, _, _, _, sockaddr in addr_info:
                ip_str = str(sockaddr[0])
                if is_private_ip(ip_str):
                    return False, (f"Le hostname '{hostname}' résout vers une IP privée: {ip_str}")
        except socket.gaierror:
            # DNS resolution failed - hostname doesn't exist or DNS issue
            # We allow this to proceed (the actual request will fail anyway)
            pass
        except Exception:
            # Other socket errors - log but allow
            pass

    return True, None


def validate_url_ssrf_strict(url: str, resolve_hostname: bool = True) -> str:
    """
    Validate URL for SSRF and raise exception if unsafe.

    Args:
        url: URL to validate
        resolve_hostname: Whether to DNS-resolve and check IP

    Returns:
        Validated URL

    Raises:
        SSRFError: If URL points to private/internal resources
    """
    is_safe, error = validate_url_ssrf(url, resolve_hostname=resolve_hostname)
    if not is_safe:
        raise SSRFError(error or "URL non sécurisée (SSRF)", field="url", value=url)
    return url.strip()
