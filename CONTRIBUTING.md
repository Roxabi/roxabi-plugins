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

## Local Phase 4 model profile

```bash
bun run test scripts/__tests__/phase4-baseline.test.ts scripts/__tests__/phase4-runner.integration.test.ts
bun run test:phase4-model
```

The first command is ordinary, model-free verification. Normal `bun run test`
and `bun run test:watch` retain the ordinary unit/integration projects and exclude
only `*.model.integration.test.*` cases. The second command explicitly opts into
one installed OMP invocation; it can use local authentication and incur provider
cost. It is not part of CI. The runner refuses without the opt-in before resolving
OMP on PATH or probing its version, and refuses non-POSIX platforms.

The private runner reads the four complete, unchanged dev-review programme files
from the actual Git revision: `SKILL.md`, `root-causes.md`, `review-smells.md`
and `review-classes.yml`. It sends those sources with the frozen supplied-code
fixture through OMP's native CLI, not an SDK or classifier clone. Expected
findings, groups and verdict are assertions outside the model input. The bounded
profile requests `openai-codex/gpt-6.1-sol`, `thinking low`, one turn, no tools,
LSP, extensions, skills, rules, session or title. Limits are 25 seconds for the
invocation, 2 seconds for the version probe and 30 seconds for integration tests.
Requested thinking is not proof of the effective thinking setting.

`phase4-baseline.ts` qualifies a closed presentation grammar, not arbitrary
Markdown or prose semantics:

- One first-line review marker; ATX Findings section; one Blockers and one
  Warnings group, either order. Finding headers are plain or column-zero `-`/`*`
  items, with two-space fields.
- Complete typed JSON factual tuples, inline, pretty, below their active header
  or in exact empty/`json` triple-backtick wrappers. Four-space data is eligible
  only under an active field; otherwise indented examples are literal.
  Duplicate-aware Flow metadata preserves decoded keys, numeric types, exact
  citation/emitter associations and callsite multiplicity.
- Source-positioned active, literal, comment, data and inline-code interpretations
  supply the records and their complete raw values. Only eligible peer fields or
  record/group/section boundaries terminate a value; a decoder cannot select a
  valid island and discard its suffix.
- Closed fences/comments and escaped comment openers are literal contexts.
  Blank lines, headings, new list items and supported block openers delimit
  paragraphs before inline delimiters are paired; unmatched backticks are literal.
  Historical multiline inline code whose continuation opens an HTML comment is
  explicitly unsupported, not silently reclassified as a finding.
- Active tabs, raw HTML, complex containers and decorated structural identities
  fail visibly with source locations. These restrictions are contextual: literal
  examples and owned factual data are not subjected to a global denylist.

The qualified **original body** goes unchanged to `workflow.reviewRecords`; the
test observes its declared `Request changes`. That consumer does not prove the
finding set, and this profile does not recompute a verdict or authorize landing.

The model test annotates provenance and the exact returned body **before**
qualification. For a lossless local receipt, add the built-in blob reporter to
the same invocation, for example
`bun run test:phase4-model --reporter=blob --outputFile=/absolute/path/phase4.blob`.
The blob retains annotations even when qualification fails; a JSON reporter is
not a substitute. Provenance includes Git revision/blob identities, loaded/sent
source hashes, input/delivered-input/fixture/configuration hashes, runtime,
provider/model and the requested-versus-observed settings.

For #865, restore the real source between the independent literal-eligibility and
paragraph-confinement falsifications, finish the restored ordinary corpus, then
run the unchanged explicit native profile **once** at the candidate revision.
Preserve a failure, timeout, unsupported presentation or malformed result; do
not coach the prompt, retry, vote or select a later success.

This is bounded evidence, not a hermetic sandbox, generic Markdown support,
ambient-MCP isolation, resource/interruption or slow-host hardening. The #858,
#859 and #864 exclusions, procfs reachability and bare-Bun alternate-runner
reachability remain unproved. It does not deliver #736's six classifier cases.


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
