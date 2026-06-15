"""Tests for plugins/dev-core/skills/code-review/digest.py."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SKILL_DIR = Path(__file__).resolve().parents[1] / 'plugins' / 'dev-core' / 'skills' / 'code-review'
sys.path.insert(0, str(_SKILL_DIR))

from chunker import Chunk, DiffFile  # noqa: E402
from digest import (  # noqa: E402
    BoundaryDigest,
    FileDigest,
    FORMAT_VERSION,
    emit_digest,
    emit_all_digests,
    format_digest_for_agent,
    _extract_signatures,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_diff_file(path: str, lines: int = 10, hunk_text: str = '', old_path: str | None = None) -> DiffFile:
    return DiffFile(path=path, old_path=old_path, lines=lines, hunk_text=hunk_text)


def make_chunk(*files: DiffFile) -> Chunk:
    return Chunk(files=list(files))


# ---------------------------------------------------------------------------
# _extract_signatures
# ---------------------------------------------------------------------------

class TestExtractSignatures:
    def test_python_def(self):
        hunk = '+def my_function(x, y):\n+    return x + y\n'
        sigs = _extract_signatures(hunk)
        assert 'my_function' in sigs

    def test_python_async_def(self):
        hunk = '+async def fetch_data(url):\n+    pass\n'
        sigs = _extract_signatures(hunk)
        assert 'fetch_data' in sigs

    def test_python_class(self):
        hunk = '+class MyService:\n+    pass\n'
        sigs = _extract_signatures(hunk)
        assert 'MyService' in sigs

    def test_context_line_included(self):
        # Context lines (no prefix or ' ' prefix) also captured
        hunk = ' def unchanged_func():\n'
        sigs = _extract_signatures(hunk)
        assert 'unchanged_func' in sigs

    def test_removed_line_excluded(self):
        hunk = '-def old_function():\n'
        sigs = _extract_signatures(hunk)
        assert 'old_function' not in sigs

    def test_typescript_function(self):
        hunk = '+export function handleRequest(req, res) {\n'
        sigs = _extract_signatures(hunk)
        assert 'handleRequest' in sigs

    def test_typescript_const_function(self):
        # const pattern: const processData = async (input) => {
        hunk = '+const processData = async (input) => {\n'
        sigs = _extract_signatures(hunk)
        assert 'processData' in sigs

    def test_typescript_bare_arrow_no_const(self):
        # Bare arrow without const keyword should NOT match the const-anchored pattern
        hunk = '+ processData = (x) => {\n'
        sigs = _extract_signatures(hunk)
        # No const anchor → should not be captured by any signature pattern
        assert 'processData' not in sigs

    def test_dunder_names_skipped(self):
        hunk = '+def __init__(self):\n+def __repr__(self):\n'
        sigs = _extract_signatures(hunk)
        assert '__init__' not in sigs
        assert '__repr__' not in sigs

    def test_deduplication(self):
        hunk = '+def foo():\n+def foo():\n'
        sigs = _extract_signatures(hunk)
        assert sigs.count('foo') == 1

    def test_empty_hunk(self):
        assert _extract_signatures('') == []


# ---------------------------------------------------------------------------
# emit_digest
# ---------------------------------------------------------------------------

class TestEmitDigest:
    def test_basic_structure(self):
        f = make_diff_file('src/app.py', lines=50)
        c = make_chunk(f)
        digest = emit_digest(c, chunk_index=0)
        assert isinstance(digest, BoundaryDigest)
        assert digest.chunk_index == 0
        assert len(digest.files) == 1
        assert digest.files[0].path == 'src/app.py'
        assert digest.files[0].lines == 50

    def test_total_lines(self):
        c = make_chunk(
            make_diff_file('a.py', lines=30),
            make_diff_file('b.py', lines=20),
        )
        digest = emit_digest(c, chunk_index=1)
        assert digest.total_lines == 50

    def test_paths_property(self):
        c = make_chunk(
            make_diff_file('x.py'),
            make_diff_file('y.py'),
        )
        digest = emit_digest(c, 0)
        assert digest.paths == ['x.py', 'y.py']

    def test_rename_detected(self):
        f = make_diff_file('new/path/foo.py', old_path='old/path/foo.py')
        c = make_chunk(f)
        digest = emit_digest(c, 0)
        assert digest.renames == [('old/path/foo.py', 'new/path/foo.py')]

    def test_no_rename_is_empty(self):
        f = make_diff_file('src/bar.py')
        c = make_chunk(f)
        digest = emit_digest(c, 0)
        assert digest.renames == []

    def test_signatures_extracted(self):
        hunk = '+def my_handler(request):\n+    pass\n'
        f = make_diff_file('src/handler.py', hunk_text=hunk)
        c = make_chunk(f)
        digest = emit_digest(c, 0)
        assert 'my_handler' in digest.files[0].signatures

    def test_chunk_index_set(self):
        digest = emit_digest(make_chunk(make_diff_file('a.py')), chunk_index=3)
        assert digest.chunk_index == 3

    def test_empty_chunk(self):
        digest = emit_digest(Chunk(files=[]), chunk_index=0)
        assert digest.files == []
        assert digest.total_lines == 0


# ---------------------------------------------------------------------------
# emit_all_digests
# ---------------------------------------------------------------------------

class TestEmitAllDigests:
    def test_empty_input(self):
        assert emit_all_digests([]) == []

    def test_indices_are_sequential(self):
        chunks = [
            make_chunk(make_diff_file('a.py')),
            make_chunk(make_diff_file('b.py')),
            make_chunk(make_diff_file('c.py')),
        ]
        digests = emit_all_digests(chunks)
        assert [d.chunk_index for d in digests] == [0, 1, 2]

    def test_count_matches_chunks(self):
        chunks = [make_chunk(make_diff_file(f'file{i}.py')) for i in range(5)]
        digests = emit_all_digests(chunks)
        assert len(digests) == 5


# ---------------------------------------------------------------------------
# format_digest_for_agent
# ---------------------------------------------------------------------------

class TestFormatDigestForAgent:
    def test_contains_chunk_index(self):
        digest = emit_digest(make_chunk(make_diff_file('a.py')), chunk_index=2)
        rendered = format_digest_for_agent(digest)
        assert 'chunk 2' in rendered

    def test_format_version_in_header(self):
        """Rendered output must embed FORMAT_VERSION (Architect F5)."""
        digest = emit_digest(make_chunk(make_diff_file('a.py')), chunk_index=0)
        rendered = format_digest_for_agent(digest)
        assert f'v{FORMAT_VERSION}' in rendered
        assert 'v1' in rendered

    def test_contains_file_path(self):
        digest = emit_digest(make_chunk(make_diff_file('src/main.py', lines=42)), 0)
        rendered = format_digest_for_agent(digest)
        assert 'src/main.py' in rendered
        assert '42' in rendered

    def test_contains_rename(self):
        f = make_diff_file('lib/utils.py', old_path='src/utils.py')
        digest = emit_digest(make_chunk(f), 0)
        rendered = format_digest_for_agent(digest)
        assert 'src/utils.py' in rendered
        assert 'lib/utils.py' in rendered

    def test_no_rename_section_when_empty(self):
        digest = emit_digest(make_chunk(make_diff_file('a.py')), 0)
        rendered = format_digest_for_agent(digest)
        assert 'Renames' not in rendered

    def test_signature_shown(self):
        hunk = '+def compute(x):\n'
        f = make_diff_file('calc.py', hunk_text=hunk)
        digest = emit_digest(make_chunk(f), 0)
        rendered = format_digest_for_agent(digest)
        assert 'compute' in rendered


# ---------------------------------------------------------------------------
# Path sanitization (B1 — prompt-injection-via-path)
# ---------------------------------------------------------------------------

class TestPathSanitization:
    def test_newline_in_path_is_escaped(self):
        """File path with \\n must render as <LF>, not a real newline (B1)."""
        f = make_diff_file('src/foo\nbar.py', lines=10)
        digest = emit_digest(make_chunk(f), chunk_index=0)
        # The stored path must have the escape applied
        assert digest.files[0].path == 'src/foo<LF>bar.py'

    def test_carriage_return_in_path_is_escaped(self):
        f = make_diff_file('src/foo\rbar.py', lines=5)
        digest = emit_digest(make_chunk(f), chunk_index=0)
        assert digest.files[0].path == 'src/foo<CR>bar.py'

    def test_newline_in_path_renders_without_actual_newline(self):
        """Rendered output must contain <LF> placeholder, no actual newline mid-path."""
        f = make_diff_file('evil\npath.py', lines=3)
        digest = emit_digest(make_chunk(f), chunk_index=0)
        rendered = format_digest_for_agent(digest)
        assert '<LF>' in rendered
        # No raw newline in the file-path segment of the rendered line
        lines = rendered.splitlines()
        assert any('<LF>' in line for line in lines)

    def test_old_path_sanitized_on_rename(self):
        """old_path must also be sanitized at construction time."""
        f = make_diff_file('new/foo.py', old_path='old/\nfoo.py')
        digest = emit_digest(make_chunk(f), chunk_index=0)
        assert digest.files[0].old_path == 'old/<LF>foo.py'

    def test_clean_path_unchanged(self):
        """Normal paths must pass through without modification."""
        f = make_diff_file('src/normal/path.py', lines=20)
        digest = emit_digest(make_chunk(f), chunk_index=0)
        assert digest.files[0].path == 'src/normal/path.py'
