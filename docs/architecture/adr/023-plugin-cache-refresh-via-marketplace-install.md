---
title: "ADR-023: Plugin Cache Refresh via Marketplace Install"
description: Records the retirement of sync-plugins.sh — the rsync-and-rollback local propagation script — in favour of `claude plugin install <name>` from the marketplace as the single mechanism that refreshes an installed plugin, and the consequences for skills that assumed atomic multi-file propagation.
status: accepted
normative: true
date: 2026-05-22
---

> This ADR was written on 2026-09-23 to record a decision taken on 2026-05-22.
> It is the successor [ADR-010](010-dev-core-pipeline-chain-contract.mdx) has
> named since the day it was superseded, and which nobody had written: the
> retirement was stated as fact in `AGENTS.md`, in `docs/plugin-cache.md`, and
> in ADR-010's own supersession banner, while the decision record that all three
> point at did not exist. See § Decision, last paragraph, for why that gap was
> closed by writing this rather than by editing ADR-010.

## Context

`plugins/<name>/` in this repository is the source of truth for every plugin.
The copy that actually executes lives in a hash-keyed cache directory,
`~/.claude/plugins/cache/roxabi-marketplace/<plugin-name>/<hash>/`, one hash per
consuming project. Editing the source never touches the cache.

`sync-plugins.sh` was the local answer to that gap: an rsync-style script that
copied the working tree into every cache directory it could find, hardened in
[ADR-010](010-dev-core-pipeline-chain-contract.mdx) with rollback-on-failure so
that a partial copy could not leave a project running half of one revision and
half of another. ADR-010 leaned on it explicitly — its "Cache fan-out" drawback
is the observation that a 13-file edit to the pipeline skills is only safe if
the 13 files land together.

Two things made that mechanism untenable:

- **It propagated uncommitted state.** The script copied the working tree, so
  the running plugin could be a revision that exists on exactly one machine and
  in no commit. Every report against it was unreproducible by construction.
- **It had to guess the cache layout.** The hash is assigned by the host, per
  project. The script enumerated cache directories and wrote into the ones it
  recognised; a layout change upstream turned a successful-looking run into a
  silent no-op against the directory that mattered.

The marketplace install path (`claude plugin install <name>`) has neither
property: it resolves the plugin from the published marketplace clone, at a
commit, and the host — which owns the hash — decides where it lands.

## Options Considered

### Option A: Keep `sync-plugins.sh` as the local fast path

- **Pros:** No commit/push round-trip between editing a skill and running it.
  Multi-file edits land atomically, which is exactly what ADR-010's chain
  contract wanted.
- **Cons:** Keeps a second writer to the cache, with a different source (working
  tree vs. commit) and a hand-maintained model of a layout the host owns. The
  atomicity is real but local: it guarantees one machine's cache is coherent,
  not that anyone else can reproduce what it is running.

### Option B: `claude plugin install` as the only refresh mechanism

- **Pros:** One writer, one source, and that source is a commit. What runs is
  what is pushed, so a bug report names a revision. No model of the cache
  layout to keep in step with the host.
- **Cons:** Costs a commit + push before a change can be exercised. Loses the
  multi-file atomicity guarantee ADR-010 relied on: an install is per plugin,
  and a chain edit spanning `dev-core` and another plugin is two installs.

### Option C: Vendor the cache path into the repo and symlink

- **Pros:** Edits are live with no propagation step at all.
- **Cons:** Makes the executing copy a symlink into a git worktree, so a branch
  switch silently changes what every project is running. Trades a propagation
  problem for an isolation problem, and the isolation problem is worse.

## Decision

**Option B.** `claude plugin install <plugin-name>` is the only supported way to
refresh an installed plugin. `sync-plugins.sh` is removed, not deprecated —
leaving it in the tree would leave a second writer to the cache with no owner.

The workflow is therefore: edit repo source → commit + push → re-install. This
is recorded in `AGENTS.md` § Editing Plugins and in
[`docs/plugin-cache.md`](../../plugin-cache.md).

ADR-010's chain contract — distributed declaration plus `/dev`-owns-lifecycle —
is **unaffected as a decision**. What lapses is its "Cache fan-out" consequence,
which is worded in terms of a script that no longer exists. ADR-010 is
`superseded` by this ADR rather than amended in place, because the mechanism its
consequences reason about is gone and a reader needs to land here to find out
what replaced it.

**On the gap this ADR closes.** For four months the corpus recorded the
retirement three times in prose and zero times as a decision, and ADR-010 sat
`status: superseded` with a `superseded_by` nobody could fill. The contract
introduced in #408 turns that into a hard gate failure — *"status `superseded`
with no readable replacement"* — and the failure is correct: it is the corpus
saying a decision was taken and never written down. The only sound response is
to write it. Downgrading ADR-010 to `accepted` or `deprecated` would have
silenced the gate by falsifying the record it was describing, which is the one
move a decision log must never make.

## Consequences

### Positive

- The running copy of a plugin is always a pushed commit. "Works on my machine"
  stops being reachable through the propagation path.
- One writer to the cache. Nothing in this repository needs a model of the
  host's hash-keyed layout, so a layout change upstream cannot silently
  no-op a refresh.
- ADR-010 now names a successor, so the trail from the chain contract to the
  mechanism that carries it is navigable in one hop.

### Negative

- **Slower inner loop.** Exercising a skill change costs a commit, a push and an
  install. This is the price of the reproducibility above and is not mitigated.
- **No cross-plugin atomicity.** A change spanning two plugins is two installs,
  and there is a window where a project runs the new half of one and the old
  half of the other. ADR-010's fan-out concern survives in this narrower form.
- Contributors who had `sync-plugins.sh` in muscle memory get a missing-command
  error rather than a pointer; `AGENTS.md` § Gotchas carries the redirect
  (`¬rsync`).

### Neutral

- Cache directories for old hashes still accumulate; nothing here reaps them.
- `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` resolution is unchanged — this
  decision is about how bytes reach the cache, not how a skill addresses them.

## Related

- [ADR-010](010-dev-core-pipeline-chain-contract.mdx) — superseded by this ADR;
  its chain contract stands, its cache-fan-out consequence does not.
- [`docs/plugin-cache.md`](../../plugin-cache.md) — the operational reference.
- `AGENTS.md` § Editing Plugins (invariants), § Gotchas.
