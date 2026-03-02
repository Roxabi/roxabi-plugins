#!/usr/bin/env python3
"""
LinkedIn Application Storage Module.

Manages persistent storage for job analyses in a structured directory hierarchy
under ~/.roxabi-vault/linkedin-apply/applications/.

Storage structure:
    ~/.roxabi-vault/linkedin-apply/
    ├── candidate.yaml               # User profile (created by init skill)
    ├── criteria.yaml                # Optional scoring criteria override
    └── applications/
        ├── index.jsonl              # Append-only global log
        └── YYYY-MM/
            └── YYYYMMDD_company_title/
                ├── recap.json       # ApplicationRecap complete
                ├── job_snapshot.json  # Job at scrape time
                └── match_result.json  # Match scores and analysis

Usage:
    from storage import save_analysis, load_recap, list_applications

    # Save analysis
    path = save_analysis(job, match_result)

    # List recent applications
    apps = list_applications(month="2024-01", status="applied")
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

# Add _lib to path for vault path resolution
_LIB_DIR = Path(__file__).resolve().parent / "_lib"
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from paths import get_plugin_data, ensure_dir as vault_ensure_dir

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from scraper import LinkedInJob
    from matcher import MatchResult

# ============================================================================
# Configuration
# ============================================================================

APPLICATIONS_DIR = get_plugin_data("linkedin-apply") / "applications"
INDEX_FILE = APPLICATIONS_DIR / "index.jsonl"


# ============================================================================
# Data Models
# ============================================================================


@dataclass
class ApplicationRecap:
    """Complete application record for tracking and reporting."""

    job_id: str
    job_title: str
    company: str
    url: str
    match_score: float
    match_decision: str  # APPLY, REVIEW, SKIP
    status: str  # analyzed, applied, skipped
    analyzed_at: datetime
    applied_at: datetime | None = None
    storage_path: Path | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "job_id": self.job_id,
            "job_title": self.job_title,
            "company": self.company,
            "url": self.url,
            "match_score": self.match_score,
            "match_decision": self.match_decision,
            "status": self.status,
            "analyzed_at": self.analyzed_at.isoformat(),
            "applied_at": self.applied_at.isoformat() if self.applied_at else None,
            "storage_path": str(self.storage_path) if self.storage_path else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ApplicationRecap":
        """Create from dictionary (JSON deserialization)."""
        return cls(
            job_id=data["job_id"],
            job_title=data["job_title"],
            company=data["company"],
            url=data["url"],
            match_score=data["match_score"],
            match_decision=data["match_decision"],
            status=data["status"],
            analyzed_at=datetime.fromisoformat(data["analyzed_at"]),
            applied_at=(
                datetime.fromisoformat(data["applied_at"]) if data.get("applied_at") else None
            ),
            storage_path=Path(data["storage_path"]) if data.get("storage_path") else None,
        )


# ============================================================================
# Utilities
# ============================================================================


def slugify(text: str, max_length: int = 40) -> str:
    """Convert text to a filesystem-safe slug."""
    slug = text.lower()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[-\s]+", "-", slug)
    slug = slug.strip("-")

    if len(slug) > max_length:
        slug = slug[:max_length].rsplit("-", 1)[0]

    return slug or "unknown"


def get_storage_path(job: "LinkedInJob", base_date: datetime | None = None) -> Path:
    """Generate storage path for a job application."""
    date = base_date or datetime.now()
    month_dir = date.strftime("%Y-%m")
    date_prefix = date.strftime("%Y%m%d")

    company_slug = slugify(job.company, max_length=20)
    title_slug = slugify(job.title, max_length=30)

    folder_name = f"{date_prefix}_{company_slug}_{title_slug}"

    return APPLICATIONS_DIR / month_dir / folder_name


def ensure_dir(path: Path) -> Path:
    """Create directory if it doesn't exist, return the path."""
    path.mkdir(parents=True, exist_ok=True)
    return path


# ============================================================================
# Core Storage Functions
# ============================================================================


