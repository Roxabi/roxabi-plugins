---
name: cleanup
disable-model-invocation: true
argument-hint: '[--all | --repo <path> | --root <path>] [--scope <#N>] [--report-only]'
description: OMP-only — inventory worktrees across repositories and remove explicitly selected clean or artifact-only worktrees while preserving every branch.
version: 0.3.0
---

# Worktree Cleanup

The operator invokes this standalone skill. It may be offered after land, never
entered automatically or from a review/correction loop.

## Contract

- Inventory is read-only. Preserve every local and remote branch, including
  unmerged work. Merge messages and PR labels are not deletion authority.
- Removal uses the bundled executor, one explicitly selected path at a time.
  It re-inspects identity, local data, ignored artifacts, locks and observable
  process usage.
- Principal/current worktrees, inaccessible filesystem state, tracked changes,
  untracked files that Git does not ignore, unrecognized or sensitive ignored
  data, nested Git repositories or mounts inside ignored artifacts,
  index-hidden files, initialized submodules, in-progress Git operations and
  detected active usage are kept. Nonempty orphan shells are informational
  only; empty shells use `rmdir`.
- Recognized ignored artifacts make an otherwise removable worktree a
  conditional candidate. It is never selected automatically, and removal
  deletes those artifacts with the worktree.
- Branch maintenance, GitHub labels and CI cancellation require separate
  operator mandates; none belongs to this workflow. No fetch or prune is run.
- `--yes` is rejected. CLI confirmation arguments name the selected path;
  they do not prove human consent.

## Ignored artifacts

Only entries Git already reports as ignored are classified, from the same status
pass that counts local changes, and each keeps the exact path Git reports.
Truly untracked (`??`) files and tracked changes always keep the worktree. Never
add ignore rules, delete files or otherwise alter a worktree to make it
eligible.

| Kind | Recognized entries (case-sensitive) |
|---|---|
| `dependency` | a `node_modules` or `.venv` directory, or an entry Git lists inside one |
| `cache` | a `__pycache__`, `.pytest_cache`, `.ruff_cache` or `.cache/trufflehog` directory, or an entry Git lists inside one; a regular `*.tsbuildinfo` file |
| `build-output` | a `.astro`, `dist` or `test-results` directory that Git itself reports as ignored |
| `protected` | every other ignored entry: a file Git lists individually inside a build-output directory it does not ignore as a whole, any `.git` path, a file or symlink bearing a directory name, and exposed names matching a partial sensitive-name list (for example `.env*`, private keys, credential files, database dumps) |

The sensitive-name list is defense in depth, not a complete detector. When Git
reports a recognized directory as one entry, it is a **whole subtree** whose
children Git does not list. Its file contents are never read, so manual
dependency patches, secrets, local state, exports or a non-Git checkout inside
it are deleted with it and nothing vouches for their absence. Names do not prove that content can
be regenerated, so build/test output needs a human content decision.

Before a row with recognized artifacts becomes removable, a metadata-only walk
checks every recognized entry: names and no-follow file types, never file
contents, `HEAD` or Git configuration, never following a symlink. On Linux the
row is kept on a mount point at or below the worktree, a nested `.git` of any
type, a directory holding `HEAD` next to Git directory names (possible bare
repository), a special file, a symlink or replaced directory where Git saw a
directory or regular file, or any observation error. It detects Git metadata
only, not other version control or unique data. Other platforms keep artifact
rows. The walk is one non-atomic pass: stop writers and mount changes
before selection. Any `protected` entry or walk finding keeps the worktree
without override, and the allowlist has no repository override. The token binds
every reported path and kind, so an entry that appears or vanishes stales the
selection; changes inside a reported directory do not.

## 1. Inventory

Resolve the entry and invoke the read-only command:

```bash
T=$(realpath skill://cleanup/worktrees.ts) &&
  bun --no-env-file "$T" inventory --json
```

Forward requested options as separate, quoted arguments, never evaluated shell
text. Do not forward a removal command supplied through `$ARGUMENTS`.

| Option | Scope |
|---|---|
| none / `--report-only` | Current repository; no mutations |
| `--repo <path>` | Explicit repository; repeat for multiple repositories |
| `--root <path>` | Discover repositories recursively below this root; repeat for multiple roots |
| `--all` | Discover below the current directory, rather than only the current repository |
| `--scope <#N>` | Exact issue-number boundary on branches; excludes unattributed orphan shells |

