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

## 1. Preflight — the tracker contract

Read `docs/agents/issue-tracker.md` from the repo root.

**Absent → stop.** Say so and print:

> Tracker contract missing: `docs/agents/issue-tracker.md`. The Matt skills route
> every relation and label through `issue-triage`; without that file they fall back
> to raw `gh issue create` and publish a batch with no edges and no tier. Run
> `/setup-matt-pocock-skills`, then re-run `/feature`.

Do not grill. Do not create a worktree. Do not publish anything.

Present → keep it in context: it is the contract §4 and §5 below obey.

## 2. Resolve the entry

```javascript
const { resolveEntry } = await import(`${SKILL_DIR}/entry.js`)  // SKILL_DIR = the printed skill directory
const { ensureWorktree, resolveNames, detectPrincipal } = await import(`${SKILL_DIR}/../build/workflow.js`)
```

Facts to gather first — `resolveEntry` probes nothing itself:

| Input | Where it comes from |
|---|---|
| `cwd` | the session cwd |
| `principalPath` | first entry of `git worktree list --porcelain` |
| `branch` | `git -C <cwd> rev-parse --abbrev-ref HEAD`, or `null` when detached — **on the Principal**, the branch of the ω created in §3 |
| `ticket` | `#N` in `$ARGUMENTS`, else nothing |

| `action` | What it means | Go to |
|---|---|---|
| `hop` | cwd is the Principal | §3 |
| `frame` | in ω, no ticket | §4 |
| `build` | in ω, the branch carries the ticket | mode 2 — `#494`. Until it lands, stop and say so |
| `refuse` | in ω, the branch carries `branchTicket` (or nothing), not `ticket` | stop: « ce ω porte `<branch>`, pas #`<ticket>` » — go back to the Principal and run `/feature #<ticket>` |

`refuse` is not pedantry: implementing #N inside #M's worktree puts #N's commits on
#M's branch and into #M's PR, and nothing downstream notices.

## 3. Hop — never implement on the Principal

On the Principal, `/feature` prepares ω and leaves. In order:

1. **Name the branch.** With a ticket: `resolveNames({ cwd, type, slug, issue })` →
   `<type>/<N>-<slug>`. Without one: ask for the subject if `$ARGUMENTS` is empty,
   slugify it, use `feat/<slug>` — there is no issue number to put in the name yet,
   the framing pass is what mints them.
2. **Create ω**: `ensureWorktree(principalPath, names)`. It refuses a dirty or
   non-base Principal, and it never moves the Principal's HEAD.
3. **Install its dependencies**: `bun install` **inside ω**, and wait for it.
   Non-negotiable (#499): `commitlint` runs on every commit through lefthook and
   resolves its config from `node_modules`; an uninstalled worktree therefore
   refuses *every* commit, whatever the content, with an error that names the config
   and not the cause. A hop that lands the operator in a tree that cannot commit is
   a broken hop.
4. **Print the relocation line and stop** — `entry.command`, verbatim:

   ```
   /wt <branch>
   ```

   Then: « ω prêt et installé. Tape la ligne ci-dessus, puis relance `/feature`. »

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

If the skill is unavailable: **stop and say so.** Do not fall back.

## 5. The frontier — read the edges, never the summary

Stop here. Print what is grabbable now, computed from the **edge list**:

```bash
gh api "repos/$OWNER/$REPO/issues/$N/dependencies/blocked_by" \
  --jq '[.[] | select(.state == "open")] | length'
```

`0` → grabbable. Anything else → blocked, and name the blockers.

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
