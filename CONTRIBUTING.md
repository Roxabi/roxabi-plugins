# Contributing

## Workflow

```
feature/fix branch → PR → main
git tag -a roxabi-plugins/vX.Y.Z → release.yml publishes the GitHub Release
```

1. Create a branch from `main`: `feat/plugins/new-skill`, `fix/plugins/edge-case`
2. Open a PR targeting `main`
3. Pass CI (`bun lint`, `bun typecheck`, `bun test`)
4. Merge

Merging cuts **no** release. A release exists because someone decided a state was
worth naming and pushed an annotated tag — rationale in the archived
[ADR-021](archived/docs/architecture/adr/021-release-is-an-explicit-act.md).
`CHANGELOG.md` is a byte-frozen archive (`scripts/__tests__/changelog-archive.test.ts`);
GitHub Releases are the record of shipped versions.

## Creating a new plugin

1. Create `plugins/<plugin-name>/skills/<skill-name>/SKILL.md` (frontmatter `name`,
   `description`, `version`) and `plugins/<plugin-name>/README.md`.
2. Register the plugin only in the catalog of each host it supports:
   `.claude-plugin/marketplace.json` (Claude Code) and/or `.omp-plugin/marketplace.json` (OMP).
   An OMP row's `version` matches `plugins/<plugin-name>/package.json#version`.
   Checkout-local tooling needs no catalog entry: `omp plugin link ./plugins/<plugin-name>`.