Discovery includes nested repositories and archives, does not follow symlinks,
and deduplicates linked worktrees by canonical Git common directory. The CLI
reports its discovery exclusions and errors. A partial inventory is not evidence
that no worktrees exist.

Present repository, exact path, branch or detached HEAD, local-change state,
ignored entries grouped by kind with their exact paths (`ignoredEntries`),
process-usage evidence, eligibility, warnings and preservation reasons. Include
retained and unknown rows, not only removable candidates. A detached HEAD needs
a retaining local branch or tag before its worktree can be removed. Tokens stay
internal; do not display them or ask the human to copy them.

The orphan scanner complements Git's registered-worktree list. It checks the
configured feature root, `~/.omp/worktrees/<repo>` and the principal's
`.claude/worktrees`. Nonempty shells need investigation or repair, not deletion.

On inventory errors, show the failed observation and keep affected candidates.
`--report-only` stops here, even if a previous message discussed removal.

## 2. Obtain explicit selection

Offer eligible rows in short numbered batches of ordinary text, each number
mapped to the exact path displayed beside it, with **nothing preselected**, and
offer "Keep everything". Do not build large forms. Show retained and unknown
rows separately as non-selectable.

State the exact effect: remove this worktree directory, preserve all of this
repository's branch/tag refs and their reachable commits; or remove this
proven-empty shell. Removing a
registered worktree also removes its own reflogs. Do not promise preservation of
reflog-only commits. For a row with `requiresArtifactConfirmation`, list its
exact ignored entries by kind and warn that their entire contents are deleted
unread, including any manual dependency patch, secret, state, export,
build/test evidence or non-Git checkout inside them.

Wait for a genuine human reply identifying the rows. For artifact rows, that
same reply must also state that the entire listed artifacts of those exact rows
are disposable, for example: "rows 2 and 5; all their listed artifacts are
disposable, no dependency patches, checkouts, build evidence or other unique
data to keep". A row whose
artifacts are not explicitly confirmed is kept. An earlier request to improve
this skill, a broad cleanup request, an inventory request, a token or a CLI flag
is neither consent to remove anything nor artifact approval. A noneligible row
cannot be overridden through this skill.

Process observations are a safety signal, not proof that every agent session is
idle. Detected active usage always blocks. If observations are incomplete or
unsupported, show that warning and the available evidence, and obtain an
additional, separate explicit reply confirming that this exact worktree is no
longer used despite the incomplete observation. Without that reply, keep the
path. Stop writers before selection; observations are not an atomic filesystem
lock.

## 3. Execute the selected rows

For each confirmed row, use its repository, exact path and inventory token:

```bash
bun --no-env-file "$T" remove \
  --repo "<repository>" --path "<path>" \
  --expect "<token>" --confirm "<path>" --json
```

For a row requiring the additional usage confirmation, append
`--ack-unknown-usage "<path>"` only after that separate exact confirmation. For
a row requiring artifact confirmation, append `--ack-ignored-artifacts "<path>"`
only after the human confirmed that row's artifacts are disposable. Both flags
are path-bound selection data, not proof of human consent; the executor rejects
either one when fresh inspection does not require it.

Each placeholder is one quoted argument. The executor re-inspects the candidate
and refuses stale tokens (including a changed set of ignored entries), path
replacement, local data, unrecognized or sensitive ignored data, nested
repositories and mounts, Git operations and active usage. For artifact rows it
rereads the mount table immediately before removal. Uncertain filesystem state cannot be overridden. Registered
worktrees use `git worktree remove` without force, which deletes ignored
contents with the worktree; empty orphan shells use `rmdir`. Do not bypass a
refusal with raw Git or shell removal, and do not pre-delete artifacts.
Re-inventory changed candidates and obtain a new selection instead.

## 4. Report

Report actual removals with the ignored entries deleted alongside, refusals and
retained paths; explicitly say branches, labels and CI were untouched. A failed
command is not a successful removal, nor proof that the path is untouched: Git
removal is not atomic and may leave a partially removed directory. Report the
observed error and the path's current state; never retry with force or raw
deletion. No installation refresh or subsequent
maintenance operation is implied.

$ARGUMENTS