def save_analysis(job: "LinkedInJob", match: "MatchResult") -> Path:
    """
    Save job analysis results to vault storage.

    Creates the storage directory structure and saves:
    - recap.json: ApplicationRecap with match decision
    - job_snapshot.json: Complete job data at scrape time
    - match_result.json: Match scores and analysis

    Args:
        job: LinkedInJob dataclass with scraped job data
        match: MatchResult dataclass with analysis results

    Returns:
        Path to the created storage directory
    """
    now = datetime.now()
    storage_path = get_storage_path(job, now)

    # Create directory
    vault_ensure_dir(storage_path)

    # Create recap
    recap = ApplicationRecap(
        job_id=job.job_id,
        job_title=job.title,
        company=job.company,
        url=job.url,
        match_score=match.global_score,
        match_decision=match.decision,
        status="analyzed",
        analyzed_at=now,
        storage_path=storage_path,
    )

    # Save recap.json
    recap_path = storage_path / "recap.json"
    with open(recap_path, "w", encoding="utf-8") as f:
        json.dump(recap.to_dict(), f, indent=2, ensure_ascii=False)

    # Save job_snapshot.json (full job data at scrape time)
    snapshot_path = storage_path / "job_snapshot.json"
    job_dict = asdict(job) if hasattr(job, "__dataclass_fields__") else dict(job)
    with open(snapshot_path, "w", encoding="utf-8") as f:
        json.dump(job_dict, f, indent=2, ensure_ascii=False, default=str)

    # Save match_result.json
    match_path = storage_path / "match_result.json"
    match_dict = asdict(match) if hasattr(match, "__dataclass_fields__") else dict(match)
    with open(match_path, "w", encoding="utf-8") as f:
        json.dump(match_dict, f, indent=2, ensure_ascii=False, default=str)

    # Append to global index
    append_to_index(recap)

    logger.info(f"Saved analysis for {job.title} at {job.company} to {storage_path}")

    return storage_path


def load_recap(job_id: str) -> ApplicationRecap | None:
    """Load an ApplicationRecap by job_id."""
    if not INDEX_FILE.exists():
        return None

    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get("job_id") == job_id:
                    storage_path = entry.get("storage_path")
                    if storage_path:
                        recap_file = Path(storage_path) / "recap.json"
                        if recap_file.exists():
                            with open(recap_file, "r", encoding="utf-8") as rf:
                                return ApplicationRecap.from_dict(json.load(rf))
                    return ApplicationRecap.from_dict(entry)
            except json.JSONDecodeError:
                continue

    return None


def list_applications(
    month: str | None = None,
    status: str | None = None,
) -> list[ApplicationRecap]:
    """
    List applications with optional filters.

    Args:
        month: Filter by month in YYYY-MM format
        status: Filter by status (analyzed, applied, skipped)

    Returns:
        List of ApplicationRecap sorted by analyzed_at (newest first)
    """
    results: list[ApplicationRecap] = []

    if not INDEX_FILE.exists():
        return results

    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                recap = ApplicationRecap.from_dict(entry)

                if month:
                    entry_month = recap.analyzed_at.strftime("%Y-%m")
                    if entry_month != month:
                        continue

                if status and recap.status != status:
                    continue

                results.append(recap)
            except (json.JSONDecodeError, KeyError, ValueError) as e:
                logger.warning(f"Skipping invalid index entry: {e}")
                continue

    # Sort by analyzed_at (newest first) and deduplicate by job_id (keep latest)
    results.sort(key=lambda r: r.analyzed_at, reverse=True)

    seen_ids: set[str] = set()
    deduplicated: list[ApplicationRecap] = []
    for recap in results:
        if recap.job_id not in seen_ids:
            seen_ids.add(recap.job_id)
            deduplicated.append(recap)

    return deduplicated


def get_daily_count(date: datetime | None = None) -> int:
    """Count applications submitted on a specific date."""
    target_date = (date or datetime.now()).date()
    count = 0

    if not INDEX_FILE.exists():
        return count

    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get("status") != "applied":
                    continue
                applied_at = entry.get("applied_at")
                if applied_at:
                    applied_date = datetime.fromisoformat(applied_at).date()
                    if applied_date == target_date:
                        count += 1
            except (json.JSONDecodeError, ValueError):
                continue

    return count


