# release-setup

Set up commit standards and release automation — Commitizen, commitlint, hook runner, semantic-release or Release Please.

## Why

Consistent commit messages are the foundation of automated changelogs and semantic versioning. `/release-setup` wires Commitizen (interactive commit UI), commitlint (enforce Conventional Commits on push), a hook runner (Lefthook or Husky), and your choice of release automation (semantic-release or Release Please) — all idempotently.

## Usage

```
/release-setup           Configure (skips already-configured components)
/release-setup --force   Re-run all components
```

Triggers: `"release setup"` | `"setup releases"` | `"commit standards"` | `"setup release automation"`

## Phases

**Phase 0 — Pre-check** — reads `stack.yml` for runtime, package manager, and hook runner. Checks which components are already configured (`.lefthook.yml`, `.husky/`, `.commitlintrc.cjs`, `release.config.cjs`, `release-please-config.json`).

**Phase 1 — Stack detection** — detects hook runner, branches (`main`, `staging`), and package manager.

**Phase 2 — Hook runner** — installs and configures Lefthook or Husky (prefers Lefthook if both detected). Adds pre-commit and commit-msg hooks.

**Phase 3 — Commit standards** — installs Commitizen + commitlint; writes `.commitlintrc.cjs` enforcing Conventional Commits. Python projects: sets up `pre-commit` framework instead.

**Phase 4 — Release automation** — choice of:
- **semantic-release** — `release.config.cjs` for automatic versioning from commit history
- **Release Please** — `release-please-config.json` + `.release-please-manifest.json` **and** the runner `.github/workflows/release-please.yml` (config alone is a no-op — config-without-workflow was a known gap in versions ≤ 0.1.0)

**Phase 4.5 — Quality Gates** *(Python only)* — triggers when `runtime == python` AND a `quality_gates:` section is present in `.claude/stack.yml`. Dispatches the [`quality-gates` cookbook](cookbooks/quality-gates.md), which:

- Copies canonical shell scripts from `plugins/dev-core/tools/` into the project's `tools/` directory.
- Seeds `tools/file_exemptions.txt` and `tools/folder_exemptions.txt` with header comments (creates the files if absent).
- Runs `uv add --group dev import-linter` if `import_layers` is enabled in the quality gates config.
- Writes a commented-out `.importlinter` scaffold if no `.importlinter` file exists.
- Merges three pre-commit hooks (`check-file-length`, `check-folder-size`, `import-layers`) into `.pre-commit-config.yaml` after the `id: typecheck` anchor.

**Idempotency:** without `--force`, existing entries are no-ops and emit drift warnings. `--force` re-stamps script contents and hook `entry:` paths, but never rewrites `.importlinter` or flips `stages:` (Decisions D1 / D4). Non-Python runtimes exit Phase 4.5 immediately with "Not applicable" status.

**Phase 5 — Summary** — lists all generated files and the suggested commit command. Does NOT auto-commit.

## Generated files

`.lefthook.yml` | `.commitlintrc.cjs` | `release.config.cjs` | `release-please-config.json` | `.release-please-manifest.json` | `.github/workflows/release-please.yml` | `tools/` scripts | `tools/file_exemptions.txt` | `tools/folder_exemptions.txt` | `.importlinter` (scaffold, Python + import_layers only)
