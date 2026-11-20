# Index resources run after transfer and before setup. All paths are caller-proved worktree paths.
run_pre_setup_indexes() {
  if [ -f "$principal/.codegraph/codegraph.db" ]; then
    need_cli codegraph codegraph
    codegraph init -y "$here"
  fi
}

