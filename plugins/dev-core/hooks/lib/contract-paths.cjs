'use strict'

/**
 * Host-neutral project contract paths — the single source of truth.
 *
 * `.dev/` is read identically by Claude, OMP, Grok and CI. `.claude/` holds
 * host state only (settings.json, worktrees/) and is NOT a contract: nothing
 * here falls back to it.
 *
 * Consumed by:
 *   - plugins/dev-core/hooks/format.cjs   (CJS require)
 *   - plugins/dev-core/omp/guards.ts      (createRequire)
 *   - plugins/dev-core/skills/**          (Bun TS import)
 *
 * Paths are POSIX-relative literals, not `path.join` results: skills use them
 * verbatim inside shell snippets. Callers anchor them with
 * `path.join(cwd, …)` when they need an absolute path.
 */

/** Contract directory, relative to the repo root. */
const CONTRACT_DIR = '.dev'

/** Stack conventions: paths, commands, formatter, test runner, release. */
const STACK_YML = `${CONTRACT_DIR}/stack.yml`

/** Reference template kept alongside the real stack for fresh clones. */
const STACK_YML_EXAMPLE = `${CONTRACT_DIR}/stack.yml.example`

/** dev-core plugin config: github_repo and other public (non-secret) IDs. */
const DEV_CORE_YML = `${CONTRACT_DIR}/dev-core.yml`

/** Any one present ⇒ the project declares a dev-core contract (guards ON). */
const PROJECT_CONTRACT_FILES = [STACK_YML, DEV_CORE_YML]

module.exports = {
  CONTRACT_DIR,
  STACK_YML,
  STACK_YML_EXAMPLE,
  DEV_CORE_YML,
  PROJECT_CONTRACT_FILES,
}
