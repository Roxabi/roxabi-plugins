"""Tests for the migrate_2ndbrain migration script.

Covers: field mapping, classify_file, dedup/idempotency, broken refs,
and preservation of existing vault data.

Run: uv run pytest plugins/vault/tests/test_migrate_2ndbrain.py -v
"""
import json
import sqlite3
import struct
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add scripts directory to path so we can import the migration module
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DOCUMENTS_DDL = """
CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL DEFAULT 'knowledge',
    type TEXT NOT NULL,
    url TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    long_summary TEXT,
    preview TEXT,
    author TEXT,
    source_date TEXT,
    saved_at TEXT NOT NULL,
    metadata TEXT,
    added_by TEXT DEFAULT 'mickael',
    subtype TEXT,
    status TEXT,
    content_file TEXT
);
"""


def _make_source_db(path: Path, rows: list[dict]) -> Path:
    """Create a fixture 2ndBrain source database with given rows."""
    conn = sqlite3.connect(str(path))
    conn.executescript(_DOCUMENTS_DDL)
    for row in rows:
        conn.execute(
            """INSERT INTO documents
               (id, category, type, title, summary, long_summary, preview,
                author, source_date, saved_at, url, subtype, status, content_file)
               VALUES (:id, :category, :type, :title, :summary, :long_summary,
                       :preview, :author, :source_date, :saved_at, :url,
                       :subtype, :status, :content_file)""",
            {
                "id": row.get("id", "test0001"),
                "category": row.get("category", "knowledge"),
                "type": row.get("type", "note"),
                "title": row.get("title", "Test Title"),
                "summary": row.get("summary", "Summary text"),
                "long_summary": row.get("long_summary"),
                "preview": row.get("preview"),
                "author": row.get("author"),
                "source_date": row.get("source_date"),
                "saved_at": row.get("saved_at", "2026-01-01T00:00:00"),
                "url": row.get("url"),
                "subtype": row.get("subtype"),
                "status": row.get("status"),
                "content_file": row.get("content_file"),
            },
        )
    conn.commit()
    conn.close()
    return path


def _make_vault_db(path: Path) -> "MemoryDB":  # noqa: F821 — runtime import
    """Create and connect a vault MemoryDB at *path*."""
    from roxabi_memory.db import MemoryDB

    db = MemoryDB(path)
    db.connect()
    return db


def _make_embedder() -> MagicMock:
    """Return a mock Embedder that produces fixed 384-dim float32 bytes."""
    embedder = MagicMock()
    blob = struct.pack("f" * 384, *[0.1] * 384)
    embedder.embed.return_value = blob
    return embedder


# ---------------------------------------------------------------------------
# Module-level fixtures (shared across test classes)
# ---------------------------------------------------------------------------


@pytest.fixture
def vault_db(tmp_path):
    """Create and connect a vault MemoryDB at tmp_path/vault.db."""
    return _make_vault_db(tmp_path / "vault.db")


@pytest.fixture
def embedder():
    """Return a mock Embedder that produces fixed 384-dim float32 bytes."""
    return _make_embedder()


@pytest.fixture
def knowledge_dir(tmp_path):
    """Create an empty knowledge directory under tmp_path."""
    kdir = tmp_path / "knowledge"
    kdir.mkdir()
    return kdir


# ---------------------------------------------------------------------------
# T16 — Unit tests: map_document_to_entry + classify_file
# ---------------------------------------------------------------------------


