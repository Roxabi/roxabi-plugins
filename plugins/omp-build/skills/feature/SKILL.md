---
name: feature
disable-model-invocation: true
argument-hint: '[#N | <subject>]'
description: OMP-only — one feature. From the Principal it hops into ω; in ω with no ticket it frames (grill → spec → tickets) and stops at the frontier.
version: 0.1.0
---

# Feature

One feature, one worktree. This body covers **entry** and **mode 1 (framing)**.
Mode 2 — implement → review → fix → land — is `#494`; it is named here as the next
step and specified nowhere in this file.

Bundled seam: `skill://feature/entry.js`. The skill directory is printed at the end
of this body; import from there.

## 1. Preflight — the capabilities §4 actually calls

§4 invokes four skills by name. Three come from an external plugin, one from this
repo, and **nothing makes them arrive together**. Check all four first:

| Capability | Called at | Source |
|---|---|---|
| `grill-with-docs` | §4.1 | Matt Pocock's skills plugin |
| `to-spec` | §4.3 | idem |
| `to-tickets` | §4.4 | idem |
| `issue-triage:issue-triage` | §4, every issue write | the `issue-triage` plugin |

**Any one of the four unavailable → stop, name the missing ones, and say
`/setup-matt-pocock-skills` (or install `issue-triage`). Never fall back** — not to
a hand-written spec, not to `gh issue create`. The fallback *is* the failure mode:
a batch published without `issue-triage` carries no `size:`, no `--parent` and no
edges, so the review tier silently downgrades and the frontier query reads empty.

Do not grill. Do not create a worktree. Do not publish anything.

Then, as a **separate** stop — the two conditions are independent, and this repo is
the proof (2026-09-23: the tracker contract is present, and all three Matt skills
are absent):

**Read `docs/agents/issue-tracker.md` from the repo root. Absent → stop** and print:

> Tracker contract missing: `docs/agents/issue-tracker.md`. It is the contract §4
> and §5 obey — label vocabulary, relation shape, tier. Restore it, then re-run
> `/feature`.

Present → keep it in context.

## 2. Where am I?

```javascript
const { isPrincipal, resolveEntry } = await import(`${SKILL_DIR}/entry.js`)  // SKILL_DIR = the printed skill directory
const { ensureWorktree, resolveNames } = await import(`${SKILL_DIR}/../build/workflow.js`)
```

The location question is answered **with no branch in hand** — on the Principal the
branch this invocation is about is the one §3 has not created yet, and HEAD there
is a base branch:

| Input | Where it comes from |
|---|---|
| `cwd` | the session cwd, absolute and symlink-resolved — `pwd -P` |
| `principalPath` | first entry of `git worktree list --porcelain` |

