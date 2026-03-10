#!/usr/bin/env python3
"""Migrate 2ndBrain memory.db + knowledge/ files to Roxabi Vault (v2 + fastembed)."""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import TYPE_CHECKING

# ---------------------------------------------------------------------------
# Resolve imports — match the pattern from manage_vault.py
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # plugin root
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))       # repo root

from roxabi_sdk.paths import get_vault_home

if TYPE_CHECKING:
    from roxabi_memory import Embedder
    from roxabi_memory.db import MemoryDB

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_SOURCE = Path.home() / "projects/2ndBrain/knowledge/memory.db"
DEFAULT_KNOWLEDGE_DIR = Path.home() / "projects/2ndBrain/knowledge"

EXPECTED_COLUMNS = {"id", "category", "type", "title", "summary", "saved_at"}

# Directory → (category, type) for disk-only files
DIR_CATEGORY_MAP: dict[str, tuple[str, str]] = {
    "analyses": ("knowledge", "analysis"),
    "content":  ("content", "article"),   # may be overridden by linkedin detection
    "cv":       ("content", "cv-base"),
    "ideas":    ("idea", "idea"),
    "learnings": ("knowledge", "learning"),
}

SMOKE_QUERIES = [
    ("twitter",          "knowledge/twitter entries"),
    ("github",           "knowledge/github entries"),
    ("linkedin",         "content/linkedin entries"),
    ("mmorpg",           "learnings content"),
    ("Product Manager",  "CV entries"),
]


# ---------------------------------------------------------------------------
# T1 — Source detection + schema validation
# ---------------------------------------------------------------------------
def detect_source(path: str | None = None) -> Path:
    """Resolve and validate the source memory.db path."""
    p = Path(path) if path else DEFAULT_SOURCE
    if not p.exists():
        print(json.dumps({"error": f"Source not found: {p}"}))
        sys.exit(1)

    conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(documents)")}
    finally:
        conn.close()

    if not cols:
        print(json.dumps({"error": "Table 'documents' not found in source database"}))
        sys.exit(1)

    missing = EXPECTED_COLUMNS - cols
    if missing:
        print(json.dumps(
            {"error": f"Missing columns in documents table: {sorted(missing)}"}
        ))
        sys.exit(1)

    return p


# ---------------------------------------------------------------------------
# T2 — Read source documents
# ---------------------------------------------------------------------------
def read_source_documents(src: Path) -> list[dict]:
    """Return all rows from the source documents table as dicts."""
    conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM documents").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# T3 — Field mapping + dedup check
# ---------------------------------------------------------------------------
def map_document_to_entry(doc: dict) -> dict:
    """Map a 2ndBrain document row to a vault entry dict."""
    content = doc["summary"]
    if doc.get("long_summary"):
        content = content + "\n\n" + doc["long_summary"]

    metadata: dict = {
        "source_id":    doc["id"],
        "url":          doc.get("url"),
        "author":       doc.get("author"),
        "preview":      doc.get("preview"),
        "added_by":     doc.get("added_by"),
        "subtype":      doc.get("subtype"),
        "status":       doc.get("status"),
        "content_file": doc.get("content_file"),
    }
    # Strip None values so metadata stays clean
    metadata = {k: v for k, v in metadata.items() if v is not None}

    return {
        "title":      doc["title"],
        "content":    content,
        "category":   doc["category"],
        "type":       doc["type"],
        "namespace":  "vault",
        "metadata":   metadata,
        "created_at": doc.get("saved_at"),
        "event_date": doc.get("source_date"),
    }


def check_dedup(vault_conn: sqlite3.Connection, source_id: str) -> bool:
    """Return True if an entry with this source_id already exists in the vault."""
    row = vault_conn.execute(
        "SELECT id FROM entries WHERE json_extract(metadata, '$.source_id') = ?",
        (source_id,),
    ).fetchone()
    return row is not None