class TestMapDocumentToEntry:
    """Unit tests for map_document_to_entry field mapping."""

    def test_map_document_with_long_summary(self):
        # Arrange
        from migrate_2ndbrain import map_document_to_entry

        doc = {
            "id": "abc12345",
            "title": "Test Title",
            "summary": "Short summary",
            "long_summary": "Expanded long summary",
            "category": "knowledge",
            "type": "twitter",
            "saved_at": "2026-01-01T00:00:00",
            "source_date": None,
            "url": None,
            "author": None,
            "preview": None,
            "added_by": "mickael",
            "subtype": None,
            "status": None,
            "content_file": None,
        }

        # Act
        result = map_document_to_entry(doc)

        # Assert — content is summary + "\n\n" + long_summary
        assert result["content"] == "Short summary\n\nExpanded long summary"
        assert result["metadata"]["source_id"] == "abc12345"

    def test_map_document_null_long_summary(self):
        # Arrange
        from migrate_2ndbrain import map_document_to_entry

        doc = {
            "id": "abc12345",
            "title": "Test Title",
            "summary": "Only summary",
            "long_summary": None,
            "category": "knowledge",
            "type": "twitter",
            "saved_at": "2026-01-01T00:00:00",
            "source_date": None,
            "url": None,
            "author": None,
            "preview": None,
            "added_by": "mickael",
            "subtype": None,
            "status": None,
            "content_file": None,
        }

        # Act
        result = map_document_to_entry(doc)

        # Assert — content is summary alone, no "\n\n"
        assert result["content"] == "Only summary"
        assert "\n\n" not in result["content"]

    def test_map_document_metadata_strips_none(self):
        # Arrange
        from migrate_2ndbrain import map_document_to_entry

        doc = {
            "id": "strip001",
            "title": "Strip None Title",
            "summary": "Summary",
            "long_summary": None,
            "category": "knowledge",
            "type": "note",
            "saved_at": "2026-01-01T00:00:00",
            "source_date": None,
            "url": None,           # should be stripped
            "author": None,        # should be stripped
            "preview": None,       # should be stripped
            "added_by": "mickael", # present — should be kept
            "subtype": None,       # should be stripped
            "status": None,        # should be stripped
            "content_file": None,  # should be stripped
        }

        # Act
        result = map_document_to_entry(doc)

        # Assert — None values absent from metadata dict
        meta = result["metadata"]
        assert "url" not in meta
        assert "author" not in meta
        assert "preview" not in meta
        assert "subtype" not in meta
        assert "status" not in meta
        assert "content_file" not in meta
        # Non-None values should still be present
        assert meta["source_id"] == "strip001"
        assert meta["added_by"] == "mickael"

    def test_map_document_namespace_is_vault(self):
        # Arrange
        from migrate_2ndbrain import map_document_to_entry

        doc = {
            "id": "ns001",
            "title": "Namespace Test",
            "summary": "Summary",
            "long_summary": None,
            "category": "knowledge",
            "type": "twitter",
            "saved_at": "2026-02-01T00:00:00",
            "source_date": "2026-01-15",
            "url": "https://example.com",
            "author": "Author Name",
            "preview": None,
            "added_by": "mickael",
            "subtype": None,
            "status": "published",
            "content_file": None,
        }

        # Act
        result = map_document_to_entry(doc)

        # Assert — namespace always 'vault', event_date mapped from source_date
        assert result["namespace"] == "vault"
        assert result["event_date"] == "2026-01-15"
        assert result["created_at"] == "2026-02-01T00:00:00"

    def test_map_document_all_optional_fields_present(self):
        # Arrange
        from migrate_2ndbrain import map_document_to_entry

        doc = {
            "id": "full001",
            "title": "Full Document",
            "summary": "Summary here",
            "long_summary": None,
            "category": "content",
            "type": "linkedin",
            "saved_at": "2026-01-10T12:00:00",
            "source_date": "2026-01-08",
            "url": "https://linkedin.com/post/123",
            "author": "John Doe",
            "preview": "Preview text",
            "added_by": "mickael",
            "subtype": "post",
            "status": "published",
            "content_file": "content/20260108_linkedin_post_foo.md",
        }

        # Act
        result = map_document_to_entry(doc)

        # Assert — all optional fields populate metadata
        meta = result["metadata"]
        assert meta["url"] == "https://linkedin.com/post/123"
        assert meta["author"] == "John Doe"
        assert meta["preview"] == "Preview text"
        assert meta["subtype"] == "post"
        assert meta["status"] == "published"
        assert meta["content_file"] == "content/20260108_linkedin_post_foo.md"


