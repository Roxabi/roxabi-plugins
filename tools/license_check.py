#!/usr/bin/env python3
"""License compliance checker for Python projects.

Python equivalent of tools/licenseChecker.ts for uv/pip projects.
Scans installed packages, checks licenses against an allowlist, and reports
violations. Uses pip-licenses for package introspection.

Usage:
  uv run tools/license_check.py
  uv run tools/license_check.py --json
  uv run tools/license_check.py --policy .license-policy.json
  uv run tools/license_check.py --output reports/licenses.json

Exit code: 0 = compliant, 1 = violations found, 2 = tool error.

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
import re
import subprocess
import sys
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


def load_policy(policy_path: Path) -> dict:
    if policy_path.exists():
        try:
            return json.loads(policy_path.read_text())
        except json.JSONDecodeError as e:
            print(f"[license-check] Warning: could not parse {policy_path}: {e}",
                  file=sys.stderr)
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


def _split_compound_spdx(license_str: str) -> list[str]:
    """Split compound SPDX expressions into individual identifiers.

    Handles:
      - SPDX AND/OR operators: 'Apache-2.0 AND MIT', 'Apache-2.0 OR BSD-2-Clause'
      - pip-licenses semicolon separator: 'Apache Software License; MIT License'
    """
    parts = re.split(r"\s+AND\s+|\s+OR\s+|;\s*", license_str)
    return [p.strip() for p in parts if p.strip()]


def is_compliant(name: str, license_str: str, policy: dict) -> bool:
    """Return True if the package is considered license-compliant."""
    if name in policy.get("overrides", {}):
        return True  # explicitly overridden
    if name in policy.get("allowlist", []):
        return True  # explicitly allowlisted by name
    if license_str in SAFE_LICENSES:
        return True  # direct match
    # Compound SPDX: safe if all component licenses are individually safe
    parts = _split_compound_spdx(license_str)
    if len(parts) > 1:
        return all(p in SAFE_LICENSES for p in parts)
    return False


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
    args = parser.parse_args()

    policy = load_policy(Path(args.policy))
    packages = get_packages()

    violations: list[dict] = []
    compliant: list[dict] = []
    unknown: list[dict] = []

    for pkg in packages:
        name = pkg.get("Name", "")
        version = pkg.get("Version", "")
        license_str = pkg.get("License", "UNKNOWN")
        entry = {"name": name, "version": version, "license": license_str}
        if license_str == "UNKNOWN":
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
            names = ", ".join(f'"{v["name"]}"' for v in violations)
            print('  { "allowlist": [' + names + "] }")
        if unknown:
            print(f"  ⚠️  {len(unknown)} package(s) with UNKNOWN license:")
            for u in unknown:
                print(f"     {u['name']} ({u['version']}) — add to allowlist if safe")
        if not violations and not unknown:
            print(f"  ✅ All {len(compliant)} packages are compliant")

    sys.exit(1 if violations or unknown else 0)


if __name__ == "__main__":
    main()
