---
name: cleanup
disable-model-invocation: true
argument-hint: '[--all | --repo <path> | --root <path>] [--scope <#N>] [--report-only]'
description: OMP-only — inventory worktrees across repositories and remove explicitly selected clean worktrees while preserving every branch.
version: 0.2.0
---

# Worktree Cleanup

The operator invokes this standalone skill. It may be offered after land, never
entered automatically or from a review/correction loop.

## Contract

- Inventory is read-only. Preserve every local and remote branch, including
  unmerged work. Merge messages and PR labels are not deletion authority.
- Removal uses the bundled executor, one explicitly selected path at a time.
  It re-inspects identity, local data, locks and observable process usage.
- Principal/current worktrees, inaccessible filesystem state, local data,
  in-progress Git operations and detected active usage are kept. Nonempty
  orphan shells are informational only; empty shells use `rmdir`.
- Branch maintenance, GitHub labels and CI cancellation require separate
  operator mandates; none belongs to this workflow. No fetch or prune is run.
- `--yes` is rejected. CLI confirmation arguments name the selected path;
  they do not prove human consent.

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
process-usage evidence, eligibility, warnings and preservation reasons. Include
retained and unknown rows, not only removable candidates. A detached HEAD needs
a retaining local branch or tag before its worktree can be removed.

The orphan scanner complements Git's registered-worktree list. It checks the
configured feature root, `~/.omp/worktrees/<repo>` and the principal's
`.claude/worktrees`. Nonempty shells need investigation or repair, not deletion.

On inventory errors, show the failed observation and keep affected candidates.
`--report-only` stops here, even if a previous message discussed removal.

## 2. Obtain explicit selection

Show only eligible rows as selectable, with **nothing preselected**, and offer
"Keep everything". State the exact effect: remove this worktree directory,
preserve all branch/tag refs and their reachable commits; or remove this
proven-empty shell. Removing a registered worktree also removes its own reflogs.
Do not promise preservation of reflog-only commits.

Wait for a genuine human reply identifying the paths. An earlier request to
improve this skill, an inventory request, a token or a CLI flag is not consent to
remove anything. A noneligible row cannot be overridden through this skill.

Process observations are a safety signal, not proof that every agent session is
idle. Detected active usage always blocks. If observations are incomplete or
unsupported, show that warning and the available evidence, and obtain an
additional explicit reply confirming that this exact worktree is no longer used
despite the incomplete observation. Without that reply, keep the path. Stop
writers before selection; observations are not an atomic filesystem lock.

## 3. Execute the selected rows

For each confirmed row, use its repository, exact path and inventory token:

```bash
bun --no-env-file "$T" remove \
  --repo "<repository>" --path "<path>" \
  --expect "<token>" --confirm "<path>" --json
```

For a row requiring the additional usage confirmation, append
`--ack-unknown-usage "<path>"` only after that exact confirmation. The flag is
path-bound selection data, not proof of human consent.

Each placeholder is one quoted argument. The executor re-inspects the candidate
and refuses stale tokens, path replacement, local data, Git operations and active
usage. Uncertain filesystem state cannot be overridden. Registered worktrees use
`git worktree remove` without force; empty orphan shells use `rmdir`. Do not
bypass a refusal with raw Git or shell removal. Re-inventory changed candidates
and obtain a new selection instead.

## 4. Report

Report actual removals, refusals and retained paths; explicitly say branches,
labels and CI were untouched. A failed command is not a successful removal.
No installation refresh or subsequent maintenance operation is implied.

$ARGUMENTS
