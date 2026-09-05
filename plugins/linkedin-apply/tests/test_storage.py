"""Tests for linkedin-apply scripts.storage — isolated tmp APPLICATIONS_DIR."""
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for p in [_plugin_root, _repo_root]:
    if p not in sys.path:
        sys.path.insert(0, p)

import scripts.storage as storage
from scripts.storage import ApplicationRecap


@dataclass
class FakeJob:
    job_id: str = 'test-123'
    title: str = 'Software Engineer'
    company: str = 'Acme Corp'
    url: str = 'https://linkedin.com/jobs/view/123'


@dataclass
class FakeMatch:
    global_score: float = 8.5
    decision: str = 'APPLY'
    job_id: str = 'test-123'
    passes_dealbreakers: bool = True
    dealbreaker_issues: list = field(default_factory=list)
    tech_score: int = 8
    seniority_score: int = 9


@pytest.fixture
def apps_dir(tmp_path, monkeypatch):
    apps = tmp_path / 'applications'
    apps.mkdir()
    monkeypatch.setattr(storage, 'APPLICATIONS_DIR', apps)
    monkeypatch.setattr(storage, 'INDEX_FILE', apps / 'index.jsonl')
    return apps


def _index_entry(*, job_id, storage_path, status='analyzed', decision='APPLY',
                 analyzed_at=None, applied_at=None, match_score=8.5):
    now = analyzed_at or datetime.now().isoformat()
    return {
        'job_id': job_id,
        'job_title': 'Engineer',
        'company': 'Acme',
        'url': 'https://example.com',
        'match_score': match_score,
        'match_decision': decision,
        'status': status,
        'analyzed_at': now,
        'applied_at': applied_at,
        'storage_path': storage_path,
    }


class TestStorage:

    def test_save_analysis_creates_files(self, apps_dir):
        path = storage.save_analysis(FakeJob(), FakeMatch())
        assert path.exists()
        assert (path / 'recap.json').exists()
        assert (path / 'job_snapshot.json').exists()
        assert (path / 'match_result.json').exists()

    def test_save_analysis_appends_to_index(self, apps_dir):
        storage.save_analysis(FakeJob(), FakeMatch())
        index = apps_dir / 'index.jsonl'
        assert index.exists()
        lines = index.read_text().strip().splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry['job_id'] == 'test-123'

    def test_load_recap_found(self, apps_dir):
        storage.save_analysis(FakeJob(), FakeMatch())
        recap = storage.load_recap('test-123')
        assert recap is not None
        assert isinstance(recap, ApplicationRecap)
        assert recap.job_id == 'test-123'
        assert recap.match_score == 8.5

    def test_load_recap_not_found(self, apps_dir):
        storage.save_analysis(FakeJob(), FakeMatch())
        assert storage.load_recap('nonexistent') is None

    def test_load_recap_skips_storage_path_outside_applications_dir(self, apps_dir, tmp_path):
        outside = tmp_path / 'outside' / 'evil-job'
        outside.mkdir(parents=True)
        recap_payload = _index_entry(job_id='evil-1', storage_path=str(outside))
        (outside / 'recap.json').write_text(json.dumps(recap_payload), encoding='utf-8')
        (apps_dir / 'index.jsonl').write_text(
            json.dumps(recap_payload) + '\n', encoding='utf-8')

        assert storage.load_recap('evil-1') is None

    def test_load_recap_rejects_recap_json_symlinked_out_of_tree(self, apps_dir, tmp_path):
        """In-tree dir + recap.json symlink escaping the tree must not be read."""
        outside = tmp_path / 'outside'
        outside.mkdir()
        loot = outside / 'loot.json'
        inside = apps_dir / '2026-09' / '20260901_acme_dev'
        inside.mkdir(parents=True)
        entry = _index_entry(job_id='evil-2', storage_path=str(inside))
        loot.write_text(
            json.dumps({**entry, 'match_score': 1.0}), encoding='utf-8')
        (inside / 'recap.json').symlink_to(loot)
        (apps_dir / 'index.jsonl').write_text(
            json.dumps(entry) + '\n', encoding='utf-8')

        recap = storage.load_recap('evil-2')
        assert recap is None

    def test_load_recap_returns_none_on_symlink_loop_storage_path(self, apps_dir):
        """A looping storage_path is skipped, not fatal (resolve() raises here)."""
        loop = apps_dir / 'loop-dir'
        loop.symlink_to(loop)
        entry = _index_entry(job_id='loop-1', storage_path=str(loop))
        (apps_dir / 'index.jsonl').write_text(
            json.dumps(entry) + '\n', encoding='utf-8')

        assert storage.load_recap('loop-1') is None

    def test_list_applications(self, apps_dir):
        storage.save_analysis(FakeJob(job_id='a'), FakeMatch(job_id='a'))
        storage.save_analysis(FakeJob(job_id='b', company='Beta'), FakeMatch(job_id='b'))
        apps = storage.list_applications()
        assert len(apps) == 2

    def test_list_applications_filter_status(self, apps_dir):
        storage.save_analysis(FakeJob(), FakeMatch())
        apps = storage.list_applications(status='analyzed')
        assert len(apps) == 1
        apps = storage.list_applications(status='applied')
        assert len(apps) == 0

    def test_find_existing_analysis(self, apps_dir):
        storage.save_analysis(FakeJob(), FakeMatch())
        path = storage.find_existing_analysis('test-123')
        assert path is not None
        assert path.exists()

    def test_find_existing_analysis_not_found(self, apps_dir):
        assert storage.find_existing_analysis('nope') is None

    def test_get_stats(self, apps_dir):
        storage.save_analysis(FakeJob(job_id='a'), FakeMatch(job_id='a', decision='APPLY'))
        storage.save_analysis(
            FakeJob(job_id='b', company='Beta'), FakeMatch(job_id='b', decision='SKIP'))
        stats = storage.get_stats()
        assert stats['total'] == 2
        assert stats['decision_apply'] == 1
        assert stats['decision_skip'] == 1

    def test_get_daily_count_no_applied(self, apps_dir):
        storage.save_analysis(FakeJob(), FakeMatch())
        assert storage.get_daily_count() == 0

    def test_get_daily_count_with_applied_entries(self, apps_dir):
        today_iso = datetime.now().isoformat()
        entry = _index_entry(
            job_id='applied-001',
            storage_path='',
            status='applied',
            applied_at=today_iso,
            analyzed_at=today_iso,
            match_score=7.0,
        )
        with open(apps_dir / 'index.jsonl', 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry) + '\n')
        assert storage.get_daily_count() == 1

    def test_list_applications_filter_month(self, apps_dir):
        storage.save_analysis(FakeJob(), FakeMatch())
        current_month = datetime.now().strftime('%Y-%m')
        apps = storage.list_applications(month=current_month)
        assert len(apps) == 1
        assert apps[0].job_id == 'test-123'
