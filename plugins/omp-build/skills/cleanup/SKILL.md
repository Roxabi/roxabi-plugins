---
name: cleanup
disable-model-invocation: true
argument-hint: '[--all | --repo <path> | --root <path>] [--scope <#N>] [--report-only] [--force]'
description: OMP-only — inventory worktrees and remove explicitly selected paths, with an opt-in manual local-data discard mode, while preserving every branch.
version: 0.4.0
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
- Principal/current worktrees, inaccessible filesystem state, nested Git
  repositories, mounts, index-hidden files, initialized submodules or retained
  `modules/` data in the worktree Git directory, locks,
  in-progress Git operations and detected active usage are always kept.
  Nonempty orphan shells are informational only; empty shells use `rmdir`.
- Safe mode also keeps tracked changes, genuinely untracked files and
  unrecognized or sensitive ignored data. Only the explicit manual force mode
  below can make those local data disposable.
- Recognized ignored artifacts make an otherwise removable worktree a
  conditional candidate. It is never selected automatically, and removal
  deletes those artifacts with the worktree.
- Branch maintenance, GitHub labels and CI cancellation require separate
  operator mandates; none belongs to this workflow. No fetch or prune is run.
- `--yes` is rejected. CLI confirmation arguments name the selected path;
  they do not prove human consent.

## Ignored artifacts

In safe mode, only entries Git already reports as ignored are classified, from
the same status pass that counts local changes, and each keeps the exact path
Git reports. Truly untracked (`??`) files and tracked changes keep the worktree.
Never add ignore rules, delete files or otherwise alter a worktree to make it
eligible; manual force uses the executor directly, not pre-deletion.

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
before selection. In safe mode, any `protected` entry or walk finding keeps the
worktree, and the allowlist has no repository override. The safe token binds
every reported path and kind, so an entry that appears or vanishes stales the
selection; changes inside a reported directory do not.

## Manual force mode

Enter this mode only when the operator explicitly asks to abandon local data.
`inventory --force` is read-only: it assesses registered or detached worktrees
under that mode and does not select or remove anything. Safe and force tokens
are not interchangeable. Force does not make orphan shells removable.

Force may discard tracked/staged edits, genuinely untracked files and all
ignored data, including sensitive or unrecognized entries such as `.semctx`,
`.cocoindex_code` or `.deps`. A Git ignore rule is not proof of disposability.
Present the exact `localEntries` (status, path and any original rename path),
the exact `ignoredEntries`, and the warning that all their contents are lost.
The human must select the exact paths and explicitly approve abandoning all
these local data. Creating or improving this mode is not that approval.

Before a force candidate becomes eligible, a Linux metadata-only, no-follow
walk covers the entire worktree, not just recognized ignored artifacts. It
keeps nested Git repositories, probable bare repositories, mounts, special
files, replaced paths and observation errors. All other hard guards from the
contract remain blocking; an unretained detached HEAD needs a separate branch
maintenance decision, not a force override.
The force guard also checks the linked worktree's administrative `modules/`
entry, even when no submodule gitlink or checkout remains. Any such entry or
observation error keeps the worktree; its retained repositories are not local
files covered by discard approval.

Force tokens additionally bind the exact Git status, index state and a
deterministic metadata fingerprint of the worktree, including changes inside
ignored directories. File payloads are not read. A changed target, mode, status,
index or observed file state requires a fresh inventory and selection; changed
data to abandon requires renewed human approval. This is not an atomic lock or
a content-integrity proof: stop writers and mount changes before selection.

Git status disables fsmonitor and untracked-cache shortcuts for a fresh data
list. Force also rechecks observable process usage after the tree walk and
before mutation. Active usage still blocks; unknown usage still requires its
separate confirmation.

For each selected force row requiring `requiresDiscardConfirmation`, the
executor also requires `--ack-discard-local-data "<path>"`. This path-bound
acknowledgement covers both ignored and nonignored data; do not also pass
`--ack-ignored-artifacts` in force mode. Incomplete usage observations still
require their separate human reply and `--ack-unknown-usage`.

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
| `--force` | Read-only manual-discard assessment; all structural and active-usage guards remain blocking |

Discovery includes nested repositories and archives, does not follow symlinks,
and deduplicates linked worktrees by canonical Git common directory. The CLI
reports its discovery exclusions and errors. A partial inventory is not evidence
that no worktrees exist.

Present repository, exact path, branch or detached HEAD, local-change state,
ignored entries grouped by kind with their exact paths (`ignoredEntries`),
process-usage evidence, eligibility, warnings and preservation reasons. Include
`removalMode`, `localEntries` and `requiresDiscardConfirmation` in manual mode.
Include retained and unknown rows, not only removable candidates. A detached
HEAD needs a retaining local branch or tag before its worktree can be removed.
Tokens stay internal; do not display them or ask the human to copy them.

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
cannot be overridden. Manual force requires its own fresh force inventory and
the additional local-data approval described above, not reuse of a safe row.

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

For a manually selected force row, use the token from `inventory --force`:

```bash
bun --no-env-file "$T" remove --force \
  --repo "<repository>" --path "<path>" \
  --expect "<force-token>" --confirm "<path>" \
  --ack-discard-local-data "<path>" --json
```

Only include `--ack-discard-local-data` when fresh inspection requires it; the
executor rejects a missing, mismatched or unnecessary acknowledgement. Include
the usage acknowledgement separately when required. No CLI flag proves that
the human actually approved the loss.

Each placeholder is one quoted argument. The executor re-inspects the candidate
and refuses stale tokens, path replacement, structural findings, Git operations
and active usage. Safe mode also refuses non-allowlisted local data. Before
force or artifact removal it rereads the mount table. Uncertain filesystem state
cannot be overridden. Safe registered worktrees use ordinary `git worktree
remove`; explicitly confirmed force rows use exactly one `--force` on that same
command. Both remove the directory's contents and preserve branch/tag refs.
Empty orphan shells use `rmdir` only. No raw Git/shell fallback, pre-deletion,
second `--force` or automatic escalation after a refusal. Re-inventory changed
candidates and obtain a new selection instead.

## 4. Report

Report actual removals with the mode and local data discarded alongside,
refusals and retained paths; explicitly say branches, labels and CI were
untouched. A failed command is not a successful removal, nor proof that the path
is untouched: Git removal is not atomic and may leave a partially removed
directory. Report the observed error and current state; never escalate or retry
with additional force or raw deletion. No installation refresh or subsequent
maintenance operation is implied.

$ARGUMENTS
