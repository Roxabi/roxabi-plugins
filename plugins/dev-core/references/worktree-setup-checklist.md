---
version: 1
---

# Worktree Setup Checklist

This file is parsed by `tools/worktreeScaffold.ts` (dev-core). The scaffolder reads each concern, evaluates its `applies_when` signals against the current project's `ProjectContext` (derived from `.claude/stack.yml` and filesystem probes), then composes the matching setup/teardown snippets into `tools/worktree-setup.sh` and `tools/worktree-teardown.sh` in the user's project root. The LLM may re-order concerns and insert bridging comments between snippets for readability, but **must not rewrite snippet bodies** — snippets are audited for correctness and must land verbatim.

## Concerns

```yaml
- id: env-files
  applies_when: ["env_files=present"]
  setup_snippet: |
    # copy .env.example → .env if missing
    if [ -f .env.example ] && [ ! -f .env ]; then
      cp .env.example .env
      echo "worktree-setup: created .env from .env.example"
    fi
  teardown_snippet: |
    # noop — env files stay in worktree after teardown
    :
  validation: "exits 0 whether .env already exists or .env.example is absent"

- id: uv-venv-symlink
  applies_when: ["runtime=python", "package_manager=uv"]
  setup_snippet: |
    MAIN_REPO=$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')

    if [ -z "${MAIN_REPO:-}" ] || [ ! -d "${MAIN_REPO}/.venv" ]; then
      echo "worktree-setup: main repo .venv not found at ${MAIN_REPO:-?} — skipping" >&2
      exit 0
    fi

    if [ "${PWD}" = "${MAIN_REPO}" ]; then
      echo "worktree-setup: running inside main repo, refusing to symlink .venv onto itself" >&2
      exit 0
    fi

    if [ -L .venv ]; then
      rm .venv
    elif [ -d .venv ]; then
      echo "worktree-setup: .venv already exists as a real directory — leaving it untouched" >&2
      exit 0
    fi

    ln -s "${MAIN_REPO}/.venv" .venv
    echo "worktree-setup: linked .venv → ${MAIN_REPO}/.venv"
  teardown_snippet: |
    # remove symlink only — never touch a real directory
    [ -L .venv ] && rm .venv || true
  validation: "symlink created when main .venv exists; skips cleanly when running in main checkout or .venv is a real dir"

- id: bun-install-warmup
  applies_when: ["runtime=bun"]
  setup_snippet: |
    bun install
  teardown_snippet: |
    :
  validation: "bun install succeeds in worktree"

- id: npm-install-warmup
  applies_when: ["runtime=node"]
  setup_snippet: |
    "${PM:-npm}" install
  teardown_snippet: |
    :
  validation: "install succeeds; respects PM env var override"

- id: lefthook-hookspath-fix
  applies_when: ["hooks_tool=lefthook"]
  setup_snippet: |
    # in worktrees, lefthook installs core.hooksPath relative to the worktree git dir (wrong —
    # git uses the common dir for hooks). unset so git falls back to the default hooks path.
    GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
    GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
    if [ "${GIT_DIR}" != "${GIT_COMMON_DIR}" ]; then
      git config --unset-all core.hooksPath 2>/dev/null || true
    fi
  teardown_snippet: |
    :
  validation: "core.hooksPath is unset when inside a worktree; no-op in main checkout"

- id: neon-db-branch
  applies_when: ["database=neon"]
  setup_snippet: |
    N="${1:-}"
    [ -z "${N}" ] && exit 0
    [ -d apps/api ] && (cd apps/api && bun run db:branch:create --force "${N}" 2>/dev/null) || true
  teardown_snippet: |
    N="${1:-}"
    [ -z "${N}" ] && exit 0
    [ -d apps/api ] && (cd apps/api && bun run db:branch:drop --force "${N}" 2>/dev/null) || true
  validation: "exits 0 when N is missing; never errors fatally even if db command fails"
```

## Extending the checklist

### Schema

Each concern has five fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique kebab-case identifier. Used as a comment header in generated scripts. |
| `applies_when` | string[] | AND-joined signal expressions. Grammar: `key=value`. The scaffolder matches each pair against `ProjectContext`. All signals in the list must match for the concern to be included. |
| `setup_snippet` | multiline string | Bash fragment injected into `worktree-setup.sh`. Must be `set -euo pipefail`-compatible. |
| `teardown_snippet` | multiline string | Bash fragment injected into `worktree-teardown.sh`. Use `:` for a deliberate no-op. |
| `validation` | string | Human-readable description of the postcondition. Used in code review and documentation only. |

`applies_when` supports a single `key=value` token per list item. The scaffolder treats list items as AND conditions — if multiple signals are listed, all must be true. To express OR logic, add separate concerns with overlapping snippets.

### Worked example — `docker-volume-reset`

Suppose your project uses Docker Compose and you want each worktree to start with a clean named volume. Add this entry:

```yaml
  - id: docker-volume-reset
    applies_when: ["infrastructure=docker-compose"]
    setup_snippet: |
      # create a worktree-scoped docker volume named after the branch
      BRANCH=$(git rev-parse --abbrev-ref HEAD)
      VOLUME="myapp_db_${BRANCH//\//_}"
      docker volume create "${VOLUME}" 2>/dev/null || true
      echo "worktree-setup: volume ${VOLUME} ready"
    teardown_snippet: |
      BRANCH=$(git rev-parse --abbrev-ref HEAD)
      VOLUME="myapp_db_${BRANCH//\//_}"
      docker volume rm "${VOLUME}" 2>/dev/null || true
    validation: "volume is created on setup and removed on teardown; both sides exit 0 if docker is unavailable"
```

Then set `infrastructure: docker-compose` in `.claude/stack.yml`. The scaffolder picks up the signal on next run and regenerates the scripts. **No skill code changes required.**

The `neon-db-branch` concern above follows the same pattern: it accepts an optional branch name argument `$1`, silently exits when not provided, and delegates to a project-local `bun run` command — showing that snippets can call project tooling without coupling to scaffolder internals.

## Safety contract

Every snippet included in this checklist must honour the following invariants:

- **Setup — skip if target is a real directory.** If the concern would create or replace a path (`.venv`, a Docker volume, etc.), check whether it already exists as a real directory or file owned by the user. Leave it untouched and exit 0 rather than overwriting user state.
- **Setup — replace stale symlinks.** If the path exists as a symlink (possibly pointing at a deleted worktree), remove and recreate it. A stale symlink is not user state worth preserving.
- **Setup — refuse to act inside the main checkout.** Concerns that are only meaningful in a worktree (e.g. `.venv` symlinking) must detect `PWD == MAIN_REPO` and exit 0 cleanly.
- **Teardown — stay inside the worktree.** Teardown snippets must never remove files from the main checkout or from other worktrees. Operate only on paths relative to `PWD` (the worktree being destroyed).
- **Teardown — never delete real directories.** Only remove symlinks or resources the setup snippet itself created (named volumes, branches). Guard with `[ -L path ]` before `rm`.
- **All snippets exit 0 on no-op.** Missing prerequisites, absent env vars, or already-satisfied state must produce a clean exit, never a non-zero code that aborts the generated script under `set -euo pipefail`.
- **Quote all variable expansions.** Use `"${VAR}"` throughout. Bare `$VAR` is not shellcheck-clean and may break on paths with spaces.
