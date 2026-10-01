#!/usr/bin/env python3
"""License compliance checker for Python projects.

Python equivalent of tools/licenseChecker.ts for uv/pip projects.
Scans installed packages, checks licenses against an allowlist, and reports
violations. Uses pip-licenses for package introspection.

Plugin source of truth: plugins/dev-core/tools/license_check.py. /R-ci-setup
copies it to tools/license_check.py; in roxabi-plugins, tools/validate_plugins.py
fails when that copy differs from this file.

Usage:
  uv run tools/license_check.py
  uv run tools/license_check.py --json
  uv run tools/license_check.py --policy .license-policy.json
  uv run tools/license_check.py --output reports/licenses.json
  uv run tools/license_check.py --self-test

--self-test proves the gate can fail: a fake pip-licenses on PATH reports a
GPL package, the script must exit 1, and the work tree is never modified.
Exits 0 only when that invocation exits 1.

A license is allowed when it is one of SAFE_LICENSES, or an SPDX expression
over them, evaluated as licenseChecker.ts does: AND binds tighter than OR,
parentheses group, "X WITH Y" is one operand, and an expression that is
malformed or too complex is disallowed. An operand may be several words
("MIT License"), since pip-licenses reports classifier names. pip-licenses
joins several classifiers with ";": every part must be allowed. A package
whose license is UNKNOWN is reported apart and fails the check too.

Exit code: 0 = compliant, 1 = violations or UNKNOWN licenses found, 2 = tool error.

Setup:
  Add pip-licenses to dev dependencies:
    uv add --dev pip-licenses

Policy file (.license-policy.json):
  {
    "allowlist": ["my-package"],
    "overrides": {
      "some-gpl-package": "MIT"
    }
  }
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# SPDX identifiers and common display names considered safe for commercial use.
# Adjust for your project's requirements.
SAFE_LICENSES: set[str] = {
    # MIT
    "MIT",
    "MIT License",
    "MIT license",
    # BSD
    "BSD",
    "BSD License",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSD 2-Clause License",
    "BSD 3-Clause License",
    "BSD 3-Clause",
    # Apache
    "Apache Software License",
    "Apache License 2.0",
    "Apache 2.0",
    "Apache-2.0",
    "Apache License, Version 2.0",
    # ISC
    "ISC",
    "ISC License",
    "ISC License (ISCL)",
    # Python / PSF
    "Python Software Foundation License",
    "PSF",
    "PSFL",
    "PSF-2.0",
    "Python Software Foundation",
    # Mozilla
    "Mozilla Public License 2.0 (MPL 2.0)",
    "MPL-2.0",
    # Public domain
    "Unlicense",
    "The Unlicense",
    "CC0-1.0",
    "CC0 1.0 Universal (CC0 1.0) Public Domain Dedication",
    # LGPL (dynamic linking — generally safe)
    "GNU Lesser General Public License v2 (LGPLv2)",
    "GNU Lesser General Public License v2 or later (LGPLv2+)",
    "GNU Lesser General Public License v3 (LGPLv3)",
    "GNU Lesser General Public License v3 or later (LGPLv3+)",
    "LGPL-2.0",
    "LGPL-2.1",
    "LGPL-3.0",
    # Historical / permissive
    "Historical Permission Notice and Disclaimer (HPND)",
    "Artistic License",
}

# Package metadata is untrusted: a deeply nested expression must not exhaust the
# recursion. Same bounds as licenseChecker.ts.
MAX_EXPRESSION_LENGTH = 512
MAX_OPEN_PARENS = 20

_OPERATORS = ("(", ")", "AND", "OR", "WITH")


def load_policy(policy_path: Path) -> dict:
    if policy_path.exists():
        try:
            return json.loads(policy_path.read_text())
        except json.JSONDecodeError as e:
            print(f"[license-check] Warning: could not parse {policy_path}: {e}", file=sys.stderr)
    return {"allowlist": [], "overrides": {}}


def get_packages() -> list[dict]:
    try:
        result = subprocess.run(
            ["pip-licenses", "--format=json", "--with-urls", "--with-authors"],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(result.stdout)
    except FileNotFoundError:
        print(
            "[license-check] pip-licenses not found.\n"
            "  Install it: uv add --dev pip-licenses",
            file=sys.stderr,
        )
        sys.exit(2)
    except subprocess.CalledProcessError as e:
        print(f"[license-check] pip-licenses failed: {e.stderr}", file=sys.stderr)
        sys.exit(2)


def _tokenize(expr: str) -> list[str]:
    """Parentheses, operators, and operands; consecutive other words form one operand."""
    tokens: list[str] = []
    words: list[str] = []
    for word in re.findall(r"[()]|[^\s()]+", expr):
        if word in _OPERATORS:
            if words:
                tokens.append(" ".join(words))
                words = []
            tokens.append(word)
        else:
            words.append(word)
    if words:
        tokens.append(" ".join(words))
    return tokens


def _is_operand_allowed(operand: str) -> bool:
    # A trailing "+" means "or later": GPL-2.0+ is judged as GPL-2.0.
    return (operand[:-1] if operand.endswith("+") else operand) in SAFE_LICENSES


def _evaluate_spdx(expr: str) -> bool:
    """Recursive descent: OR, then AND, then an operand or a parenthesised group.

    A malformed expression (a stray or unclosed paren, a missing operand, WITH
    without an operand on each side) is disallowed: evaluating only its
    well-formed prefix would let "MIT) AND GPL-3.0" pass.
    """
    tokens = _tokenize(expr)
    pos = 0
    malformed = False

    def peek(offset: int = 0) -> str | None:
        return tokens[pos + offset] if pos + offset < len(tokens) else None

    def parse_or() -> bool:
        nonlocal pos
        result = parse_and()
        while peek() == "OR":
            pos += 1
            right = parse_and()
            result = result or right
        return result

    def parse_and() -> bool:
        nonlocal pos
        result = parse_primary()
        while peek() == "AND":
            pos += 1
            right = parse_primary()
            result = result and right
        return result

    def parse_primary() -> bool:
        nonlocal pos, malformed
        token = peek()
        if token is None or token in (")", "AND", "OR", "WITH"):
            malformed = True  # an operand is missing; the token is left for the caller
            return False
        pos += 1
        if token == "(":
            result = parse_or()
            if peek() == ")":
                pos += 1
            else:
                malformed = True
            return result
        if peek() == "WITH":
            exception = peek(1)
            if exception is None or exception in _OPERATORS:
                malformed = True
                return False
            pos += 2
            return _is_operand_allowed(f"{token} WITH {exception}")
        return _is_operand_allowed(token)

    result = parse_or()
    if not malformed and pos == len(tokens):
        return result
    # A classifier name such as "GNU General Public License v3 (GPLv3)" does not parse
    # either; only a string with an operator in it was written as an expression.
    if any(token in ("AND", "OR", "WITH") for token in tokens):
        print(
            f"[license-check] malformed SPDX expression, treating as disallowed: {expr[:60]!r}",
            file=sys.stderr,
        )
    return False


def is_license_allowed(license_str: str) -> bool:
    """Return True if the license string is a safe license or evaluates to one."""
    if license_str in SAFE_LICENSES:
        return True
    if len(license_str) > MAX_EXPRESSION_LENGTH or license_str.count("(") > MAX_OPEN_PARENS:
        print(
            f"[license-check] expression too complex to evaluate safely, treating as disallowed: {license_str[:60]!r}",
            file=sys.stderr,
        )
        return False
    parts = [part.strip() for part in license_str.split(";") if part.strip()]
    if not parts:
        return False
    if len(parts) > 1 or parts[0] != license_str:
        return all(is_license_allowed(part) for part in parts)
    return _evaluate_spdx(license_str)


def is_covered_by_policy(name: str, policy: dict) -> bool:
    """Return True if the policy names the package explicitly."""
    return name in policy.get("overrides", {}) or name in policy.get("allowlist", [])


def is_compliant(name: str, license_str: str, policy: dict) -> bool:
    """Return True if the package is considered license-compliant."""
    return is_covered_by_policy(name, policy) or is_license_allowed(license_str)


def self_test() -> int:
    """Prove the gate exits 1 on a disallowed license. Never touches the work tree."""
    with tempfile.TemporaryDirectory(prefix="license-check-self-test-") as tmp:
        fake = Path(tmp) / "pip-licenses"
        fake.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' '[{\"Name\":\"evil-gpl\",\"Version\":\"1.0.0\",\"License\":\"GPL-3.0-only\"}]'\n"
        )
        fake.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = f"{tmp}{os.pathsep}{env.get('PATH', '')}"
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve())],
            env=env,
            cwd=tmp,
            capture_output=True,
            text=True,
        )
        if result.returncode != 1:
            print(
                f"ERROR: license_check --self-test: expected exit 1 on GPL-3.0-only, got {result.returncode}",
                file=sys.stderr,
            )
            if result.stderr:
                print(result.stderr, file=sys.stderr)
            return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="License compliance checker")
    parser.add_argument(
        "--policy",
        default=".license-policy.json",
        help="Path to policy file (default: .license-policy.json)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Output JSON report",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Write JSON report to file (e.g. reports/licenses.json)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Prove the gate fails on a fabricated disallowed license (temp dir only)",
    )
    args = parser.parse_args()

    if args.self_test:
        sys.exit(self_test())

    policy = load_policy(Path(args.policy))
    packages = get_packages()

    violations: list[dict] = []
    compliant: list[dict] = []
    unknown: list[dict] = []

    for pkg in packages:
        name = pkg.get("Name", "")
        version = pkg.get("Version", "")
        license_str = pkg.get("License") or "UNKNOWN"
        entry = {"name": name, "version": version, "license": license_str}
        if license_str == "UNKNOWN" and not is_covered_by_policy(name, policy):
            unknown.append(entry)
        elif is_compliant(name, license_str, policy):
            compliant.append(entry)
        else:
            violations.append(entry)

    report = {
        "total": len(packages),
        "compliant": len(compliant),
        "violations": len(violations),
        "unknown": len(unknown),
        "packages": compliant,
        "violating": violations,
        "unresolved": unknown,
    }

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2))

    if args.json_output:
        print(json.dumps(report, indent=2))
    else:
        print(f"License check: {len(packages)} packages scanned")
        if violations:
            print(f"  ❌ {len(violations)} violation(s) found:")
            for v in violations:
                print(f"     {v['name']} ({v['version']}): {v['license']}")
            print()
            print("  Add to .license-policy.json to allow:")
            print('  { "allowlist": [' + ", ".join(f'"{v["name"]}"' for v in violations) + "] }")
        if unknown:
            print(f"  ⚠️  {len(unknown)} package(s) with UNKNOWN license:")
            for u in unknown:
                print(f"     {u['name']} ({u['version']}) — add to allowlist if safe")
        if not violations and not unknown:
            print(f"  ✅ All {len(compliant)} packages are compliant")

    sys.exit(1 if violations or unknown else 0)


if __name__ == "__main__":
    main()