# ---------------------------------------------------------------------------
# T4 — Save entry via MemoryDB.save_entry()
# ---------------------------------------------------------------------------
def save_entry(db: "MemoryDB", mapped: dict) -> int:
    """Persist a mapped entry via the roxabi-memory API. Returns the new entry ID."""
    entry = db.save_entry(
        content=mapped["content"],
        type=mapped["type"],
        title=mapped["title"],
        category=mapped["category"],
        namespace=mapped["namespace"],
        metadata=mapped["metadata"],
    )
    return entry.id


# ---------------------------------------------------------------------------
# T5 — Embed + set event_date via raw UPDATE
# ---------------------------------------------------------------------------
def embed_and_update(
    db: "MemoryDB",
    embedder: "Embedder",
    entry_id: int,
    content: str,
    event_date: str | None,
) -> None:
    """Compute embedding and write it (+ event_date) directly into the entries row."""
    embedding = embedder.embed(content)
    db.connection.execute(
        "UPDATE entries SET embedding = ?, event_date = ? WHERE id = ?",
        (embedding, event_date, entry_id),
    )
    db.connection.commit()


# ---------------------------------------------------------------------------
# T6 — Migration loop + broken ref detection
# ---------------------------------------------------------------------------
def migrate_db_entries(
    src: Path,
    db: "MemoryDB",
    embedder: "Embedder",
    knowledge_dir: Path,
    dry_run: bool = False,
) -> dict:
    """Migrate all documents from source DB to vault. Returns stats dict."""
    docs = read_source_documents(src)
    stats: dict = {"new": 0, "skipped": 0, "errors": 0, "broken_refs": []}

    for doc in docs:
        try:
            mapped = map_document_to_entry(doc)
            source_id = mapped["metadata"]["source_id"]

            if check_dedup(db.connection, str(source_id)):
                stats["skipped"] += 1
                continue

            if not dry_run:
                entry_id = save_entry(db, mapped)
                embed_and_update(
                    db, embedder, entry_id, mapped["content"], mapped["event_date"]
                )

            stats["new"] += 1

            # Detect broken file references
            cf = doc.get("content_file")
            if cf and not (knowledge_dir / cf).exists():
                stats["broken_refs"].append(cf)
                print(
                    json.dumps({"warning": f"Broken file ref for {doc['id']}: {cf}"}),
                    file=sys.stderr,
                )

        except Exception as exc:
            stats["errors"] += 1
            print(
                json.dumps({"warning": f"Failed on doc {doc.get('id', '?')}: {exc}"}),
                file=sys.stderr,
            )

    return stats


# ---------------------------------------------------------------------------
# T7 — Scan knowledge directory
# ---------------------------------------------------------------------------
def scan_knowledge_dir(knowledge_dir: Path) -> list[Path]:
    """Return all .md files under knowledge_dir, sorted."""
    return sorted(knowledge_dir.rglob("*.md"))


# ---------------------------------------------------------------------------
# T8 — Copy files to vault + destination mapping
# ---------------------------------------------------------------------------
def get_vault_dest(relative_path: str) -> Path:
    """Map a source-relative path to its vault destination path."""
    return get_vault_home() / relative_path


def copy_file_to_vault(src_file: Path, knowledge_dir: Path) -> Path:
    """Copy src_file into the vault, preserving directory structure."""
    relative = src_file.relative_to(knowledge_dir)
    dest = get_vault_dest(str(relative))
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_file, dest)
    return dest


# ---------------------------------------------------------------------------
# T9 — Classify disk-only files
# ---------------------------------------------------------------------------
def classify_file(relative_path: str) -> tuple[str, str, str]:
    """Return (category, type, source_id) for a file that has no DB entry."""
    parts = Path(relative_path).parts
    source_id = f"file:{relative_path}"

    # cv/adapted/ must be checked before cv/ (more specific first)
    if len(parts) >= 2 and parts[0] == "cv" and parts[1] == "adapted":
        return "content", "cv-adapted", source_id

    dir_name = parts[0] if parts else ""
    cat, typ = DIR_CATEGORY_MAP.get(dir_name, ("knowledge", "note"))

    # LinkedIn detection by filename keyword
    if dir_name == "content" and "linkedin" in relative_path.lower():
        typ = "linkedin"

    return cat, typ, source_id


