"""Tests for plugins/dev-core/skills/code-review/chunker.py.

Acceptance criteria (§ Slice 2):
  1. Empty diff → empty chunk list
  2. Single oversized file → one chunk (can't split further)
  3. Balanced split → multiple chunks each within budget
  4. Cross-directory rename → rename metadata preserved; file lands in new-path directory

Budget is computed dynamically: compute_budget(ctx_window) = int(ctx_window * 0.4)
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make the code-review skill directory importable without installing a package
_SKILL_DIR = Path(__file__).resolve().parents[1] / 'plugins' / 'dev-core' / 'skills' / 'code-review'
sys.path.insert(0, str(_SKILL_DIR))

from chunker import (  # noqa: E402
    DiffFile,
    Chunk,
    compute_budget,
    chunk,
    parse_diff,
    _top_dir,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_file(path: str, lines: int = 10, old_path: str | None = None) -> DiffFile:
    return DiffFile(path=path, old_path=old_path, lines=lines, hunk_text='')


# ---------------------------------------------------------------------------
# compute_budget
# ---------------------------------------------------------------------------

class TestComputeBudget:
    def test_forty_percent(self):
        assert compute_budget(100_000) == 40_000

    def test_custom_fraction(self):
        assert compute_budget(200_000, fraction=0.2) == 40_000

    def test_small_window(self):
        assert compute_budget(10) == 4

    def test_invalid_zero(self):
        with pytest.raises(ValueError, match='context_window_tokens'):
            compute_budget(0)

    def test_invalid_negative(self):
        with pytest.raises(ValueError, match='context_window_tokens'):
            compute_budget(-1)

    def test_fraction_out_of_range(self):
        with pytest.raises(ValueError, match='fraction'):
            compute_budget(100_000, fraction=0.0)

    def test_fraction_above_one(self):
        with pytest.raises(ValueError, match='fraction'):
            compute_budget(100_000, fraction=1.1)

    def test_fraction_exactly_one(self):
        assert compute_budget(100_000, fraction=1.0) == 100_000


# ---------------------------------------------------------------------------
# _top_dir helper
# ---------------------------------------------------------------------------

class TestTopDir:
    def test_nested(self):
        assert _top_dir('src/lyra/core/foo.py') == 'src'

    def test_root_level(self):
        assert _top_dir('README.md') == '.'

    def test_two_levels(self):
        assert _top_dir('plugins/code-review.py') == 'plugins'


# ---------------------------------------------------------------------------
# Acceptance criterion 1: Empty diff → empty list
# ---------------------------------------------------------------------------

class TestEmptyDiff:
    def test_empty_files_list(self):
        result = chunk([], budget=1000)
        assert result == []

    def test_empty_diff_string(self):
        files = parse_diff('')
        assert files == []
        result = chunk(files, budget=1000)
        assert result == []

    def test_whitespace_only_diff(self):
        files = parse_diff('   \n\n  ')
        assert files == []


# ---------------------------------------------------------------------------
# Acceptance criterion 2: Single oversized file → one chunk
# ---------------------------------------------------------------------------

class TestOversizedFile:
    def test_single_file_exceeds_budget(self):
        """A file larger than the budget must still be returned in its own chunk."""
        files = [make_file('src/big.py', lines=5000)]
        budget = compute_budget(10_000)  # 4000 lines
        result = chunk(files, budget=budget)
        assert len(result) == 1
        assert result[0].paths == ['src/big.py']
        assert result[0].total_lines == 5000

    def test_oversized_file_among_normal_files(self):
        """Oversized file splits off; normal files may form their own chunk."""
        files = [
            make_file('src/big.py', lines=5000),
            make_file('src/small.py', lines=100),
        ]
        budget = compute_budget(10_000)  # 4000 lines
        result = chunk(files, budget=budget)
        # big.py must be alone
        oversized = [c for c in result if 'src/big.py' in c.paths]
        assert len(oversized) == 1
        assert oversized[0].paths == ['src/big.py']

    def test_multiple_oversized_files_each_gets_own_chunk(self):
        files = [
            make_file('src/a.py', lines=5000),
            make_file('src/b.py', lines=6000),
        ]
        budget = 4000
        result = chunk(files, budget=budget)
        assert len(result) == 2
        assert {r.paths[0] for r in result} == {'src/a.py', 'src/b.py'}


# ---------------------------------------------------------------------------
# Acceptance criterion 3: Balanced split → chunks within budget
# ---------------------------------------------------------------------------

class TestBalancedSplit:
    def test_two_directories_one_chunk_each(self):
        """Files in different directories → separate chunks, each within budget."""
        files = [
            make_file('frontend/App.tsx', lines=50),
            make_file('frontend/index.tsx', lines=30),
            make_file('backend/api.py', lines=40),
            make_file('backend/models.py', lines=60),
        ]
        budget = compute_budget(1_000)  # 400 lines — each dir fits
        result = chunk(files, budget=budget)
        # Should be 2 chunks: one per directory
        assert len(result) == 2
        for c in result:
            assert c.total_lines <= budget

    def test_large_directory_splits_into_multiple_chunks(self):
        """When a single directory exceeds budget, it splits into sub-chunks."""
        files = [make_file(f'src/file{i}.py', lines=100) for i in range(10)]
        budget = 350  # fits 3 files per chunk
        result = chunk(files, budget=budget)
        assert len(result) > 1
        for c in result:
            # Each chunk must be within budget (unless it's a single oversized file)
            if len(c.files) > 1:
                assert c.total_lines <= budget

    def test_all_files_fit_in_one_budget(self):
        files = [
            make_file('src/a.py', lines=10),
            make_file('src/b.py', lines=20),
        ]
        budget = 1000
        result = chunk(files, budget=budget)
        assert len(result) == 1
        assert result[0].total_lines == 30

    def test_root_level_files_grouped(self):
        """Root-level files (no directory) all go under '.' → one chunk."""
        files = [
            make_file('setup.py', lines=5),
            make_file('pyproject.toml', lines=10),
            make_file('README.md', lines=20),
        ]
        budget = 1000
        result = chunk(files, budget=budget)
        assert len(result) == 1
        assert result[0].total_lines == 35

    def test_budget_exactly_met(self):
        """Files whose combined LOC equals budget exactly → single chunk."""
        files = [make_file('src/a.py', lines=200), make_file('src/b.py', lines=200)]
        budget = 400
        result = chunk(files, budget=budget)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# Acceptance criterion 4: Cross-directory rename
# ---------------------------------------------------------------------------

class TestCrossDirectoryRename:
    def test_rename_preserved_in_diff_file(self):
        raw = (
            'diff --git a/old/path/foo.py b/new/path/foo.py\n'
            'rename from old/path/foo.py\n'
            'rename to new/path/foo.py\n'
            '@@ -1,3 +1,3 @@\n'
            ' line1\n'
            '-old line\n'
            '+new line\n'
        )
        files = parse_diff(raw)
        assert len(files) == 1
        f = files[0]
        assert f.path == 'new/path/foo.py'
        assert f.old_path == 'old/path/foo.py'

    def test_renamed_file_lands_in_new_directory_chunk(self):
        """After rename, file groups by its new (destination) directory."""
        files = [
            DiffFile(path='new/foo.py', old_path='old/foo.py', lines=20, hunk_text=''),
            DiffFile(path='new/bar.py', old_path=None, lines=15, hunk_text=''),
            DiffFile(path='unrelated/baz.py', old_path=None, lines=10, hunk_text=''),
        ]
        budget = 1000
        result = chunk(files, budget=budget)
        # 'new/' files → one chunk; 'unrelated/' → another
        new_chunks = [c for c in result if any('new/' in p for p in c.paths)]
        assert len(new_chunks) == 1
        assert set(new_chunks[0].paths) == {'new/foo.py', 'new/bar.py'}

    def test_cross_directory_rename_two_separate_dirs(self):
        """Rename from src/ to lib/ — the file goes into lib/ chunk."""
        files = [
            DiffFile(path='lib/utils.py', old_path='src/utils.py', lines=30, hunk_text=''),
            DiffFile(path='lib/helpers.py', old_path=None, lines=10, hunk_text=''),
        ]
        budget = 1000
        result = chunk(files, budget=budget)
        assert len(result) == 1
        assert 'lib/utils.py' in result[0].paths

    def test_old_path_not_used_for_grouping(self):
        """Only the canonical (new) path determines the directory bucket."""
        files = [
            DiffFile(path='newdir/module.py', old_path='olddir/module.py', lines=5, hunk_text=''),
        ]
        budget = 1000
        result = chunk(files, budget=budget)
        assert result[0].paths == ['newdir/module.py']


# ---------------------------------------------------------------------------
# parse_diff — additional coverage
# ---------------------------------------------------------------------------

class TestParseDiff:
    def test_simple_modification(self):
        raw = (
            'diff --git a/src/app.py b/src/app.py\n'
            'index abc..def 100644\n'
            '--- a/src/app.py\n'
            '+++ b/src/app.py\n'
            '@@ -1,2 +1,3 @@\n'
            ' existing\n'
            '+added\n'
        )
        files = parse_diff(raw)
        assert len(files) == 1
        assert files[0].path == 'src/app.py'
        assert files[0].old_path is None
        assert files[0].lines == 3  # @@ header + 2 content lines

    def test_deletion(self):
        raw = (
            'diff --git a/old.py b/old.py\n'
            'deleted file mode 100644\n'
            '--- a/old.py\n'
            '+++ /dev/null\n'
            '@@ -1 +0,0 @@\n'
            '-gone\n'
        )
        files = parse_diff(raw)
        assert len(files) == 1
        assert files[0].path == 'old.py'

    def test_multiple_files(self):
        raw = (
            'diff --git a/a.py b/a.py\n'
            '@@ -1 +1 @@\n'
            ' x\n'
            'diff --git a/b.py b/b.py\n'
            '@@ -1 +1 @@\n'
            ' y\n'
        )
        files = parse_diff(raw)
        assert len(files) == 2
        assert [f.path for f in files] == ['a.py', 'b.py']

    def test_invalid_budget_raises(self):
        with pytest.raises(ValueError, match='budget'):
            chunk([make_file('a.py')], budget=0)
