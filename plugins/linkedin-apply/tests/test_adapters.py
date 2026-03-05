"""Tests for linkedin-apply FileStorageAdapter."""
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

from adapters.file_storage import FileStorageAdapter
from scripts.storage import ApplicationRecap


# Minimal dataclasses matching the interface expected by save_analysis
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
def adapter(tmp_path):
    return FileStorageAdapter(base_dir=tmp_path / 'applications')


class TestFileStorageAdapter:

    def test_save_analysis_creates_files(self, adapter, tmp_path):
        path = adapter.save_analysis(FakeJob(), FakeMatch())
        assert path.exists()
        assert (path / 'recap.json').exists()
        assert (path / 'job_snapshot.json').exists()
        assert (path / 'match_result.json').exists()

    def test_save_analysis_appends_to_index(self, adapter):
        adapter.save_analysis(FakeJob(), FakeMatch())
        assert adapter._index_file.exists()
        lines = adapter._index_file.read_text().strip().splitlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry['job_id'] == 'test-123'

    def test_load_recap_found(self, adapter):
        adapter.save_analysis(FakeJob(), FakeMatch())
        recap = adapter.load_recap('test-123')
        assert recap is not None
        assert isinstance(recap, ApplicationRecap)
        assert recap.job_id == 'test-123'
        assert recap.match_score == 8.5

    def test_load_recap_not_found(self, adapter):
        adapter.save_analysis(FakeJob(), FakeMatch())
        assert adapter.load_recap('nonexistent') is None

    def test_list_applications(self, adapter):
        adapter.save_analysis(FakeJob(job_id='a'), FakeMatch(job_id='a'))
        adapter.save_analysis(FakeJob(job_id='b', company='Beta'), FakeMatch(job_id='b'))
        apps = adapter.list_applications()
        assert len(apps) == 2

    def test_list_applications_filter_status(self, adapter):
        adapter.save_analysis(FakeJob(), FakeMatch())
        apps = adapter.list_applications(status='analyzed')
        assert len(apps) == 1
        apps = adapter.list_applications(status='applied')
        assert len(apps) == 0

    def test_find_existing_analysis(self, adapter):
        adapter.save_analysis(FakeJob(), FakeMatch())
        path = adapter.find_existing_analysis('test-123')
        assert path is not None
        assert path.exists()

    def test_find_existing_analysis_not_found(self, adapter):
        assert adapter.find_existing_analysis('nope') is None

    def test_get_stats(self, adapter):
        adapter.save_analysis(FakeJob(job_id='a'), FakeMatch(job_id='a', decision='APPLY'))
        adapter.save_analysis(FakeJob(job_id='b', company='Beta'), FakeMatch(job_id='b', decision='SKIP'))
        stats = adapter.get_stats()
        assert stats['total'] == 2
        assert stats['decision_apply'] == 1
        assert stats['decision_skip'] == 1

    def test_get_daily_count_no_applied(self, adapter):
        adapter.save_analysis(FakeJob(), FakeMatch())
        assert adapter.get_daily_count() == 0

    def test_get_daily_count_with_applied_entries(self, adapter):
        # Arrange — write an index entry with status='applied' and today's date
        today_iso = datetime.now().isoformat()
        entry = {
            'job_id': 'applied-001',
            'job_title': 'Engineer',
            'company': 'Applied Corp',
            'url': 'https://example.com',
            'match_score': 7.0,
            'match_decision': 'APPLY',
            'status': 'applied',
            'analyzed_at': today_iso,
            'applied_at': today_iso,
            'storage_path': '',
        }
        adapter._index_file.parent.mkdir(parents=True, exist_ok=True)
        with open(adapter._index_file, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry) + '\n')
        # Act + Assert
        assert adapter.get_daily_count() == 1

    def test_list_applications_filter_month(self, adapter):
        # Arrange — save an analysis (status='analyzed', analyzed_at=now)
        adapter.save_analysis(FakeJob(), FakeMatch())
        current_month = datetime.now().strftime('%Y-%m')
        # Act
        apps = adapter.list_applications(month=current_month)
        # Assert — the saved application appears in results for the current month
        assert len(apps) == 1
        assert apps[0].job_id == 'test-123'
