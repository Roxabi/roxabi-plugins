# Index resources run after transfer and before setup. All paths are caller-proved worktree paths.
copy_ccc_stores() {
  python3 - "$1" "$2" << 'PY'
import os, shutil, sqlite3, sys
src, dest = sys.argv[1], sys.argv[2]
state = os.path.join("cocoindex.db", "mdb", "data.mdb")
vectors = "target_sqlite.db"
def stamp():
    return [os.stat(os.path.join(src, name)).st_mtime_ns for name in (state, vectors)]

try:
    before = stamp()
    os.makedirs(os.path.dirname(os.path.join(dest, state)), exist_ok=True)
    shutil.copyfile(os.path.join(src, state), os.path.join(dest, state))
    source = sqlite3.connect(os.path.join(src, vectors), timeout=30)
    source.backup(sqlite3.connect(os.path.join(dest, vectors)))
    if stamp() != before:
        raise RuntimeError("principal index changed during the copy")
except Exception as error:
    print(f"bootstrap=cocoindex-copy-skipped {error}", file=sys.stderr)
    sys.exit(1)
PY
}

run_pre_setup_indexes() {
  if [ -f "$principal/.cocoindex_code/settings.yml" ]; then
    need_cli ccc cocoindex
    ccc_dir="$here/.cocoindex_code"
    if [ ! -f "$ccc_dir/settings.yml" ]; then
      mkdir -p "$ccc_dir"
      cp "$principal/.cocoindex_code/settings.yml" "$ccc_dir/settings.yml"
      copy_ccc_stores "$principal/.cocoindex_code" "$ccc_dir" ||
        rm -rf "$ccc_dir/cocoindex.db" "$ccc_dir/target_sqlite.db"
    fi
    # An unreadable copy fails the index: drop it from the daemon and rebuild.
    (cd "$here" && ccc index) || (cd "$here" && ccc reset -f && ccc index)
  fi

  if [ -f "$principal/.codegraph/codegraph.db" ]; then
    need_cli codegraph codegraph
    codegraph init -y "$here"
  fi
}

run_semctx_index() {
  if [ -d "$here/.semctx" ]; then
    need_cli semctx semctx
    (cd "$here" && semctx index)
  fi
}
