"""LinkedIn-apply domain models."""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


def slugify(text: str, max_length: int = 40) -> str:
    """Convert text to a filesystem-safe slug."""
    slug = text.lower()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[-\s]+', '-', slug)
    slug = slug.strip('-')
    if len(slug) > max_length:
        slug = slug[:max_length].rsplit('-', 1)[0]
    return slug or 'unknown'


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
            'job_id': self.job_id,
            'job_title': self.job_title,
            'company': self.company,
            'url': self.url,
            'match_score': self.match_score,
            'match_decision': self.match_decision,
            'status': self.status,
            'analyzed_at': self.analyzed_at.isoformat(),
            'applied_at': self.applied_at.isoformat() if self.applied_at else None,
            'storage_path': str(self.storage_path) if self.storage_path else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> 'ApplicationRecap':
        """Create from dictionary (JSON deserialization)."""
        return cls(
            job_id=data['job_id'],
            job_title=data['job_title'],
            company=data['company'],
            url=data['url'],
            match_score=data['match_score'],
            match_decision=data['match_decision'],
            status=data['status'],
            analyzed_at=datetime.fromisoformat(data['analyzed_at']),
            applied_at=(
                datetime.fromisoformat(data['applied_at']) if data.get('applied_at') else None
            ),
            storage_path=Path(data['storage_path']) if data.get('storage_path') else None,
        )