class TestClassifyFile:
    """Unit tests for classify_file directory-based categorisation."""

    def test_classify_learnings(self):
        # Arrange
        from migrate_2ndbrain import classify_file

        # Act
        category, type_, source_id = classify_file("learnings/session-foo.md")

        # Assert
        assert category == "knowledge"
        assert type_ == "learning"
        assert source_id == "file:learnings/session-foo.md"

    def test_classify_cv_adapted(self):
        # Arrange
        from migrate_2ndbrain import classify_file

        # Act
        category, type_, source_id = classify_file("cv/adapted/job/cv.md")

        # Assert
        assert category == "content"
        assert type_ == "cv-adapted"
        assert source_id == "file:cv/adapted/job/cv.md"

    def test_classify_linkedin(self):
        # Arrange
        from migrate_2ndbrain import classify_file

        # Act
        category, type_, source_id = classify_file(
            "content/20260128_linkedin_post_foo.md"
        )

        # Assert
        assert category == "content"
        assert type_ == "linkedin"
        assert source_id == "file:content/20260128_linkedin_post_foo.md"

    def test_classify_analyses(self):
        # Arrange
        from migrate_2ndbrain import classify_file

        # Act
        category, type_, source_id = classify_file("analyses/foo.md")

        # Assert
        assert category == "knowledge"
        assert type_ == "analysis"
        assert source_id == "file:analyses/foo.md"

    def test_classify_ideas(self):
        # Arrange
        from migrate_2ndbrain import classify_file

        # Act
        category, type_, source_id = classify_file("ideas/foo.md")

        # Assert
        assert category == "idea"
        assert type_ == "idea"
        assert source_id == "file:ideas/foo.md"

    def test_classify_root(self):
        # Arrange
        from migrate_2ndbrain import classify_file

        # Act
        category, type_, source_id = classify_file("projects-recap.md")

        # Assert — root-level file → knowledge / note
        assert category == "knowledge"
        assert type_ == "note"
        assert source_id == "file:projects-recap.md"

    def test_classify_content_non_linkedin(self):
        # Arrange
        from migrate_2ndbrain import classify_file

        # Act
        category, type_, source_id = classify_file("content/some-article.md")

        # Assert — content dir without linkedin in filename → article
        assert category == "content"
        assert type_ == "article"
        assert source_id == "file:content/some-article.md"

    def test_classify_cv_root(self):
        # Arrange
        from migrate_2ndbrain import classify_file

        # Act
        category, type_, source_id = classify_file("cv/cv-base.md")

        # Assert — cv root → cv-base
        assert category == "content"
        assert type_ == "cv-base"
        assert source_id == "file:cv/cv-base.md"


# ---------------------------------------------------------------------------
# T17 — Integration test: dedup + idempotency
# ---------------------------------------------------------------------------


