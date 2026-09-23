---
name: feature
disable-model-invocation: true
argument-hint: '[#N | <subject>]'
description: OMP-only — one feature. From the Principal it hops into ω; in ω with no ticket it frames (grill → spec → tickets) and stops at the frontier; in ω on its ticket's branch it builds, reviews, fixes and lands.
version: 0.1.0
---

# Feature

One feature, one worktree. This body covers **entry** (§2), **mode 1 — framing**
(§3–§5) and **mode 2 — build** (§6: implement → review → fix → land).

Bundled seam: `skill://feature/entry.js`. The skill directory is printed at the end
of this body; import from there.

## 0. The tail is offered, never run

`/promote` and `/cleanup` sit outside this cycle (#495). Mode 2 ends at **land**;
after it lands, print the offer and stop:

> Landed #N. Optional: `/cleanup` to sweep merged branches · `/promote` to cut a
> release from staging.

Printing that line is the whole handoff. Never invoke either skill — not from
mode 2's land step, and above all not from the review→fix loop, where `/cleanup`
would delete the branch under review and `/promote` would cut a release out of a
half-reviewed diff. Both are `registerCommand` slash commands: the operator types
one, or it does not run.

## 1. Preflight — the capabilities §4 actually calls

**This check gates §4, not the whole command.** Answer §2 first: only the `frame`
route reaches §4, and mode 2 (§6) calls none of these four — gating a build on
`grill-with-docs` would stop every ticket on a machine that frames elsewhere. Mode 2
has its own list, in §6.0, and it is a different list.

§4 invokes four skills by name. Three come from an external plugin, one from this
repo, and **nothing makes them arrive together**. Routed to §4 → check all four
before anything else:

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

The tracker-contract stop below is **not** scoped to §4: §6.4 defers findings
through the same contract, so read it on both routes.

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
| `build` | the branch carries the ticket | §6 |
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

## 6. Build — implement → review → fix → land

Reachable on one route only: §2 answered `build`, so this ω is checked out on the
branch that carries `#N`. Everything below runs here, in this worktree, and ends
either with a merged PR or with an explicitly unmerged one.

### 6.0 Preflight and the seam

Mode 2 calls five capabilities. Two are this plugin's, two are upstream, one is the
tracker:

| Capability | Called at | Source |
|---|---|---|
| `implement` | §6.2 | Matt Pocock's skills plugin |
| `tdd` | never called here — `implement` drives it | idem, and it must be **un-ignored** |
| `dev-review` | §6.4 | this plugin — `skill://dev-review/SKILL.md` |
| `fix` | §6.5 | this plugin — `skill://fix/SKILL.md` |
| `issue-triage:issue-triage` | §6.5, every Defer | the `issue-triage` plugin |

Two settings checks, both read off the skill listing you were given:

- **`tdd` must be listed.** It is model-invoked and `implement` reaches for it; an
  ignored `tdd` turns "test-first at the seams" into a sentence nobody can act on
  (ADR-020 §5 un-ignores it). Absent → say so, and run §6.2 stating that the
  implementation is not test-first.
- **`code-review` must *not* be listed**, and is never invoked whether it is or not.
  This repo's panel replaces it (ADR-020 §5): `code-review` is Matt's two-axis pass,
  `dev-review` is five evidence-selected roles plus the tier τ read from the ticket's
  `size:` label. Running both doubles the findings and halves the attention paid to
  each. Listed → say so once, do not call it, continue.

`implement` or `dev-review` or `fix` missing → **stop** and name it. Never hand-roll
the missing one: a hand-written review is the failure mode the panel exists to
remove, and a hand-rolled `gh pr create` is the prose-parsing this section deletes.

Then import the seam once, and keep the handle — §6.6's bound lives in it:

```javascript
const { commitPush, openPr, landPr, createReviewLoop, detectPrincipal } =
  await import(`${SKILL_DIR}/../build/workflow.js`)   // SKILL_DIR = the printed skill directory
```

### 6.1 Read the ticket

`gh issue view <N>` — body, `size:` label, blocked-by edges. The body **is** the spec
(ADR-020 §4): there is no `artifacts/specs` file to open, and its Acceptance criteria
are what §6.2 implements, what §6.4 reviews, and what §6.7 closes.

An open `blocked_by` edge → stop and name the blocker. §5's frontier query is the
same call; a ticket that was grabbable at framing time may not be now.

### 6.2 Implement — test-first at the agreed seams

`Skill(skill: "implement")`, given the ticket number, its Acceptance criteria and
this worktree.

**`tdd` is driven, never stepped.** It is `implement`'s to invoke, at the seams it
agrees with the operator — that agreement is the human turn of mode 2, and it is the
reason `tdd` is not a numbered step here (ADR-020 §5, refuse list). Do not invoke
`tdd` yourself, and do not "add tests afterwards" to compensate for skipping it.

Do not commit, do not push, do not switch branch: §6.3 owns all three.

### 6.3 Commit, push, open — three calls, no prose

```javascript
await commitPush(cwd, branch, `feat(#${issue}): <what actually landed>`)
const base = await detectPrincipal(cwd)
const { number: pr, status } = await openPr(cwd, {
  issue, branch, base,
  title: '<Conventional Commit subject>',
  body: '<what changed and why, in plain prose>',
})
```

`openPr` returns `{ number, status }` — `status` is `'created'` or `'existing'`, and
`existing` is the normal answer when mode 2 is re-entered after an interruption. It
appends `Closes #<issue>` when the body does not already carry a closing keyword;
that keyword is the only machine-readable link back to the ticket, and `/promote`
re-emits exactly it.

Print one line: « PR #<pr> ouverte » or « PR #<pr> déjà ouverte, on continue dessus ».

**The number comes from the client's response, never from a reply.** Do not ask an
agent to open the PR and read the number out of what it says; do not scrape a URL.
`openPr` throws when the response carries no number — a throw here is worth more than
a plausible-looking string reaching `landPr` as a PR id.

### 6.4 Review — the panel, and only the panel

```javascript
const loop = createReviewLoop({ pr })   // created once, before the first review
```

Invoke `Skill(skill: "dev-review")` with `#<pr>`. Its Phase 1 asserts `SKILL_DIR`
and stops without it, so export **dev-review's own** directory first —
`<the printed skill directory>/../dev-review`, not this skill's.

It must **stay out of the way of the loop and of landing**. Its Phase 8 offers
"Fix now" and "Merge as-is — rebase + label + auto-merge". Answer **Stop**, both
times, whatever the verdict: the fix is §6.5's to run *after* the verdict has been
recorded (a fix that happens inside Phase 8 is a round the counter never saw), and
§6.7 is the only place a `reviewed` label is written. Same for `fix`'s own Phase 8
offer to rebase, label and merge: decline it.

Fold its verdict to the one word the loop takes:

| `dev-review` verdict | Word |
|---|---|
| `Approve`, `Approve (clean)`, `Approve with comments` | `green` |
| `Request changes` | `red` |

```javascript
let step = loop.record(verdict)   // 'green' | 'red' — nothing else; anything else throws
```

### 6.5 Fix — inline, and back round

`step.action === 'fix'` → `Skill(skill: "fix")` with `#<pr>`. It applies findings
**inline in this worktree** (there is no fixer agent in this plugin, ADR-020 §7), and
defers what it does not apply through `Skill(skill: "issue-triage:issue-triage")` as a
sibling of `#N` — never a child, never a `Blocked by:` text line.

Then commit the round — ``await commitPush(cwd, branch, `fix(#N): review round ${step.fixes}`)`` —
and go back to §6.4: re-run the panel on the same PR and record the new verdict.
`step.remaining` is how many rounds are left after this one; say it out loud.

### 6.6 The bound — two rounds, counted in code

`createReviewLoop` holds the count, not this body and not your memory of it. Each
verdict goes through `loop.record(...)` and the returned `action` is what happens
next:

| `action` | Meaning | Next |
|---|---|---|
| `land` | the panel approved | §6.7 |
| `fix` | red, and a round is left | §6.5 |
| `stop` | red, and **both** rounds are spent | print `step.message`, stop |

review → red → fix → review → red → fix → review: two fix rounds. **A third red
stops.** `record` then returns `stop` and closes the loop — a fourth verdict throws
rather than yielding `land`, so "one more review, it will be green this time" is not
a move that exists. `landPr` is not called on `stop`: the PR keeps no `reviewed`
label, auto-merge is never enabled, and nothing merges.

What the operator sees is `step.message`, verbatim:

> Review bound reached: 3 reviews, 2 fix rounds, still red. PR #512 stays unlabelled
> and unmerged — no `reviewed` label, no auto-merge. Read the findings on the PR,
> then fix by hand or close it.

Then stop. Do not offer the tail (§0): nothing landed.

### 6.7 Land — wait, label, let auto-merge finish

```javascript
const land = await landPr(cwd, pr)
```

`landPr` is the whole landing: it resolves the base branch's **required** contexts
(classic protection and rulesets both), polls the rollup until every one of them is
`SUCCESS`, and only then writes the `reviewed` label and enables auto-merge. Do not
reimplement any of that, and above all **never `gh pr merge` while a check is
running** — a mid-CI merge cancels the in-flight runs and skips the gates that the
label is supposed to attest.

| `land.status` | What it means | Say |
|---|---|---|
| `merged` | landed | « #N landed in PR #<pr> » → §0's offer |
| `ci-failed` | a required check is red (`land.failed`) | the branch is not landable; back to §6.5 only if a round is left, else stop |
| `ci-skipped` | a required check reported `SKIPPED`/`NEUTRAL` (`land.skipped`) | a skipped required check is not a passed one — stop, no label |
| `no-required-checks` | the base protects nothing | stop: there is nothing to wait on, so landing would attest nothing. Merge by hand, deliberately, or add the protection |
| `timeout` | 20 minutes without a green rollup | stop, name the pending contexts |
| `auto-merge-failed` | labelled, auto-merge refused | stop: the label is set, the merge is the operator's |
| `closed` | someone closed the PR under us | stop |

Only `merged` reaches §0.

### 6.8 After it lands

Print §0's offer verbatim and **stop**. `/promote` and `/cleanup` are typed by the
operator or they do not run — and `/cleanup` in particular would remove the worktree
this session is standing in.
