# Contributing

## Workflow

```
feature/fix branch → PR → main
git tag -a roxabi-plugins/vX.Y.Z → release.yml publishes the GitHub Release
```

1. Create a branch from `main`: `feat/plugins/new-skill`, `fix/plugins/edge-case`
2. Open a PR targeting `main`
3. Pass CI (`bun run lint`, `bun run typecheck`, `bun run test`)
4. Merge

Merging cuts **no** release. A release exists because someone decided a state was
worth naming and pushed an annotated tag — see
[ADR-021](docs/architecture/adr/021-release-is-an-explicit-act.md).

## Creating a new plugin

Follow [docs/CREATE-PLUGIN-GUIDE.md](docs/CREATE-PLUGIN-GUIDE.md) — marketplace vs link-only, SKILL.md, catalogs, README row, validate, and commit format.

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

Style: single quotes, no semicolons. Markdown: ATX headings, tables for structured data.

## Local Phase 4 model qualification

```bash
bun run test:phase4-model
```

This explicit, local-only profile requires an authenticated native `omp` on
`PATH` and POSIX process-group cleanup. It calls the installed CLI through
`node:child_process`, not an SDK or a copied implementation of the review
programme. The command sets `ROXABI_PHASE4_MODEL=1`; without that exact effective
per-call value, the runner refuses before executable discovery or `--version`.
Ordinary `bun run test` and `bun run test:watch` keep their existing tests and
include the pure oracle and stub transport regressions, but exclude the
`*.model.integration.test.ts` profile.

| Surface | Contract |
|---|---|
| Programme | Four complete `dev-review` sources are read from the candidate `HEAD` blobs: `SKILL.md`, `root-causes.md`, `review-smells.md`, and `review-classes.yml`. |
| Provenance | The test annotation records commit/blob identities, loaded/sent SHA-256 values, fixture/input/delivered-input/config hashes, executable path/realpath/version, and stream-observed provider/model. `atCommit` checks the actual Git blobs, not caller-supplied identities alone. |
| Settings | `openai-codex` / `gpt-6.1-sol`; `requestedThinking: low` is a request, not a claim that effective thinking was observed. |
| Bounds | A 30-second integration-test budget, a maximum 25-second invocation deadline and a maximum 2-second version probe; no retry, voting, timeout increase, or skipped-as-green fallback. Owned temporary files and process groups are cleaned up under the supported normal-path bounds. |
| Stream | One complete delivered user turn and terminal assistant response are required; observed tool/retry/fallback/model-change/failure events and incompatible terminal flags fail the run. |

The baseline contains two independent captured panel findings: a publication
guard defect and a local status-formatting observation with no supplied safety
caller. Expected final labels, groups and verdict stay in the host assertions,
outside model input. Both native and ordinary tests call the same pure
`qualifyPhase4Baseline(body): void` seam. It checks complete finding membership,
identities, citations, emitters, provenance/raw-callsite associations, and whole
typed JSON cause/witness tuples. Duplicate fields or decoded metadata keys,
cross-finding substitutions, polarity changes, missing facts and trailing
carrier data are rejected. A mandatory value ends at a peer-level field header;
deeper space/tab-indented continuations remain part of that value and must parse
in full. The factual carriers are certified; unrestricted prose outside them is
not.
Complete values may start below their field label; harmless line wrapping does
not change their facts or associations.
Only review structure outside code examples and HTML comments supplies finding
membership and field identities. The offset-preserving projection respects
code/comment precedence and escaped comment openers, including multiline and
mixed-line comments; literal examples cannot hide or invent findings. Supported
JSON field wrappers keep their original value bytes, and the first-line review
marker is still checked against the original body.

The original rendered body then reaches the unchanged `reviewRecords` consumer,
which reads its declared `Request changes`. This proves neither verdict
recomputation nor landing eligibility. The six additional cases and
actual-source mutation controls belong to #736, not this prerequisite baseline.
The accepted native MCP/ambient-configuration limits tracked in #858 and #859
remain limits, not isolation guarantees supplied by this profile.
These are not sandbox/resource caps or universal interruption/reaping
guarantees. Slow hosts, authentication and model latency can fail the fixed
budgets. Optional native-envelope flags are checked when present; their absence
does not certify them.

Use the Vitest commands above, not bare `bun test`. For an alternate-runner
reachability check, isolate credentials and substitute a logging fake `omp`.
If the operator shell intercepts that command, report bare-Bun reachability as
unobserved; never bypass the interceptor. The ordinary no-opt-in transport
regression separately asserts that the fake receives zero calls, including
`--version`.

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

## Upstream sync

Wrapped plugins and curated marketplaces drift over time. Run this process periodically (or when CI opens an `upstream-update` issue).

### 1. Check curated marketplaces for drift

For each entry in `external-registry.json` → `curated_marketplaces`:

```bash
# Compare stored SHA against upstream HEAD
git ls-remote <source>.git refs/heads/<branch> | awk '{print $1}'
```

If the SHA differs from `last_checked_commit`:
- Fetch the changelog: `gh api repos/<owner>/<repo>/compare/<old_sha>...<branch>`
- Review commits for breaking changes (renamed skills, removed files, new dependencies)
- Update `last_checked_commit` in `external-registry.json`

### 2. Check wrapped plugins for content changes

For each entry in `wrapped_plugins`:

```bash
# Clone upstream shallow
git clone --depth 1 <upstream_url> /tmp/<name>-upstream

# Diff file trees (our references/ layout vs upstream flat layout)
diff <(cd /tmp/<name>-upstream/<path> && find . -type f | sort) \
     <(cd plugins/<name>/skills/<skill>/references && find . -type f | sort)

# Diff content of matching files
diff /tmp/<name>-upstream/<path>/rules/<file>.md \
     plugins/<name>/skills/<skill>/references/rules/<file>.md
```

- **New files upstream** → copy into `references/`
- **Changed content** → review and merge (our frontmatter is intentionally different — skip those diffs)
- Update `last_sync_commit` and `last_sync_date` in `external-registry.json`

### 3. Check if wrapped plugins should be promoted

For each wrapped plugin, check if upstream now ships a proper marketplace:

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/contents/.claude-plugin" | jq '.[].name'
```

If upstream has `.claude-plugin/marketplace.json` with versioned plugins → **promote to curated**:

1. `git rm -r plugins/<name>/`
2. Remove from `.claude-plugin/marketplace.json`
3. Add to `curated_marketplaces` in `external-registry.json`
4. Add to `.claude-plugin/curated-marketplaces.json`
5. Move to endorsed marketplaces table in `README.md`

### 4. Consistency check

Verify all registry files agree:

- `external-registry.json` curated names == `curated-marketplaces.json` marketplace names
- All `marketplace.json` sources point to existing directories on disk
- No orphan directories in `plugins/` missing from `marketplace.json`
- All endorsed marketplaces listed in `README.md`

### 5. Commit and push

One commit per logical change, conventional commit format. Examples:

```
chore(plugins): sync upstream — 6 new react rules + register wrapped plugins
refactor(plugins): promote visual-explainer to curated marketplace
fix(registry): add missing entry to curated-marketplaces
```