class TestDeduplicationAndIdempotency:
    """Integration test: migrate 3 rows, verify second run skips all."""

    @pytest.fixture
    def source_db(self, tmp_path):
        """Fixture 2ndBrain DB with 3 document rows."""
        db_path = tmp_path / "memory.db"
        rows = [
            {
                "id": "dup00001",
                "category": "knowledge",
                "type": "twitter",
                "title": "First Entry",
                "summary": "Summary of first entry",
                "long_summary": None,
                "saved_at": "2026-01-01T00:00:00",
            },
            {
                "id": "dup00002",
                "category": "knowledge",
                "type": "github",
                "title": "Second Entry",
                "summary": "Summary of second entry",
                "long_summary": "Extended description of second entry",
                "saved_at": "2026-01-02T00:00:00",
            },
            {
                "id": "dup00003",
                "category": "content",
                "type": "linkedin",
                "title": "Third Entry",
                "summary": "Summary of third entry",
                "long_summary": None,
                "saved_at": "2026-01-03T00:00:00",
            },
        ]
        return _make_source_db(db_path, rows)

    def test_first_run_migrates_all_three(
        self, source_db, vault_db, embedder, knowledge_dir
    ):
        # Arrange
        from migrate_2ndbrain import migrate_db_entries

        # Act
        stats = migrate_db_entries(
            source_db, vault_db, embedder, knowledge_dir, dry_run=False
        )

        # Assert — 3 new entries, 0 skipped, 0 errors
        assert stats["new"] == 3
        assert stats["skipped"] == 0
        assert stats["errors"] == 0

    def test_second_run_skips_all(
        self, source_db, vault_db, embedder, knowledge_dir
    ):
        # Arrange — first run to populate vault
        from migrate_2ndbrain import migrate_db_entries

        migrate_db_entries(
            source_db, vault_db, embedder, knowledge_dir, dry_run=False
        )

        # Act — second run (idempotency)
        stats = migrate_db_entries(
            source_db, vault_db, embedder, knowledge_dir, dry_run=False
        )

        # Assert — 0 new, all 3 skipped
        assert stats["new"] == 0
        assert stats["skipped"] == 3
        assert stats["errors"] == 0

    def test_idempotency_total_count_unchanged(
        self, source_db, vault_db, embedder, knowledge_dir
    ):
        # Arrange
        from migrate_2ndbrain import migrate_db_entries

        migrate_db_entries(
            source_db, vault_db, embedder, knowledge_dir, dry_run=False
        )
        count_after_first = vault_db.connection.execute(
            "SELECT COUNT(*) FROM entries WHERE namespace='vault'"
        ).fetchone()[0]

        # Act
        migrate_db_entries(
            source_db, vault_db, embedder, knowledge_dir, dry_run=False
        )
        count_after_second = vault_db.connection.execute(
            "SELECT COUNT(*) FROM entries WHERE namespace='vault'"
        ).fetchone()[0]

        # Assert — no new rows added on second run
        assert count_after_first == 3
        assert count_after_second == count_after_first

    def test_dry_run_creates_no_entries(
        self, source_db, vault_db, embedder, knowledge_dir
    ):
        # Arrange
        from migrate_2ndbrain import migrate_db_entries

        # Act
        stats = migrate_db_entries(
            source_db, vault_db, embedder, knowledge_dir, dry_run=True
        )

        # Assert — stats show 3 new (would-be), but vault is empty
        assert stats["new"] == 3
        count = vault_db.connection.execute(
            "SELECT COUNT(*) FROM entries"
        ).fetchone()[0]
        assert count == 0


# ---------------------------------------------------------------------------
# T18 — Integration test: broken refs
# ---------------------------------------------------------------------------


class TestBrokenRefs:
    """Integration test: broken content_file ref is logged, migration continues."""

    @pytest.fixture
    def source_db_with_broken_ref(self, tmp_path):
        """Source DB with 1 row pointing to a non-existent file."""
        db_path = tmp_path / "memory.db"
        rows = [
            {
                "id": "brk00001",
                "category": "knowledge",
                "type": "twitter",
                "title": "Entry With Broken Ref",
                "summary": "Summary text",
                "long_summary": None,
                "saved_at": "2026-01-01T00:00:00",
                "content_file": "knowledge/does-not-exist.md",
            }
        ]
        return _make_source_db(db_path, rows)

    def test_broken_ref_entry_is_migrated(
        self, source_db_with_broken_ref, vault_db, embedder, knowledge_dir
    ):
        # Arrange
        from migrate_2ndbrain import migrate_db_entries

        # Act
        stats = migrate_db_entries(
            source_db_with_broken_ref,
            vault_db,
            embedder,
            knowledge_dir,
            dry_run=False,
        )

        # Assert — entry was still saved despite broken ref
        assert stats["new"] == 1
        assert stats["errors"] == 0
        count = vault_db.connection.execute(
            "SELECT COUNT(*) FROM entries WHERE namespace='vault'"
        ).fetchone()[0]
        assert count == 1

    def test_broken_ref_logged_in_stats(
        self, source_db_with_broken_ref, vault_db, embedder, knowledge_dir
    ):
        # Arrange
        from migrate_2ndbrain import migrate_db_entries

        # Act
        stats = migrate_db_entries(
            source_db_with_broken_ref,
            vault_db,
            embedder,
            knowledge_dir,
            dry_run=False,
        )

        # Assert — broken ref path appears in broken_refs list
        assert len(stats["broken_refs"]) == 1
        assert "does-not-exist.md" in stats["broken_refs"][0]



# ---------------------------------------------------------------------------
# T19 — Integration test: existing vault data preserved
# ---------------------------------------------------------------------------


