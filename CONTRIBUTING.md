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
- Merged with a **merge commit** — squash and rebase merges are disabled at the
  repository level, so the option is not offered. A squash rewrites every hash at
  the merge boundary, which phantom-conflicts the next merge.
- Your branch is **deleted automatically** when the PR merges. Nothing downstream
  reads it afterwards; delete the local copy and its worktree too.
- Add the `reviewed` label to enable auto-merge. There is no merge queue, so if
  several PRs must land in a given order, add the label in that order.

## Code style

```bash
bun run lint              # Biome lint — must pass
bun run typecheck         # TypeScript — must pass
bun run test              # Vitest — must pass
```

Vitest's integration project compiles the GitHub simulator once into a
run-owned temporary directory and removes it at teardown. Sandbox fixtures use
that executable through an integration-only environment variable; standalone
Bun fixture runs continue to use the simulator source.

Vitest runs unit and integration files in separate, non-overlapping resource
groups. Integration uses at most one worker per four available CPUs (minimum
one) to limit subprocess and I/O contention. `--project integration` selects
the same integration files and keeps their 30-second per-test budget.

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
```

Source of truth is always this repo. Installed cache copies are ephemeral.

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