3. Add a row to the root `README.md` plugin table.
4. Validate: `python3 tools/validate_plugins.py`, then `bun run lint`, `bun run typecheck`, `bun run test`.
5. Commit as `feat(plugins): add <plugin-name> — short description`.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(plugins): add voice-me — TTS script authoring skill
fix(voice-me): handle nested code blocks
chore: bump biome to 2.0
docs(plugins): update voice-me README
```

- Scope: `plugins`, or a specific active plugin name (`issue-triage`, `omp-build`, `voice-me`)

## PR conventions

- Title = Conventional Commits format
- Link the issue: `Closes #N`
- One plugin or one logical change per PR
- CI must be green before merge
- A change to a plugin's distributed runtime (anything under `plugins/<p>/` except
  its root README, docs, tests and fixtures; GLOSSARY.md ships, because omp-build pins
  it as a review input) bumps every version the plugin
  carries, kept equal to its `package.json` version. For Claude Code, that is
  `.version` in `plugins/<p>/.claude-plugin/plugin.json` when it declares one,
  otherwise the version on the plugin's row in `.claude-plugin/marketplace.json`
  when it declares one; with neither, Claude Code tracks the commit SHA and an
  OMP-only plugin has no Claude version at all. For OMP, it is the plugin's row in
  `.omp-plugin/marketplace.json`. A local Claude row is named after its directory,
  with source `./plugins/<p>`, because the gate finds the row by name.
  `scripts/check-skill-version.sh` enforces the bump in the
  pre-push hook (against `origin/main`) and in the required `ci` check (against the
  PR's base, so a version that another PR already landed fails too).
- Merged with a **merge commit** — squash and rebase merges are disabled at the
  repository level, so the option is not offered. A squash rewrites every hash at
  the merge boundary, which phantom-conflicts the next merge.
- Your branch is **deleted automatically** when the PR merges. Nothing downstream
  reads it afterwards; delete the local copy and its worktree too.
- A merge needs two green checks on the PR's head commit, both required by the
  `PR_Main` ruleset: `ci` and `review`. The
  [Review Verdict](.github/workflows/review-verdict.yml) workflow posts `review`,
  as the roxabi-ci App, when an account with write access comments this line,
  naming the current head: `review-verdict v1 head=<40-hex sha> approve evidence=<https url>`.
  Only a PR into `main` gets it; a stacked PR is reviewed once it targets `main`.
  A new commit needs a new verdict. Updating the branch from `main` with a clean
  merge keeps it. Dependabot semver-minor and semver-patch updates get it without
  a verdict.
- Add the `reviewed` label to arm GitHub native auto-merge on the current head of
  a PR into `main`. The ruleset still requires both checks. A PR into another
  branch, or a head with a failed check (for example `trufflehog`), does not arm
  and loses the label. A head change disarms auto-merge and removes the label.
  There is no merge queue; label dependent PRs only once they are ready to land.

## Code style

```bash
bun run lint              # Biome lint — must pass
bun run typecheck         # TypeScript — must pass
bun run test              # Vitest — must pass
```

Vitest's integration project compiles the GitHub simulator server and standalone
executable into a run-owned temporary directory and removes them at teardown.
Integration test files use a dedicated simulator server through lightweight
`gh`, pin, and fix-recovery fault clients; the server path relies on Linux
`/proc`. The `gh` client runs the standalone executable instead for
comment-barrier calls, calls made while the state lock is held, and hosts
without `/proc`. A nested `gh` call issued from inside a server request fails
fast. Standalone Bun fixture runs continue to use the simulator source.
The pin client also falls back to its compiled standalone executable when
`/proc` is unavailable or a gate or synchronization call must wait. The
fault client's release-gate wait remains client-side; its standalone fallback
is a TypeScript script.

Vitest runs unit and integration files in separate, non-overlapping resource
groups. Integration uses at most one worker per four available CPUs (minimum
one) to limit subprocess and I/O contention. `--project integration` selects
the same integration files and keeps their 60-second per-test budget.

The allowance covers the full lifecycle workload; it is not a performance
optimization. Tests taking 30–60 seconds no longer trigger the previous
timeout alarm. Do not automatically raise the budget again; reassess a tighter
budget once the full workload demonstrably supports it.

CI plans eight integration shards from Vitest's file list, using cached
per-file durations only to balance them. The `checks` job runs unit tests and
the other checks alongside the shards (its steps are sequential); the required
`ci` job verifies that every listed file ran exactly once with at least one
passing test. Local `bun run test` still runs both complete projects.

The lefthook `pre-push` hook runs fast checks only: the unit project, `bun lint`,
`bun typecheck`, the secret scan, the principal-branch freeze, the comment
marker check and the plugin version gate. The integration project runs in the
required `ci` check, which the strict up-to-date rule makes run on the proposed
merge with current `main`. Run `bunx vitest run --project integration <file>`
locally when a change touches what an integration file exercises.

A shard selects its files through literal include globs, so integration test
paths may contain only ASCII letters and digits, `.`, `_`, `/` and `-`. CI
planning fails with an explicit error on any other character rather than risk
a glob that selects the wrong files.

Vitest workers run under Node. The shared setup isolates the SDK's Bun-only
logging and task-rendering dependencies, while fixture registry and event-bus
operations use the SDK implementations. Bun subprocess fixtures use the real
SDK without these Vitest mocks.

Style: single quotes, no semicolons. Markdown: ATX headings, tables for structured data.

## Project structure

```
plugins/
  <plugin-name>/
    README.md             — human-readable docs
    skills/<skill>/SKILL.md — skill definition (frontmatter + instructions)
    agents/               — (optional) agent definitions
    commands/             — (optional) slash commands
.claude-plugin/
  marketplace.json        — marketplace manifest
playbooks/                  — standalone procedures; not installed, not catalogued
  website-portfolio-audit.md
```

Source of truth is always this repo. Installed cache copies are ephemeral.
A file under `playbooks/` is an autonomous procedure. It is not a plugin, has no catalog entry, and is not installed.

## External marketplace curation

Active external marketplaces are direct upstream installs, not plugins vendored into this
repository. The registry is [`.claude-plugin/external-registry.json`](.claude-plugin/external-registry.json);
its active projection is [`.claude-plugin/curated-marketplaces.json`](.claude-plugin/curated-marketplaces.json).

For an active entry:

1. Compare `last_checked_commit` with the configured upstream branch.
2. Review the upstream change for installability, maintenance, content quality, and overlap with
   the retained plugins.
3. Update the registry record when the entry remains active, or set `status: deprecated` with a
   dated factual reason and remove it from the active mirror.
4. Keep the README's active external table aligned with the mirror by name and source.

The curation registry is not an install inventory. Upstream Watch monitors only entries with a
`watched_paths` declaration, for omp-build dependencies. To watch another skill, append its
upstream relative path to that entry's `watched_paths` list; paths are prefix-matched. A drift
issue identifies the changed watched paths and compare link, then asks the reviewer to review the
change and bump that entry's `last_checked_commit`.

Historical wrapping and subtree procedures are retained only in
[archived/docs/legacy-plugin-authoring.md](archived/docs/legacy-plugin-authoring.md); they are not
part of the current contributor path.