`isPrincipal(cwd, principalPath)` throws on anything it cannot compare as a string
(relative, `.`, `..`, `\`): it touches no filesystem, so an unresolved spelling of
the Principal would read as "not the Principal" — and framing on the Principal is
exactly what this skill exists to prevent.

- **true** → §3. `resolveEntry` is not called yet; there is nothing to call it with.
- **false** → gather the two remaining facts and call it once:

| Input | Where it comes from |
|---|---|
| `branch` | `git -C <cwd> rev-parse --abbrev-ref HEAD`, or `null` when detached |
| `ticket` | `#N` in `$ARGUMENTS`, else nothing |

```javascript
const entry = resolveEntry({ cwd, principalPath, branch, ticket })
```

| `action` | What it means | Go to |
|---|---|---|
| `frame` | no ticket | §4 |
| `build` | the branch carries the ticket | mode 2 — `#494`. Until it lands, stop and say so |
| `refuse` | the branch carries `branchTicket` (or nothing), not `ticket` | stop: « ce ω porte `<branch>`, pas #`<ticket>` » — go back to the Principal and run `/feature #<ticket>` |

`refuse` is not pedantry: implementing #N inside #M's worktree puts #N's commits on
#M's branch and into #M's PR, and nothing downstream notices.

## 3. Hop — never implement on the Principal

On the Principal, `/feature` prepares ω and leaves. In order:

1. **Name the branch**: `resolveNames({ cwd, type, slug, issue })` →
   `<type>/<N>-<slug>`, plus the ω path and `principalPath`.

   `resolveNames` refuses without an issue (`workflow.js` — "mint first"), and that
   policy has no bypass here: hand-building `names = { branch: 'feat/<slug>' }`
   skips it, and `ensureWorktree` then reads the `names.worktree` that was never
   computed and dies with a `TypeError`.

   **No `#N` in `$ARGUMENTS`, only a subject** — there is no mint-free path to a
   branch, so pick one of the two that exist:
   - mint the issue first, through `Skill(skill: "issue-triage:issue-triage")` — one
     issue carrying the subject, epic or not — then continue here with its number.
     `resolveNames` then works as designed and §4 refines that issue rather than
     opening a second one;
   - or do not hop at all: the framing pass is what mints tickets, and it only needs
     *a* worktree. Run `/feature <subject>` from a ω you already own and §4 takes it
     in the current worktree.
2. **Create ω**: `const resolved = await ensureWorktree(principalPath, names)`. It
   refuses a dirty or non-base Principal, and it never moves the Principal's HEAD.
   `resolved.worktree` is ω's directory — the fact step 4 needs.
3. **Install its dependencies**: `bun install` **inside ω**, and wait for it.
   Non-negotiable (#499): `commitlint` runs on every commit through lefthook and
   resolves its config from `node_modules`; an uninstalled worktree therefore
   refuses *every* commit, whatever the content, with an error that names the config
   and not the cause. A hop that lands the operator in a tree that cannot commit is
   a broken hop.
4. **Resolve the entry, now that both halves exist**, and print its command:

   ```javascript
   const entry = resolveEntry({
     cwd,
     principalPath,
     branch: resolved.branch,
     ticket,
     worktreePath: resolved.worktree,
   })
   ```

   `entry.action` is `hop`. Print `entry.command` verbatim — it is a directory hop:

   ```
   omp --cwd <ω>
   ```

   Then: « ω prêt et installé. Tape la ligne ci-dessus, puis relance `/feature`. »

   **Never `/wt`.** That command always *mints* a new branch and hard-refuses one
   that already exists, and it lands in `~/.omp/wt/<sanitised>-<hash>` — never in
   the ω `ensureWorktree` just built and installed. The relaunch names the
   directory: `skills/build/SKILL.md` (`need-relaunch` → `omp --cwd
   <result.worktree>`) and `scripts/omp-wt.mjs` (`Bun.spawn(['omp', '--cwd', …])`)
   already answer it that way.

Why printed and not performed: `applyCwdChange` lives on the interactive-mode
controller, reached through `session.switchSession({ onCwdChange })`. The documented
`ExtensionCommandContext` exposes `newSession` / `switchSession(path)` / `branch` /
`navigateTree` / `reload` / `compact` and **no cwd hop** (measured on omp v18.2.6,
re-read on 18.2.9 — ADR-020 §3 residual). If a later OMP exposes one, perform the
hop there and delete this step. Until then the fallback *is* the behaviour: one
relaunch per feature, and no line of code written on the Principal.

## 4. Frame — grill, spec, tickets

Only reachable inside ω (`action: frame`). Everything below is written **in ω**.

1. **Grill.** `Skill(skill: "grill-with-docs")` — HITL, one frontier of numbered
   questions per round, each with a recommended answer. Domain only: TL;DR, data
   model, acceptance, out of scope, invariants.
2. **Write the durable prose as the grill settles**, inside ω, not after the fact:
   - new or sharpened vocabulary → the project glossary (`CONTEXT.md` of the
     touched plugin, or the repo's);
   - a decision with alternatives and a cost → an ADR under
     `docs/architecture/adr/`. No decision worth one → write none, and say so.
3. **Spec**: `Skill(skill: "to-spec")`. The spec home is the **tracker issue**
   (ADR-020 §4) — no `artifacts/specs`, no `status: validated` gate. If an epic
   already tracks this subject, amend that issue instead of opening a second one.
4. **Tickets**: `Skill(skill: "to-tickets")` — tracer bullets, each independently
   landable.

### Publishing is `issue-triage`'s job, not `gh`'s

Every issue write goes through
`Skill(skill: "issue-triage:issue-triage")` — creation, `size:`, priority, type, and
every relation. Never `gh issue create`, never a `Blocked by: #12` line in a body
(invisible to `gh issue view` and to the frontier query).

Per ticket, in one `create`:

| Flag | Why it is mandatory |
|---|---|
| `--size S \| F-lite \| F-full` | the label is the **only** source of the review tier τ; a ticket without one silently downgrades its own review to `F-lite` |
| `--blocked-by "#N"` | the tracer-bullet order is a DAG, not a list |
| `--parent "#E"` | the epic's fan-out stays flat |
| `--type` | `feat` \| `fix` \| `docs` \| `chore` \| `refactor` \| … |

## 5. The frontier — read the edges, never the summary

Stop here. Print what is grabbable now, computed from the **edge list**. There is no
batch form: the endpoint is per issue, so read it **once per published ticket** —
`{owner}` and `{repo}` are `gh`'s own placeholders, filled from the current repo:

```bash
for n in 501 502 503; do   # the numbers §4 just published
  open=$(gh api "repos/{owner}/{repo}/issues/$n/dependencies/blocked_by" \
    --jq '[.[] | select(.state == "open")] | length')
  echo "#$n blocked_by(open)=$open"
done
```

`0` → grabbable. Anything else → blocked, and name the blockers (drop `| length` to
read them: the same call returns `number` and `state` per blocker).

**Never `issue_dependencies_summary.blocked_by` in the turn that published the
tickets.** Measured on #493 (2026-09-21): it is a denormalised counter that lags the
edge write. Creating an issue with `--blocked-by '#489'` (#489 open) and reading the
summary in the same batch returned

```
{"blocked_by":0,"blocking":0,"total_blocked_by":0,"total_blocking":0}
```

while `GET /issues/503/dependencies/blocked_by` already returned
`[{"number":489,"state":"open"}]`. A moment later the summary agreed. Computed from
the summary, every fresh ticket reports as grabbable and the stop prints the whole
batch as ready — including the blocked half. The failure is silent and it points the
operator at the wrong work.

(`blocked_by` counts **open** blockers; `total_blocked_by` counts all of them. Use
the open count.)

Then stop — for real. Print:

> Frontier: #A, #B. `/clear`, then `/feature #A` from here.

The context that framed the epic is not the context that implements a ticket
(ADR-020 § Consequences). Do not roll into mode 2 in the same window.