def append_to_index(recap: ApplicationRecap) -> None:
    """Append an entry to the global index.jsonl."""
    vault_ensure_dir(APPLICATIONS_DIR)

    entry = recap.to_dict()

    with open(INDEX_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")

    logger.debug(f"Appended to index: {recap.job_id}")


def find_existing_analysis(job_id: str) -> Path | None:
    """Find if an analysis already exists for a job_id."""
    recap = load_recap(job_id)
    return recap.storage_path if recap else None


def get_stats(month: str | None = None) -> dict[str, int]:
    """Get application statistics."""
    apps = list_applications(month=month)

    stats = {
        "total": len(apps),
        "analyzed": 0,
        "applied": 0,
        "skipped": 0,
        "decision_apply": 0,
        "decision_review": 0,
        "decision_skip": 0,
    }

    for app in apps:
        if app.status == "analyzed":
            stats["analyzed"] += 1
        elif app.status == "applied":
            stats["applied"] += 1
        elif app.status == "skipped":
            stats["skipped"] += 1

        if app.match_decision == "APPLY":
            stats["decision_apply"] += 1
        elif app.match_decision == "REVIEW":
            stats["decision_review"] += 1
        elif app.match_decision == "SKIP":
            stats["decision_skip"] += 1

    return stats


# ============================================================================
# CLI Entry Point
# ============================================================================


def main():
    """CLI interface for testing storage functions."""
    import argparse

    parser = argparse.ArgumentParser(description="LinkedIn Application Storage")
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    list_parser = subparsers.add_parser("list", help="List applications")
    list_parser.add_argument("--month", help="Filter by month (YYYY-MM)")
    list_parser.add_argument("--status", choices=["analyzed", "applied", "skipped"])

    show_parser = subparsers.add_parser("show", help="Show application details")
    show_parser.add_argument("job_id", help="Job ID to show")

    stats_parser = subparsers.add_parser("stats", help="Show statistics")
    stats_parser.add_argument("--month", help="Filter by month (YYYY-MM)")

    count_parser = subparsers.add_parser("count", help="Get daily count")
    count_parser.add_argument("--date", help="Date (YYYY-MM-DD), defaults to today")

    args = parser.parse_args()

    if args.command == "list":
        apps = list_applications(month=args.month, status=args.status)
        if not apps:
            print("No applications found.")
            return

        print(f"\nFound {len(apps)} application(s):\n")
        for app in apps:
            status_icon = {"analyzed": "[A]", "applied": "[OK]", "skipped": "[X]"}.get(
                app.status, "[?]"
            )
            print(
                f"{status_icon} {app.company} - {app.job_title} "
                f"(score: {app.match_score:.1f}, decision: {app.match_decision})"
            )
            print(f"    URL: {app.url}")
            print(f"    Analyzed: {app.analyzed_at.strftime('%Y-%m-%d %H:%M')}")
            if app.applied_at:
                print(f"    Applied: {app.applied_at.strftime('%Y-%m-%d %H:%M')}")
            print()

    elif args.command == "show":
        recap = load_recap(args.job_id)
        if not recap:
            print(f"Application not found: {args.job_id}")
            return
        print(json.dumps(recap.to_dict(), indent=2, ensure_ascii=False, default=str))

    elif args.command == "stats":
        stats = get_stats(month=args.month)
        month_str = f" for {args.month}" if args.month else ""
        print(f"\nApplication Statistics{month_str}:")
        print(f"  Total: {stats['total']}")
        print(f"  Analyzed: {stats['analyzed']}")
        print(f"  Applied: {stats['applied']}")
        print(f"  Skipped: {stats['skipped']}")
        print("\nBy Decision:")
        print(f"  APPLY: {stats['decision_apply']}")
        print(f"  REVIEW: {stats['decision_review']}")
        print(f"  SKIP: {stats['decision_skip']}")

    elif args.command == "count":
        if args.date:
            date = datetime.strptime(args.date, "%Y-%m-%d")
        else:
            date = datetime.now()
        count = get_daily_count(date)
        print(f"Applications on {date.strftime('%Y-%m-%d')}: {count}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