class TestExistingVaultDataPreserved:
    """Integration test: pre-existing vault entries are untouched by migration."""

    @pytest.fixture
    def source_db(self, tmp_path):
        """Fixture source DB with 2 documents."""
        db_path = tmp_path / "memory.db"
        rows = [
            {
                "id": "new00001",
                "category": "knowledge",
                "type": "twitter",
                "title": "New Entry One",
                "summary": "First new entry summary",
                "long_summary": None,
                "saved_at": "2026-01-01T00:00:00",
            },
            {
                "id": "new00002",
                "category": "knowledge",
                "type": "github",
                "title": "New Entry Two",
                "summary": "Second new entry summary",
                "long_summary": None,
                "saved_at": "2026-01-02T00:00:00",
            },
        ]
        return _make_source_db(db_path, rows)

    @pytest.fixture
    def vault_db_with_existing(self, tmp_path):
        """Vault DB pre-seeded with 2 entries that have no source_id in metadata."""
        db = _make_vault_db(tmp_path / "vault.db")
        # Insert pre-existing entries directly (no source_id in metadata)
        db.save_entry(
            content="Pre-existing vault entry alpha",
            type="note",
            title="Pre-existing Alpha",
            category="knowledge",
            namespace="vault",
            metadata={"note": "already here"},
        )
        db.save_entry(
            content="Pre-existing vault entry beta",
            type="note",
            title="Pre-existing Beta",
            category="knowledge",
            namespace="vault",
            metadata={"note": "also already here"},
        )
        return db

    def test_pre_existing_entries_still_present(
        self, source_db, vault_db_with_existing, embedder, knowledge_dir
    ):
        # Arrange
        from migrate_2ndbrain import migrate_db_entries

        # Act
        migrate_db_entries(
            source_db,
            vault_db_with_existing,
            embedder,
            knowledge_dir,
            dry_run=False,
        )

        # Assert — vault now has 2 pre-existing + 2 migrated = 4 entries total
        count = vault_db_with_existing.connection.execute(
            "SELECT COUNT(*) FROM entries WHERE namespace='vault'"
        ).fetchone()[0]
        assert count == 4

    def test_pre_existing_titles_unchanged(
        self, source_db, vault_db_with_existing, embedder, knowledge_dir
    ):
        # Arrange
        from migrate_2ndbrain import migrate_db_entries

        # Record pre-existing titles before migration
        before = vault_db_with_existing.connection.execute(
            "SELECT id, title, content FROM entries WHERE namespace='vault' ORDER BY id"
        ).fetchall()
        assert len(before) == 2

        # Act
        migrate_db_entries(
            source_db,
            vault_db_with_existing,
            embedder,
            knowledge_dir,
            dry_run=False,
        )

        # Assert — pre-existing rows are identical after migration
        after = vault_db_with_existing.connection.execute(
            "SELECT id, title, content FROM entries WHERE namespace='vault' ORDER BY id"
        ).fetchall()
        # First 2 rows should be unchanged (same id, title, content)
        assert after[0]["id"] == before[0]["id"]
        assert after[0]["title"] == before[0]["title"]
        assert after[0]["content"] == before[0]["content"]
        assert after[1]["id"] == before[1]["id"]
        assert after[1]["title"] == before[1]["title"]
        assert after[1]["content"] == before[1]["content"]

    def test_pre_existing_metadata_no_source_id(
        self, source_db, vault_db_with_existing, embedder, knowledge_dir
    ):
        # Arrange
        from migrate_2ndbrain import migrate_db_entries

        # Act
        migrate_db_entries(
            source_db,
            vault_db_with_existing,
            embedder,
            knowledge_dir,
            dry_run=False,
        )

        # Assert — pre-existing entries still have no source_id in metadata
        rows = vault_db_with_existing.connection.execute(
            "SELECT metadata FROM entries WHERE title LIKE 'Pre-existing%' ORDER BY id"
        ).fetchall()
        assert len(rows) == 2
        for row in rows:
            meta = json.loads(row[0])
            assert "source_id" not in meta


# ---------------------------------------------------------------------------
# T20 — Unit tests: detect_source
# ---------------------------------------------------------------------------


