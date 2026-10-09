# omp-build

OMP-only cycle: frame → GitHub issue → agent-created worktree → `/move` + `/goal` → implement → bounded review/fix → land.

Not a Claude/Grok factory — does not invoke host `/dev` or dev-core Skill() children.

## Install

OMP marketplace — catalogued in `.omp-plugin/marketplace.json` only (OMP-only plugin, absent from the Claude Code catalog).

```bash
omp plugin marketplace add Roxabi/roxabi-plugins   # once per machine
omp plugin marketplace update roxabi-marketplace   # after a catalog change lands
omp plugin install omp-build@roxabi-marketplace
```

If `~/.local/bin/omp-wt` exists, `rm -f ~/.local/bin/omp-wt` — the script is retired; enter a worktree with `/move <path>`.

**Then arm the surfaces.** With the `claude-plugins` provider disabled, a marketplace install loads only `package.json#omp.extensions` — `skills/` and `agents/` stay dark, because the realpath filter that hides marketplace roots lives in the *installed* lane that both `omp-plugins` (skills/commands/hooks) and the agents gate read. Add the stable `node_modules` symlink to `extensions:` in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/plugins/node_modules/omp-build
```

Then **restart** the OMP session — agents and extension modules are not picked up by `/reload-plugins`.

Keep this package **legacy**: no `plugin.json` at the package root. With one, `agent-plugins` unions the cache directory and the `node_modules` symlink as two distinct path strings and loads every skill twice.

### Local authoring (link)

Alternative to the catalog install, from a checkout of `roxabi-plugins` (monorepo subdir layout):

```bash
# from repo root
omp plugin link ./plugins/omp-build
```

Requires `package.json` with an `omp` key. `omp.extensions` is the in-process lane — this plugin ships `./omp/index.ts` there (see [Guards](#guards)).

Verify:

```bash
omp plugin doctor    # expect plugin:omp-build (link lane; a marketplace install has no plugin:* line)
omp plugin list      # npm Plugins → omp-build@<version in plugins/omp-build/package.json>
```

`/feature` loads `skills/feature/` from the installed plugin. Do **not** copy `SKILL.md` into `~/.omp/agent/skills/` — that shadows the plugin.

### After you change the plugin

| Change | Pick up |
|---|---|
| `skills/`, `commands/`, MCP config | `/reload-plugins` |
| `hooks/`, `omp.extensions`, **new/changed `agents/*.md`** | **restart** OMP session |

Symlinking into `~/.omp/agent/agents/` is not supported — use `link` (or the catalog install armed by `extensions:`) + restart.

## Launch

```text
/feature <subject>    # frame the need and publish through issue-triage
/feature #42          # read an existing issue and propose its branch
```

At the end of framing an epic, the agent creates `<worktree base>/<repo>/<epic-slug>`
**detached** at fresh `refs/remotes/origin/<base>` (no epic branch) and prints
`/move <path>`. Once every child is framed, `/feature #E` in that worktree prints the
generated `/goal` line (`skills/feature/epic-driver.ts objective`), carrying the
epic, a `run=` id and the base. It does not switch the Principal. A single ticket
outside a goal uses the same `/move`; assisted mode, no `/goal`.

After entering the matching worktree, run `/feature #42` again. Incomplete scope
returns to framing; an actionable, unblocked issue proceeds to implementation.
Framing can start in conversation on the Principal; local file edits cannot.
After a framing pass, start implementation with fresh context in the ticket's
worktree. Declining branch creation permits further discussion, not implementation.

The issue body is the spec. Current dependencies: `grilling` for open design
questions, `issue-triage` for issue writes, and bundled `dev-review` / `fix` for
verification. `tdd` is used at agreed test-first seams. The old `grill-with-docs`,
`to-spec`, `to-tickets` and `implement` skills are no longer prerequisites.

PR open, the review loop, and landing live in `skills/feature/workflow.js`.

### Epic flow under `/goal`

With a goal active whose objective names `/feature #E`, the session runs the epic
unattended in the epic worktree. Before every ticket it asks the driver
(`skills/feature/epic-driver.ts next`) for the one next action, from GitHub and git
state alone:

```text
next → start/resume child (branch from origin/<base>) → implement → dev-review → fix → land
     → merge confirmed: detach, delete the local branch → next …
     → every child closed or merged → final epic review (R-architect + R-adversarial)
     → clean tree and base CI green or none → release.post_merge at that base commit
     → report → goal complete
```

Children run in `blocked_by` order. A **ticket stop** (review bound spent, watch
timeout, cancelled or blocked checks, proof blocked, no scope, foreign commit…) is
recorded on the child as a `goal-stop` marker, its PR disarmed; its dependents are
skipped and independent children continue. A **shared-state stop** (base CI red,
`base-ci-pending` at finalization, a dirty tree, `hook-stale`, landing or tracker
failure, hook failure, final review still blocking after its one fix ticket)
disarms every child PR, reports on the epic and drops the
goal. A new `/goal` line resumes: merged children are skipped, open PRs resumed,
stops of earlier runs retried except a spent review bound. Without an active goal
naming the epic, `/feature` is unchanged.

Every `next` re-disarms a stopped child's armed PR before it moves on (`reconciled`); a failed disarm, or a PR that already merged, is a drop and creates no branch. `report --outcome drop` disarms without reading base CI or the landing, and exits non-zero naming any PR still armed. If that command fails, print the error, then drop the goal.

## Slash commands

| Command | Lane |
|---|---|
| `/feature` | `omp/index.ts` → `registerCommand('feature')`, in-process. Dumps `skills/feature/SKILL.md` |
| `/promote` | idem, `registerCommand('promote')`. Dumps `skills/promote/SKILL.md` |
| `/cleanup` | idem, `registerCommand('cleanup')`. Dumps `skills/cleanup/SKILL.md` |
| `/ci-watch` | idem, `registerCommand('ci-watch')`. Dumps `skills/ci-watch/SKILL.md` |

Slash-only, on the one lane there is: `registerCommand` is the user lane,
`registerTool` is the LLM one, and the model cannot reach a command — that is the
whole property, and it is sufficient. A skill body's `disable-model-invocation`
is **not** a second gate: omp normalises it to `hide`, which omits the skill from
the prompt listing while `skill://<name>` and `/skill:<name>` still reach it
(omp 18.2.9). Requires a **restart** (extension module), not `/reload-plugins`.

`/feature` prints `/move` immediately after framing and, for an epic, the `/goal` line once its children are framed.
It does not hand the operator a `/wt` line. Existing worktrees are entered by
`/move <path>`, not recreated.

In the matching worktree: implement → `dev-review` → `fix` → land.
`resolveReviewPr` binds an explicit number or the current branch before any
review read; lookup failure is never treated as a local review. A closed PR on
the branch refuses implicit reuse, so its bound cannot be reset. Existing PRs
resume from their review records.

Review → fix record contract: [root causes and member references](skills/dev-review/root-causes.md).

The review bound is two reads of the PR's review records (#710) — the comments
by the automation login (`gh api user`) whose first line is
`<!-- omp-build:code-review -->`: how many there are, and the latest one. Nothing
writes accounting; every decision is derived again from a fresh read.

**The armed gate (#713).** An OPEN PR is armed — `reviewed` label or auto-merge
enabled — only when the latest review record approves the current head, the bound
is not spent, and no review of that head is running. The four workflow exits share
`enforceArmedGate` (#729), separating actual `reviewing` from forced-unarmed policy.
Its `disarmGate` primitive disables auto-merge first, independently removes the
label, validates read-back, and throws one error naming any remainder.
`disarmed: true` requires an attempted clear and confirming read-back; an already
clear or non-OPEN gate is a no-op. Every `nextReviewStep` action passes the policy:
non-`land` actions and actual review starts force clearing. Native
`no-required-checks`, CI-watch failures and pre-push barriers also force clearing;
watch observers retain arms only with current approval/head evidence. Required-check
discovery failure can cancel a scheduled merge; configure checks and re-enter
through the normal gate, with no automatic restoration. Native legacy stuck results
adapt the clearing error without another attempt. A refused native pin on a readable
stable head still returns `auto-merge-failed` / `armed: false`, which is no clearing
receipt; if that head cannot be read, the known gate is forced clear and the original
read error is thrown — when clearing cannot finish, the error names the remaining or
uncertain arms with that error as its cause. An existing-PR review runs the barrier
before its diff; the review-start test exercises the fence, not model compliance.

**Error-text contract.** An `auto-merge-failed` result's `error` carries no structured field for what remains. Two fragments are the contract: the remaining arms follow `stays armed — <arms>`, and state that could not be confirmed is named by `could not be read back`. The prefix and the causal prose around them are not a stable API; callers and tests match the fragments, not the sentence. A refused pin on a readable head keeps its `armed: false`, which is still no clearing receipt.

**What the tests prove.** `armed-gate.test.js` has a clean-baseline sweep that covers one throw-before-effect at each call of the clean baseline (the base read excluded), selected observable head moves after calls that succeeded, and a throw plus a move paired after the gate is acquired. It excludes, and leaves to table rows alone, applies-then-throws and faults inside a disarm that an injected fault first triggers; it makes no claim about future calls. The #731 seeded compound suite is separate from that sweep. The base-read failure is covered by its own real-Bun scenario in `land.integration.test.js`: a discovered, armed, strict landing whose base read fails, with a real local origin. It does not detect both base files vanishing, which defaults to native. The oracle has four negative self-tests (`approve(OLD)` over an armed head, a forged `stays armed — auto-merge` report, a spent-bound armed PR, a text-only "the gate was disarmed" claim). The unreadable-pin row carries `known: '#731'`, an inert provenance marker for a fixed regression: it grants no exemption and nothing reads it. None of this is a proof that every fault ordering is covered.

- `nextReviewStep(cwd, pr, { posted?, ciFailed?, reviewing? })` returns `land`, `fix`, `stop`
  or `review`. A fix is allowed while the PR has at most two records, one per
  review: the fix's push moves the head, and a latest record of another commit
  asks for a review first. A record past the second that does not approve spends
  the bound for good — a later green does not lift it. A CI failure on the head
  the third review approved stops too. `posted` (the review just posted) must be
  the latest record, else it throws.
- `landPr(cwd, pr)` arms only when the latest record approves and its line-2
  `<!-- omp-build:review-head sha=… -->` equals the current `headRefOid`. Records
  then head are refreshed before each arming write, including after disable/remove
  preparation. A spent bound is `not-approved` with reason `review-bound`; a missing
  line-2 sha is `no-review-head`, and a moved head is `head-moved`. Unreadable
  authorization never permits arming; acquired gates use the shared exit policy.
  Native auto-merge pins that refreshed reviewed head with `--match-head-commit`. Merge-on-green is
  label-driven: a later push by another actor is not refused by GitHub. A review
  posted before the head line existed needs one re-review before it can land.

The bound guards against agent mistakes, not against an agent that bypasses it:
records by other accounts are ignored, and edits or deletions of the account's
comments are not detected. Every posted review counts, with or without a fix
before it. Older accounting comments and the `## Review Fixes Applied` receipt
decide nothing.

The canonical choices and escalation dossier live in `skills/dev-review/SKILL.md`
Phase 8. Skills route through `nextReviewStep` and `landPr`; they do not own
separate rules.

Landing resolves mode from `readLanding` on the PR base ref (`origin/<base>`): stack `landing.mode`, else
`merge-on-green.yml`, else native. It returns the absolute `/ci-watch` command,
including GitHub's fresh labeled-event time under merge-on-green. Native also
enables auto-merge. `applyCiWatchExit` preserves watch statuses while enforcing
gate authorization; `disarmReviewedBeforePush` confirms clearing before invoking
the push once, and reuses that receipt if the callback fails. Neither review nor
fix labels a PR. No duplicate spec files or `validated` gate.

## Guards

The plugin arms its guard chain **in-process**, through `omp.extensions` → `omp/index.ts`. It intercepts `tool_call` and refuses, before the tool runs:

| Tool | Refusal |
|---|---|
| `bash` | bare `bun test` (`bun run test` passes) |
| `bash` | `git switch`/`checkout` off `staging\|main\|master` **in the principal worktree** — escape hatch `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1` |
| `write`, `edit` | content matching the hardcoded-secret / SQL-injection / command-injection table |

The scan **fails open** above `SECURITY_SCAN_MAX_BYTES` (256 KB): a payload larger than the ceiling is not scanned at all. Once `dev-core` is uninstalled there is no second layer behind this one.

Guards are **off** unless the project declares the host-neutral contract (`.dev/stack.yml` or `.dev/dev-core.yml`); without it the interceptor is a no-op and warns once per cwd.

`omp/guards.ts`, `hooks/`, `agents/R-*` (except `R-advisor`) and `skills/shared/` are a **frozen snapshot** (ADR-020): omp-build resolves nothing through a sibling plugin at runtime, so it stays installable on its own. The snapshot is not resynced. The `model:` lines on the five review agents are a deliberate local divergence from that snapshot, not a resync.

`skills/shared/` holds `lib.sh` (base-branch / worktree helpers, sourced as `. "$SCRIPT_DIR/../shared/lib.sh"`) and its `artifact-classify.ts` closure. No `references/` directory travels: the one reference a snapshotted agent cited is inlined into `R-architect` itself, because a `${CLAUDE_PLUGIN_ROOT}` token only expands in SKILL.md bodies — never in an agent body, and never at all in this plugin. `skills/dev-review/SKILL.md` Phase 1 and `skills/cleanup/analyze-branches.sh` are `lib.sh`'s in-plugin callers (`detect_base_branch`).

> **Known caveat, this slice only.** While both this plugin and `dev-core` are installed, both interceptors see the same `tool_call` and reach the same verdict — the snapshots are byte-identical and read the same escape hatch. Expect the refusal, and the no-contract warning, to be reported **once per plugin**: each extension owns a private warned-cwd set, so neither dedupes the other.

## Worktree bootstrap on entry

The same extension bootstraps worktrees it did not create. On `session_start` and `agent_start`, when the main agent's cwd is inside a linked worktree with no `omp-build-bootstrapped` marker in its git dir, it starts `skills/feature/worktree-bootstrap.sh` there, detached, logging to `<git dir>/omp-build-bootstrap.log`. Each cwd is checked once per session. This covers every way a worktree appears — `git worktree add`, `github` `pr_checkout`, `/wt`, a terminal — as soon as a session works in it, because omp emits no event for a new worktree or a `/move` while `ctx.cwd` follows the session.

- The principal, a directory outside git, and subagents (task isolations) never start one. No project contract is required: without `.dev/stack.yml` only the code indexes are built.
- The script holds a lock in the git dir, so `/feature`'s explicit call waits for a background run and then no-ops.
- ccc's `settings.yml` lands before `worktree.setup`, so ccc never indexes an ancestor directory while an install runs.

## Agents

OMP task agents in `agents/`. **Two** are OMP-native (`R-advisor`, `elon` — `model: "@advisor"`, typed `output:` schema). **Five** are frozen snapshots of `dev-core` review agents (ADR-020 decision 7) and declare a role: `@review, @slow` for the judgment agents `R-adversarial`, `R-architect` and `R-security-auditor`; `@task` for `R-devops` and `R-tester`. When an unmapped role still hands the choice to the parent is stated below the table. Every agent carries an explicit `tools:` pin: the snapshots arrived with their posture stated in prose only, and a read-only floor whose read-only-ness is unenforced is not a control.

| Agent | Model | Posture |
|---|---|---|
| `R-adversarial` | `@review, @slow` | Review floor. Red-team the priced claim: bypass, fleet-regression, operational, assumption-kill, vacuous-guard, scope-attack — **plus the OWASP lens**, because `R-security-auditor` is not spawned by default. Sibling-drop applies only to siblings actually in the `Spawned roster:`; absent roster ⇒ it owns everything. |
| `R-advisor` | `@advisor` | Constructive second opinion. Strengthen, don't attack. Not the session WATCHDOG (`advisor.enabled`, `/advisor`, `WATCHDOG.yml`). |
| `R-architect` | `@review, @slow` | System design + cross-cutting consistency. Two modes: normal (ADRs, tier) and axial (read-only drift review against the unique `axial: true` ADR; the procedure is inlined at the end of the agent file). Pinned read-only here — omp-build spawns it as a review role. |
| `R-devops` | `@task` | Config, CI/CD, Docker, dependencies. Review mode by default — findings only, no config edits. |
| `R-tester` | `@task` | Test generation + coverage + negative-test judgement. The executable falsify oracle is **cut** on OMP (ADR-020 decision 8): no producer, so no `oracle_ok`. |
| `R-security-auditor` | `@review, @slow` | OWASP inventory. Spawned on `path_hit` (Δ ∩ auth/secrets/crypto), not by default. |
| `elon` | `@advisor` | The Algorithm. Read-only tools. Inventory (NAMED/UNNAMED/BINDING) → delete (named add-back) → simplify → accelerate → automate last. Process only, not Musk roleplay. |

`review` is not a built-in OMP role: the operator maps it in `modelRoles.review`. omp 18.8.0 resolves `@review, @slow` as follows. An unmapped `@review` matches no model and OMP takes the next entry, `@slow`. An unset `slow` resolves to `modelRoles.default`, and to OMP's built-in slow candidates only when `default` is unset too. With neither `review` nor `slow` mapped, the judgment agents therefore run `modelRoles.default` when it is set, which can be the worker model, and OMP's built-in slow candidates when it is not. The list expands to more than one selector, so `retry.fallbackChains.review` is not attached to these agents: their runtime fallback is the rest of the list, the `@slow` model. A spawn that passes no `model` can still fall back to the parent session's model when the resolved model has no working credentials. To keep judgment off the worker tier, map `modelRoles.review`, and `modelRoles.slow` for a distinct fallback.

Spawn: `task` `{ agent: "R-adversarial" | "R-advisor" | "R-architect" | "R-devops" | "R-tester" | "R-security-auditor" | "elon", ... }`. Read from `agents/` of whichever package root is in the extension lane — the `link` symlink, or the marketplace install's `node_modules` symlink once it is listed in `extensions:`. `R-advisor` is a spawnable task agent, **not** the session WATCHDOG (`advisor.enabled`).

`R-frontend-dev`, `R-backend-dev`, `R-fixer`, `R-doc-writer` and `R-product-lead` are deliberately absent (ADR-020 decision 7): their concerns fall to the `R-adversarial` floor through the sibling-drop rule.

Resolution when a spawn passes no `model`: explicit call model, then `task.agentModelOverrides`, then this frontmatter, then the active parent. An operator override for an agent masks the manifest role until it is removed. A role alias in an override expands through `modelRoles`, `@default` included, and OMP uses the override only when that expansion yields at least one model; otherwise it skips the override and reads the frontmatter. `R-devops: "@default"` therefore pins the configured `modelRoles.default`, not the parent's live model, and has no effect while `default` is unset. In omp 18.8.0 the parent's active model is taken by a per-call `model` entry `@default`, a single-entry frontmatter `@default`, and a single-entry frontmatter `@task` while `modelRoles.task` is unset: `R-devops` and `R-tester` run the parent's model until the operator maps `task`. The two-entry `@review, @slow` never takes that path; only the credential fallback above reaches the parent. The dev-review spawn template passes no `model`, so it does not defeat these declarations.

## Skills

| Skill | Lane |
|---|---|
| `feature` | `/feature` (registered command) |
| `dev-review` | model-invocable · the five-role review panel |
| `fix` | model-invocable · applies blocking causes, inline; non-blocking causes deferred |
| `promote` | `/promote` (registered command) · the optional tail |
| `cleanup` | `/cleanup` (registered command) · the optional tail |
| `ci-watch` | `/ci-watch` (registered command) · watches checks, then the merge |

`dev-review` and `fix` are the #492 snapshot of dev-core's `dev-review`/`fix` pair, cut to this plugin's roster: five dispatchable roles, `R-tester` armed by changed-test evidence alone, and blocking causes applied in-session; non-blocking causes deferred to one sibling issue. They read their own bundled files through `skill://dev-review/<file>`. `lib.sh` is the exception: it sits one level up, in a non-skill directory, and `skill://` rejects `..`, so `dev-review` Phase 1 traverses from `$SKILL_DIR` instead. **Nothing in this plugin exports `SKILL_DIR`** — only the registered commands print a skill directory (`omp/index.ts`) — so that fence asserts the variable (`${SKILL_DIR:?…}`) and stops when it is unset, rather than sourcing `/../shared/lib.sh` and detecting a base branch against nothing. `cleanup/analyze-branches.sh` has no such problem: it is a script, so it resolves `../shared/lib.sh` from its own `BASH_SOURCE`.

`promote` and `cleanup` are the #495 snapshot of dev-core's tail. They are
**offered after land, never automatic, and never inside the review→fix loop**.
`/feature` offers `promote` only for `release.model: staging-train`, not trunk.
Two behaviours changed in the copy: `promote/preflight.sh` is now read-only (dev-core's ran
`git checkout staging && git pull` before asking the operator anything), and
`cleanup/scan-orphan-worktree-shells.sh` scans three roots: `~/.omp/worktrees/<repo>/`
(legacy leftover of the retired `ensureWorktree`; still scanned; `/feature` does not write here),
`<principal>/.claude/worktrees/` (harness-created worktrees), and `<worktree base>/<repo>/<slug>`
(the `/feature` root; base is `OMP_WORKTREE_DIR`, else stack.yml `worktree.base`, else `~/.omp/wt`),
instead of the Grok roots this plugin never writes to. dev-core's `shared/references/release-convention.md` did not travel: its two
rules are inlined in `promote/SKILL.md` § Merge method.

**The names are deliberately not `R-dev-review`/`R-fix`.** Skill discovery dedups by `name` across every provider, first-wins: while `dev-core` is still installed next to this plugin, identical names would make one of the two workflows shadow the other silently — and the shadowed one is the panel the operator thinks is running. Snapshotted agent bodies still call the workflow `/R-dev-review` in prose; that is a label, not an invocation, and the dispatch prompt in `skills/dev-review/SKILL.md` is the contract they actually obey.

## Maintenance

Lint-only fixture changes must preserve the emitted shell text and cleanup/release safety behavior, not replace executable checks with source-text assertions. Publish OMP changes with matching, newer versions in `package.json` and `.omp-plugin/marketplace.json` so the version-keyed install cache is refreshed.
