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