class TestDetectSource:
    """Unit tests for detect_source path resolution and schema validation."""

    def test_valid_db_returns_path(self, tmp_path):
        # Arrange — create a valid source DB
        db_path = tmp_path / "memory.db"
        _make_source_db(db_path, [])

        from migrate_2ndbrain import detect_source

        # Act
        result = detect_source(str(db_path))

        # Assert
        assert result == db_path

    def test_missing_file_raises(self, tmp_path):
        # Arrange
        missing = tmp_path / "does_not_exist.db"

        from migrate_2ndbrain import MigrationError, detect_source

        # Act / Assert
        with pytest.raises(MigrationError, match="Source not found"):
            detect_source(str(missing))

    def test_missing_table_raises(self, tmp_path):
        # Arrange — DB with no documents table
        db_path = tmp_path / "empty.db"
        conn = sqlite3.connect(str(db_path))
        conn.close()

        from migrate_2ndbrain import MigrationError, detect_source

        # Act / Assert
        with pytest.raises(MigrationError, match="Table 'documents' not found"):
            detect_source(str(db_path))

    def test_missing_columns_raises(self, tmp_path):
        # Arrange — DB with documents table but missing required columns
        db_path = tmp_path / "bad_schema.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT)")
        conn.commit()
        conn.close()

        from migrate_2ndbrain import MigrationError, detect_source

        # Act / Assert
        with pytest.raises(MigrationError, match="Missing columns"):
            detect_source(str(db_path))


# ---------------------------------------------------------------------------
# T21 — Unit tests: get_vault_dest
# ---------------------------------------------------------------------------


class TestGetVaultDest:
    """Unit tests for get_vault_dest path mapping and traversal guard."""

    def test_normal_path_resolves_under_vault_home(self, tmp_path, monkeypatch):
        # Arrange — patch get_vault_home to a known tmp dir
        from migrate_2ndbrain import get_vault_dest
        import migrate_2ndbrain as mod

        vault_home = tmp_path / "vault"
        vault_home.mkdir()
        monkeypatch.setattr(mod, "get_vault_home", lambda: vault_home)

        # Act
        result = get_vault_dest("analyses/foo.md")

        # Assert — result is inside vault_home
        assert result == (vault_home / "analyses/foo.md").resolve()
        assert result.is_relative_to(vault_home.resolve())

    def test_absolute_path_raises(self, tmp_path, monkeypatch):
        # Arrange
        from migrate_2ndbrain import get_vault_dest
        import migrate_2ndbrain as mod

        vault_home = tmp_path / "vault"
        vault_home.mkdir()
        monkeypatch.setattr(mod, "get_vault_home", lambda: vault_home)

        # Act / Assert — absolute path must not bypass vault home
        with pytest.raises(ValueError, match="Path traversal detected"):
            get_vault_dest("/etc/passwd")

    def test_traversal_path_raises(self, tmp_path, monkeypatch):
        # Arrange
        from migrate_2ndbrain import get_vault_dest
        import migrate_2ndbrain as mod

        vault_home = tmp_path / "vault"
        vault_home.mkdir()
        monkeypatch.setattr(mod, "get_vault_home", lambda: vault_home)

        # Act / Assert — "../" sequences must be rejected
        with pytest.raises(ValueError, match="Path traversal detected"):
            get_vault_dest("../../etc/passwd")


# ---------------------------------------------------------------------------
# T22 — Unit tests: create_file_entry
# ---------------------------------------------------------------------------


