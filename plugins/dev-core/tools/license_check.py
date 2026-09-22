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
  uv run tools/license_check.py --self-test

--self-test proves the gate can fail: a fake pip-licenses on PATH reports a
GPL package, the script must exit 1, and the work tree is never modified.
Exits 0 only when that invocation exits 1.

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
import os
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


def is_compliant(name: str, license_str: str, policy: dict) -> bool:
    """Return True if the package is considered license-compliant."""
    overrides: dict = policy.get("overrides", {})
    if name in overrides:
        return True  # explicitly whitelisted with override
    allowlist: list = policy.get("allowlist", [])
    if name in allowlist:
        return True  # explicitly whitelisted by name
    return license_str in SAFE_LICENSES


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

    for pkg in packages:
        name = pkg.get("Name", "")
        version = pkg.get("Version", "")
        license_str = pkg.get("License", "UNKNOWN")
        entry = {"name": name, "version": version, "license": license_str}
        if is_compliant(name, license_str, policy):
            compliant.append(entry)
        else:
            violations.append(entry)

    report = {
        "total": len(packages),
        "compliant": len(compliant),
        "violations": len(violations),
        "packages": compliant,
        "violating": violations,
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
        else:
            print(f"  ✅ All {len(compliant)} packages are compliant")

    sys.exit(1 if violations else 0)


if __name__ == "__main__":
    main()
