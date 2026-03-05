"""Tests for linkedin-apply use cases — mocked ports, no I/O."""
import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for p in [_plugin_root, _repo_root]:
    if p not in sys.path:
        sys.path.insert(0, p)

from use_cases.match_job import MatchJobUseCase


class TestMatchJobUseCase:

    def test_returns_cached_when_existing(self):
        mock_storage = MagicMock()
        mock_storage.load_recap.return_value = {'decision': 'APPLY', 'score': 8.5}
        mock_matcher = AsyncMock()

        uc = MatchJobUseCase(storage=mock_storage, matcher=mock_matcher)
        job = MagicMock(job_id='job-1')
        result = asyncio.run(uc.execute(job, {'name': 'Test'}))

        mock_storage.load_recap.assert_called_once_with('job-1')
        mock_matcher.match.assert_not_called()
        assert result == {'decision': 'APPLY', 'score': 8.5}

    def test_matches_and_saves_when_new(self):
        mock_storage = MagicMock()
        mock_storage.load_recap.return_value = None
        mock_storage.save_analysis.return_value = Path('/tmp/new.json')
        mock_matcher = AsyncMock()
        mock_matcher.match.return_value = MagicMock(decision='REVIEW')

        uc = MatchJobUseCase(storage=mock_storage, matcher=mock_matcher)
        job = MagicMock(job_id='job-2')
        result = asyncio.run(uc.execute(job, {'name': 'Test'}))

        mock_matcher.match.assert_called_once_with(job, {'name': 'Test'}, None)
        mock_storage.save_analysis.assert_called_once()
        assert result.decision == 'REVIEW'

    def test_passes_criteria(self):
        mock_storage = MagicMock()
        mock_storage.load_recap.return_value = None
        mock_matcher = AsyncMock()
        mock_matcher.match.return_value = MagicMock(decision='SKIP')

        criteria = {'thresholds': {'apply': 8.0}}
        uc = MatchJobUseCase(storage=mock_storage, matcher=mock_matcher)
        job = MagicMock(job_id='job-3')
        asyncio.run(uc.execute(job, {}, criteria))

        mock_matcher.match.assert_called_once_with(job, {}, criteria)