# ---------------------------------------------------------------------------
# T10 — Create entries for disk-only files
# ---------------------------------------------------------------------------
def create_file_entry(
    db: "MemoryDB",
    embedder: "Embedder",
    file_path: Path,
    knowledge_dir: Path,
    dry_run: bool = False,
) -> int | None:
    """Create a vault entry for a markdown file that has no DB-backed row."""
    relative = str(file_path.relative_to(knowledge_dir))
    cat, typ, source_id = classify_file(relative)

    if check_dedup(db.connection, source_id):
        return None  # already migrated (idempotent)

    content = file_path.read_text(encoding="utf-8")
    title = file_path.stem.replace("-", " ").replace("_", " ")
    metadata: dict = {"source_id": source_id, "content_file": relative}

    if dry_run:
        return -1  # sentinel: would create

    entry_id = save_entry(
        db,
        {
            "title":      title,
            "content":    content,
            "category":   cat,
            "type":       typ,
            "namespace":  "vault",
            "metadata":   metadata,
            "created_at": None,
            "event_date": None,
        },
    )
    embed_and_update(db, embedder, entry_id, content, None)
    return entry_id


# ---------------------------------------------------------------------------
# T11 — File migration loop
# ---------------------------------------------------------------------------
def migrate_files(
    knowledge_dir: Path,
    db: "MemoryDB",
    embedder: "Embedder",
    migrated_source_ids: set,
    dry_run: bool = False,
) -> dict:
    """Copy all .md files to vault and create entries for disk-only files."""
    files = scan_knowledge_dir(knowledge_dir)
    stats: dict = {"copied": 0, "new_entries": 0, "skipped": 0, "errors": 0}

    for f in files:
        try:
            relative = str(f.relative_to(knowledge_dir))

            if not dry_run:
                copy_file_to_vault(f, knowledge_dir)
            stats["copied"] += 1

            # Skip entry creation if this file already has a DB-backed entry
            file_source_id = f"file:{relative}"
            already_exists = file_source_id in migrated_source_ids or check_dedup(
                db.connection, file_source_id
            )
            if already_exists:
                stats["skipped"] += 1
                continue

            # Also skip if a DB entry references this file via content_file
            _sql = (
                "SELECT id FROM entries"
                " WHERE json_extract(metadata, '$.content_file') = ?"
            )
            row = db.connection.execute(_sql, (relative,)).fetchone()
            if row:
                stats["skipped"] += 1
                continue

            # Disk-only file — create entry
            entry_id = create_file_entry(db, embedder, f, knowledge_dir, dry_run)
            if entry_id is not None:
                stats["new_entries"] += 1

        except Exception as exc:
            stats["errors"] += 1
            print(
                json.dumps({"warning": f"Failed on file {f}: {exc}"}),
                file=sys.stderr,
            )

    return stats


# ---------------------------------------------------------------------------
# T12 — Count verification
# ---------------------------------------------------------------------------
def verify_counts(db: "MemoryDB", src: Path) -> dict:
    """Compare source document counts vs vault entry counts."""
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        src_count: int = src_conn.execute(
            "SELECT COUNT(*) FROM documents"
        ).fetchone()[0]
        src_by_cat: dict = dict(
            src_conn.execute(
                "SELECT category, COUNT(*) FROM documents GROUP BY category"
            ).fetchall()
        )
    finally:
        src_conn.close()

    vault_total: int = db.connection.execute(
        "SELECT COUNT(*) FROM entries WHERE namespace = 'vault'"
    ).fetchone()[0]
    vault_by_cat: dict = dict(
        db.connection.execute(
            "SELECT category, COUNT(*) FROM entries"
            " WHERE namespace = 'vault' GROUP BY category"
        ).fetchall()
    )

    return {
        "source_count":    src_count,
        "vault_count":     vault_total,
        "by_category": {
            "source": src_by_cat,
            "vault":  vault_by_cat,
        },
    }