class TestCreateFileEntry:
    """Unit tests for create_file_entry disk-only file ingestion."""

    def test_creates_entry_for_disk_only_file(
        self, tmp_path, vault_db, embedder, knowledge_dir
    ):
        # Arrange — write a small markdown file
        md_file = knowledge_dir / "analyses" / "my-analysis.md"
        md_file.parent.mkdir(parents=True, exist_ok=True)
        md_file.write_text("# My Analysis\n\nSome content here.", encoding="utf-8")

        from migrate_2ndbrain import create_file_entry

        # Act
        entry_id = create_file_entry(vault_db, embedder, md_file, knowledge_dir)

        # Assert — a real entry ID is returned and the entry exists in the DB
        assert entry_id is not None
        assert isinstance(entry_id, int)
        assert entry_id > 0
        count = vault_db.connection.execute(
            "SELECT COUNT(*) FROM entries WHERE namespace='vault'"
        ).fetchone()[0]
        assert count == 1

    def test_dedup_skips_existing_entry(
        self, tmp_path, vault_db, embedder, knowledge_dir
    ):
        # Arrange — write a small markdown file and create its entry once
        md_file = knowledge_dir / "ideas" / "my-idea.md"
        md_file.parent.mkdir(parents=True, exist_ok=True)
        md_file.write_text("# My Idea\n\nGreat idea here.", encoding="utf-8")

        from migrate_2ndbrain import create_file_entry

        first_id = create_file_entry(vault_db, embedder, md_file, knowledge_dir)
        assert first_id is not None

        # Act — call again (dedup should kick in)
        second_id = create_file_entry(vault_db, embedder, md_file, knowledge_dir)

        # Assert — None returned, still only 1 entry in vault
        assert second_id is None
        count = vault_db.connection.execute(
            "SELECT COUNT(*) FROM entries WHERE namespace='vault'"
        ).fetchone()[0]
        assert count == 1

    def test_large_file_skipped(self, tmp_path, vault_db, embedder, knowledge_dir):
        # Arrange — create a file larger than 1 MB
        md_file = knowledge_dir / "analyses" / "big-file.md"
        md_file.parent.mkdir(parents=True, exist_ok=True)
        md_file.write_bytes(b"x" * (1_048_576 + 1))

        from migrate_2ndbrain import create_file_entry

        # Act
        result = create_file_entry(vault_db, embedder, md_file, knowledge_dir)

        # Assert — None returned, no entry created
        assert result is None
        count = vault_db.connection.execute(
            "SELECT COUNT(*) FROM entries"
        ).fetchone()[0]
        assert count == 0


# ---------------------------------------------------------------------------
# T23 — Unit tests: generate_report
# ---------------------------------------------------------------------------


class TestGenerateReport:
    """Unit tests for generate_report JSON structure assembly."""

    def test_assembles_correct_json_structure(self):
        from migrate_2ndbrain import generate_report

        db_stats = {
            "new": 10,
            "skipped": 2,
            "errors": 1,
            "broken_refs": ["analyses/missing.md"],
            "migrated_source_ids": {"id1", "id2"},
        }
        file_stats = {
            "copied": 8,
            "new_entries": 5,
            "errors": 0,
        }
        count_check = {
            "source_count": 10,
            "vault_count": 12,
            "by_category": {"source": {"knowledge": 10}, "vault": {"knowledge": 12}},
        }
        fts_results = [
            {"query": "twitter", "desc": "knowledge/twitter entries", "hits": 3, "pass": True},
            {"query": "github", "desc": "knowledge/github entries", "hits": 0, "pass": False},
        ]

        # Act
        report = generate_report(db_stats, file_stats, count_check, fts_results, ["analyses/missing.md"])

        # Assert — top-level structure
        assert "migration" in report
        assert "verification" in report

        # DB entries section
        assert report["migration"]["db_entries"]["new"] == 10
        assert report["migration"]["db_entries"]["skipped"] == 2
        assert report["migration"]["db_entries"]["errors"] == 1

        # Files section
        assert report["migration"]["files"]["copied"] == 8
        assert report["migration"]["files"]["new_entries"] == 5
        assert report["migration"]["files"]["errors"] == 0

        # Broken refs
        assert report["migration"]["broken_refs"] == ["analyses/missing.md"]

        # Verification section
        assert report["verification"]["counts"] == count_check
        assert report["verification"]["fts_smoke_tests"] == fts_results
        assert report["verification"]["all_fts_pass"] is False

        # Idempotent flag — new > 0 so not idempotent
        assert report["idempotent"] is False

    def test_idempotent_flag_set_when_all_skipped(self):
        from migrate_2ndbrain import generate_report

        db_stats = {"new": 0, "skipped": 5, "errors": 0, "broken_refs": [], "migrated_source_ids": set()}
        file_stats = {"copied": 3, "new_entries": 0, "errors": 0}
        count_check = {}
        fts_results = []

        report = generate_report(db_stats, file_stats, count_check, fts_results, [])

        assert report["idempotent"] is True
