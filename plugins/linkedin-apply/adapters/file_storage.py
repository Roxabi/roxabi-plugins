"""File-based adapter for StoragePort."""
from __future__ import annotations

import json
import logging
import re
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for _p in [_plugin_root, _repo_root]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

from ports.storage import StoragePort
from roxabi_sdk.paths import get_plugin_data, ensure_dir
from scripts.storage import ApplicationRecap, slugify

logger = logging.getLogger(__name__)


class FileStorageAdapter(StoragePort):
    """Concrete StoragePort backed by filesystem."""

    def __init__(self, base_dir: Path | None = None):
        self._base_dir = base_dir or get_plugin_data('linkedin-apply') / 'applications'
        self._index_file = self._base_dir / 'index.jsonl'

    def _get_storage_path(self, job: Any, base_date: datetime | None = None) -> Path:
        date = base_date or datetime.now()
        month_dir = date.strftime('%Y-%m')
        date_prefix = date.strftime('%Y%m%d')
        company_slug = slugify(job.company, max_length=20)
        title_slug = slugify(job.title, max_length=30)
        return self._base_dir / month_dir / f'{date_prefix}_{company_slug}_{title_slug}'

    def save_analysis(self, job: Any, match_result: Any) -> Path:
        now = datetime.now()
        storage_path = self._get_storage_path(job, now)
        ensure_dir(storage_path)

        recap = ApplicationRecap(
            job_id=job.job_id,
            job_title=job.title,
            company=job.company,
            url=job.url,
            match_score=match_result.global_score,
            match_decision=match_result.decision,
            status='analyzed',
            analyzed_at=now,
            storage_path=storage_path,
        )

        (storage_path / 'recap.json').write_text(
            json.dumps(recap.to_dict(), indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

        job_dict = asdict(job) if hasattr(job, '__dataclass_fields__') else dict(job)
        (storage_path / 'job_snapshot.json').write_text(
            json.dumps(job_dict, indent=2, ensure_ascii=False, default=str) + '\n', encoding='utf-8')

        match_dict = asdict(match_result) if hasattr(match_result, '__dataclass_fields__') else dict(match_result)
        (storage_path / 'match_result.json').write_text(
            json.dumps(match_dict, indent=2, ensure_ascii=False, default=str) + '\n', encoding='utf-8')

        self._append_to_index(recap)
        return storage_path

    def load_recap(self, job_id: str) -> ApplicationRecap | None:
        if not self._index_file.exists():
            return None
        for line in self._index_file.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                if entry.get('job_id') == job_id:
                    sp = entry.get('storage_path')
                    if sp:
                        recap_file = Path(sp) / 'recap.json'
                        if recap_file.exists():
                            return ApplicationRecap.from_dict(
                                json.loads(recap_file.read_text(encoding='utf-8')))
                    return ApplicationRecap.from_dict(entry)
            except json.JSONDecodeError:
                continue
        return None

    def list_applications(self, month: str | None = None,
                          status: str | None = None) -> list[ApplicationRecap]:
        if not self._index_file.exists():
            return []
        results: list[ApplicationRecap] = []
        for line in self._index_file.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            try:
                recap = ApplicationRecap.from_dict(json.loads(line))
                if month and recap.analyzed_at.strftime('%Y-%m') != month:
                    continue
                if status and recap.status != status:
                    continue
                results.append(recap)
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        results.sort(key=lambda r: r.analyzed_at, reverse=True)
        seen: set[str] = set()
        deduped: list[ApplicationRecap] = []
        for r in results:
            if r.job_id not in seen:
                seen.add(r.job_id)
                deduped.append(r)
        return deduped

    def get_daily_count(self) -> int:
        today = datetime.now().date()
        count = 0
        if not self._index_file.exists():
            return 0
        for line in self._index_file.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                if entry.get('status') != 'applied':
                    continue
                applied_at = entry.get('applied_at')
                if applied_at and datetime.fromisoformat(applied_at).date() == today:
                    count += 1
            except (json.JSONDecodeError, ValueError):
                continue
        return count

    def get_stats(self) -> dict:
        apps = self.list_applications()
        stats = {
            'total': len(apps), 'analyzed': 0, 'applied': 0, 'skipped': 0,
            'decision_apply': 0, 'decision_review': 0, 'decision_skip': 0,
        }
        for app in apps:
            if app.status in stats:
                stats[app.status] += 1
            key = f'decision_{app.match_decision.lower()}'
            if key in stats:
                stats[key] += 1
        return stats

    def find_existing_analysis(self, job_id: str) -> Path | None:
        recap = self.load_recap(job_id)
        return recap.storage_path if recap else None

    def _append_to_index(self, recap: ApplicationRecap) -> None:
        ensure_dir(self._base_dir)
        with open(self._index_file, 'a', encoding='utf-8') as f:
            f.write(json.dumps(recap.to_dict(), ensure_ascii=False, default=str) + '\n')