# ---------------------------------------------------------------------------
# T13 — FTS5 smoke tests
# ---------------------------------------------------------------------------
def verify_fts(db: "MemoryDB") -> list[dict]:
    """Run 5 FTS5 smoke queries. Each must return at least 1 result."""
    from roxabi_memory.fts import search_fts

    results = []
    for query, desc in SMOKE_QUERIES:
        hits = search_fts(db.connection, query, namespace="vault", limit=5)
        results.append({
            "query": query,
            "desc":  desc,
            "hits":  len(hits),
            "pass":  len(hits) >= 1,
        })
    return results


# ---------------------------------------------------------------------------
# T14 — Report generation + main() integration
# ---------------------------------------------------------------------------
def generate_report(
    db_stats: dict,
    file_stats: dict,
    count_check: dict,
    fts_results: list[dict],
    broken_refs: list[str],
) -> dict:
    """Assemble the final JSON report."""
    return {
        "migration": {
            "db_entries": {
                "new":     db_stats["new"],
                "skipped": db_stats["skipped"],
                "errors":  db_stats["errors"],
            },
            "files": {
                "copied":      file_stats["copied"],
                "new_entries": file_stats["new_entries"],
                "errors":      file_stats.get("errors", 0),
            },
            "broken_refs": broken_refs,
        },
        "verification": {
            "counts":          count_check,
            "fts_smoke_tests": fts_results,
            "all_fts_pass":    all(r["pass"] for r in fts_results),
        },
        # True on a re-run: everything was already migrated
        "idempotent": db_stats["skipped"] > 0 and db_stats["new"] == 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate 2ndBrain memory.db + knowledge/ files to Roxabi Vault."
    )
    parser.add_argument(
        "--source",
        help="Path to source memory.db "
        "(default: ~/projects/2ndBrain/knowledge/memory.db)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate without writing to vault",
    )
    parser.add_argument(
        "--knowledge-dir",
        help="Path to 2ndBrain knowledge/ directory "
        "(default: ~/projects/2ndBrain/knowledge)",
    )
    args = parser.parse_args()

    # Phase 1 — Detect + validate source
    print("Detecting source database...", file=sys.stderr)
    src = detect_source(args.source)
    knowledge_dir = (
        Path(args.knowledge_dir) if args.knowledge_dir else DEFAULT_KNOWLEDGE_DIR
    )
    print(f"Source: {src}", file=sys.stderr)
    print(f"Knowledge dir: {knowledge_dir}", file=sys.stderr)

    if args.dry_run:
        print("DRY-RUN mode — no data will be written.", file=sys.stderr)

    # Phase 2 — Open vault DB
    vault_db_path = get_vault_home() / "vault.db"
    print(f"Vault: {vault_db_path}", file=sys.stderr)

    from roxabi_memory.db import MemoryDB

    db = MemoryDB(vault_db_path)
    db.connect()

    try:
        # Phase 3 — Instantiate embedder ONCE (loads ONNX model)
        print("Loading embedding model...", file=sys.stderr)
        from roxabi_memory import Embedder
        embedder = Embedder()

        # Phase 4 — Migrate DB entries
        print("Migrating DB entries...", file=sys.stderr)
        db_stats = migrate_db_entries(
            src, db, embedder, knowledge_dir, dry_run=args.dry_run
        )
        print(
            f"  DB: {db_stats['new']} new, {db_stats['skipped']} skipped, "
            f"{db_stats['errors']} errors, {len(db_stats['broken_refs'])} broken refs",
            file=sys.stderr,
        )

        # Phase 5 — Migrate files
        print("Migrating files...", file=sys.stderr)
        file_stats = migrate_files(
            knowledge_dir,
            db,
            embedder,
            migrated_source_ids=set(),
            dry_run=args.dry_run,
        )
        print(
            f"  Files: {file_stats['copied']} copied, "
            f"{file_stats['new_entries']} new entries",
            file=sys.stderr,
        )

        # Phase 6 — Verification
        print("Verifying migration...", file=sys.stderr)
        count_check = verify_counts(db, src)
        fts_results = verify_fts(db) if not args.dry_run else []

        broken_refs = db_stats.pop("broken_refs", [])
        report = generate_report(
            db_stats, file_stats, count_check, fts_results, broken_refs
        )

        print(json.dumps(report, indent=2))

    finally:
        db.close()


if __name__ == "__main__":
    main()
