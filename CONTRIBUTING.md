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

## Local Phase 4 model baseline

After `bun install`, run the explicit, paid/model-authenticated profile:

```bash
bun run test:phase4-model
```

- **Prerequisites:** Bun with `Bun.YAML`, the normal Node/Vitest environment,
  and an installed native `omp` CLI authenticated for `openai-codex/gpt-6.1-sol`.
  The executor fixes that model and `low` thinking; it does not provision credentials.
  Only POSIX process-group hosts are supported; native Windows is refused before
  starting OMP or allocating its temporary inputs. Cleanup is exercised on Linux.
- **Selection:** only `*.model.integration.test.*` runs in `phase4-model`.
  These new cases are excluded from ordinary `bun run test` and `bun run test:watch`;
  all pre-existing cases stay selected. The separate
  `scripts/__tests__/phase4-runner.integration.test.ts` uses real stub processes
  to check transport failures and cleanup, not to qualify model behaviour.
- **Source and records:** `scripts/phase4-model.ts` loads committed `HEAD` blobs for
  the actual dev-review `SKILL.md`, `root-causes.md`, `review-smells.md` and
  `review-classes.yml`. Uncommitted programme edits are not silently tested.
  The verbose result's `phase4-model-provenance` annotation records their paths,
  commit/blob identities, loaded/sent SHA-256 values, fixture/input/config hashes,
  runtime path/version, model and limits. `atCommit` is checked against the actual
  candidate Git commit/blob bytes, not caller-provided hashes. Altered text or
  identities are marked false; an invalid candidate commit fails visibly.
  Expected labels, membership, provenance/evidence associations and verdict
  assertions remain outside the model input. A shared test-owned baseline oracle
  checks parsed provenance and raw callsites, plus each finding's distinct causal
  witness in its own `Root cause` and `Symptoms/evidence` fields. Ordinary integration
  regressions reject missing or cross-associated details that retain the old
  identity/keyword projection; the real native baseline uses that same oracle.
  It is a fixture-specific contract, not a general natural-language truth evaluator.
  The unchanged rendered body reaches the existing pure `workflow.reviewRecords`
  consumer.
- **Bounds and failures:** the shared integration budget stays 30 seconds/test,
  with a native call bounded to 25 seconds, a version probe bounded to 2 seconds,
  and bounded cleanup of owned process groups and temporary inputs. There are no
  harness retries, votes or model fallbacks. The invocation requests no tools,
  LSP, extensions, skills, rules or session persistence, from an owned temporary
  working directory; observed tool/retry/fallback events are rejected. It still
  uses the operator's native runtime/authentication: this is not a hermetic sandbox.
  Missing runtime/auth, provider/deadline/stream errors and failed assertions fail
  visibly rather than becoming skipped-green results.
- **Limits:** this nondeterministic local baseline preserves two independent
  non-recall panel findings and observes `Request changes`; it does not prove live
  repository discovery, landing safety or the six later #736 scenarios/source
  controls. Current CI runs the ordinary suite, **not** the model profile. No CI
  model credentials or model-assertion enforcement are added here.

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
