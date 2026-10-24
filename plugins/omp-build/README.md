# omp-build

OMP-only delivery plugin. The installed `/feature` command drives a bounded graph: frame, issue, worktree, implement, native review and correction, land. A session `/goal` does not authorize that graph.

Not a Claude/Grok factory — does not invoke host `/dev` or dev-core Skill() children. Package `0.11.3` in this tree is not an installed or activated release.

## Install

OMP marketplace — catalogued in `.omp-plugin/marketplace.json` only (OMP-only plugin, absent from the Claude Code catalog).

```bash
# First install
omp plugin marketplace add Roxabi/roxabi-plugins   # once per machine
omp plugin install omp-build@roxabi-marketplace
# After a marketplace update lands
omp plugin marketplace update roxabi-marketplace
omp plugin upgrade omp-build@roxabi-marketplace
```

If `~/.local/bin/omp-wt` exists, `rm -f ~/.local/bin/omp-wt` — the script is retired; enter a worktree with `/move <path>`.

**Then arm the surfaces.** With the `claude-plugins` provider disabled, a marketplace install loads only `package.json#omp.extensions` — `skills/` and `agents/` stay dark, because the realpath filter that hides marketplace roots lives in the *installed* lane that both `omp-plugins` (skills/commands/hooks) and the agents gate read. Add the stable `node_modules` symlink to `extensions:` in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/plugins/node_modules/omp-build
```

After a marketplace update or install, **restart** OMP — do **not** use `/reload-plugins`; agents and extension modules are not picked up otherwise.

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

The installed extension registers `/feature` and runs the product coordinator. `skills/feature/SKILL.md` is its reference, not an independently executed lifecycle. Do **not** copy it into `~/.omp/agent/skills/` — that shadows the plugin.

### After you change the plugin

| Change | Pick up |
|---|---|
| `skills/`, `commands/`, MCP config | `/reload-plugins` |
| `hooks/`, `omp.extensions`, **new/changed generated `agents/*.md`** | **restart** OMP session |
| `agent-sources/`, native profile/schema sources, issue-triage helper source | `bun run build` from the repo root regenerates the distribution. Commit matching sources and generated files before distribution verification. Install does not run the build. |
Symlinking into `~/.omp/agent/agents/` is not supported — use `link` (or the catalog install armed by `extensions:`) + restart.

## Process

`omp/index.ts` registers `/feature` and calls `runInstalledFeatureCommand` in `roxabi/feature-entry.ts`. That registered command does not dump `skills/feature/SKILL.md`. Explicit `skill://feature` or `/skill:feature` access supplies reference material for human decisions, not a second lifecycle or execution authority. The local T3 qualification below covers workflow integration, not semantic-model quality or hosted activation; both remain separately authorized.

### Controls

`parseFeatureCommand` is the word list. A known transition does not ask again. There is no per-PR merge approval.

| Command | Boundary |
|---|---|
| `/feature <reference>` | Publishes the first valid mandate, or reuses an applicable one. |
| `/feature resume <reference>` | Resumes an ordinary confirmed pause. A review-bound or safety stop is not a pause. |
| `/feature pause <reference>` | Inhibits local continuation and publishes the control. Confirmed only after observed disarm. |
| `/feature abandon <reference>` | Revokes the selected mandate, including when that mandate has its own confirmed pause. No automatic renewal. |
| `/feature new <reference>` | Successor over an intact abandoned or revoked mandate. `publishSuccessorMandate` names the antecedent and publishes `select-successor`. `preserveSuccessorBinding` rebinds the same open PR when its binding names the antecedent or is absent. A missing antecedent or a foreign binding does not mint. Not renewal of `/feature <reference>`. `new init` is this control, not init. |
| `/feature material-decision <reference> accept\|reject` | The only material-Spec decision. Editorial continues without a question. Unknown stops. |
| `/feature init` | Preview of the invoking checkout. Not a subject, not framing, not a mandate, not a native task. |

From the Principal, or when the session cwd is not the intended worktree, select, resume, and new return `session-cwd` and `/move <path>`. They publish no mandate, branch binding, or native work. After `/move`, the same `/feature <reference>` is continuation, not a second approval. Pause and abandon of existing remote authority may still run without native work. There is no `/wt`. `/dev-review` and `/fix` do not grant landing.

Detected mid-turn user interruption, session switch, and shutdown await the durable pause for a pausable owner. Confirmation is the read-back `pause-confirmed` control, not the local interrupt. A finished or confirmed-abandoned owner is released and is not paused again. An unconfirmed pause is not a resumable pause.

Ordinary SDK `session_stop` means turn settlement, not workflow pause: a host-owned CI watch continues. When only that watch is running, idle Esc/RPC abort does not guarantee pause or disarm; use `/feature pause` or `/feature abandon`. This is the explicit-stop contract, not an idle-abort hook. Mid-turn interruption uses the SDK's session-stamped `UserInterrupt` flag on an aborted assistant message. That SDK primitive is bundled at build time into the existing contracts bundle; there is no runtime SDK dependency, copied error-label fallback, or second supervisor. Status delivery requests `triggerTurn: false`; it does not grant continuation authority.

Spec assessment receives the exact accepted and current bodies as JSON strings, preserving whitespace and final newlines. Its original classification stays in the action result. An explicit material acceptance applies only to that confirmed assessment and exact pair; changed or ambiguous references stop. Rejection publishes no acceptance and grants no continuation or landing authority. It is not an abandonment or a reset of the review bound.

### Init

`/feature init` and `/feature init --dry-run` are the same preview. The host captures `git rev-parse --show-toplevel`. A failed capture stops and does not frame. Otherwise it runs `bun --no-env-file <plugin>/skills/feature/feature-init.ts --dir <that root>` with Bun's cwd set to the script directory, and forwards only the operator's tokens. It does not add `--approve` or `--operator-approval`.

The preview prints proposed stack additions, conflicts, the tracker plan, and a digest, then `digest is not authorization`. A printed digest is not an init reference. Explicit apply is the operator's own `/feature init --approve <digest> --operator-approval '<reply>'`. The CLI refuses a digest used as the approval text. `skills/feature/SKILL.md` states the rest of that boundary.

### Storage and recovery

Three parts, one plugin, no second runtime, no database, and no mandatory local business workflow store. Local environment caches are separate and reconstructible.

| Part | Owns | Does not own |
|---|---|---|
| Engine (`engine/`) | Canonical records, reference/conservation checks, bounded traversal from confirmed histories and landing-mandate admission | Semantic judgement, GitHub calls, merge |
| Roxabi (`roxabi/`) | Shipped graph, named actions, and the mandate snapshot of `review.additional_requirements` | A second config file, a project graph, a bound override, an admission override |
| GitHub adapter (`adapters/`) | Complete comment history, confirmed publication, scope reads | Finding classification, landing permission |

GitHub comments hold the records: `mandate`, `operator-control`, `action-receipt`, `workflow-binding`, plus the existing review, correction, proof, and epic-event records. Git holds the code and the normative proof configuration. Proof pins are path, source commit, and blob; a null blob is explicit absence, recovered from Git. The review-input hash prefixes `omp-build:review-input/2` and includes the semantic canon even when producer part lists are null. A stored null input is not approval.

The stack pin binds the selected base's blob. Existing UI proof rules still inspect both base and candidate stacks; a candidate stack change is not required to be byte-identical to the base. Semctx and AssertLedger retain their own configuration-divergence and applicability checks.

The only project override of the shipped workflow definition is `review.additional_requirements` in the committed `.dev/stack.yml` at `refs/remotes/origin/<base>:.dev/stack.yml`. Existing `landing`, `release`, and `commands` configuration remains in force. `parseWorkflowOverride` accepts a list of non-empty strings. Absent `review`, or a null list, means none. `review.graph` and `review.workflow` are refused. There is no `.omp-build/workflow.json`. The mandate records that list as `effective.additionalRequirements`. An uncommitted working-tree edit is not that snapshot. The list does not replace the shipped graph, a review bound, or landing admission.

A confirmed checkpoint is a published record read back, plus the Git facts that bind it. An OMP goal, transcript, or local session file is not authority. Local environment files are not authority either: dependency installs, indexes, and the per-git-dir bootstrap marker `omp-build-bootstrapped` plus lock `omp-build-bootstrap.lock`. They can be rebuilt. A cold machine does not copy the marker, those caches, or a transcript. Cannot resume: unpublished commits, a result never published, an action whose effect is uncertain, a pause request without observed disarm, a local-only worktree change. Moving machines needs the same operator identity, this plugin, GitHub auth, and the project tools, then `/feature <reference>` in the intended worktree. The environment is rebuilt there, not copied. Comment edit or deletion remains an accepted risk. There is no new anti-tamper store.

The landing binding on every base is the confirmed `workflow-binding` on that PR. A closing keyword, issue body, or branch name is not landing authority.

Issue state is a scope fact, not execution authority. A closed Spec remains readable when reconstructing its bound mandate. Closing an issue neither pauses or revokes that mandate nor approves landing; a closed PR still cannot authorize another review or correction.

### Epic

An epic runs from the confirmed mandate on the epic issue, not from a session goal. `skills/feature/epic-driver.ts` reads that mandate. The installed command calls `next`, `stop`, `review`, `mark-fix`, `hook`, `report`, and `control-disarm`. There is no `objective` command and no goal file.

A ticket stop is an `epic-event` whose `event` is the historical wire name `goal-stop`. Independent children continue. A shared-state stop is an `epic-event` whose `event` is `goal-report`. The hook runs once at the current base commit; another commit is `hook-stale`. The report heading is `## Epic run`. Merged is not complete before the hook and report are observed. Delivery matching, re-disarm, and which stops retry live in `epic-driver.ts` and `epic.ts`. A run id does not reset a spent review bound.

Debt filing and epic fix-tickets spawn `bun --no-env-file` on the emitted `triage.ts`. The cwd is that file's directory, and `GITHUB_REPO` is set. Feature init imports only the emitted `migrate-labels.ts` and `init.ts`, and still binds the checkout with `defaultInitDeps(repository, checkout)`. The resolver is `triage-runtime.ts`. Paths come from that file. There is no sibling, home, or project fallback. A missing emit stays `issue-triage-unavailable` or `IssueTriageMissing`. `skill://issue-triage` remains the separate optional advisory skill, not the action runtime; it is not copied into this plugin. The generated `dist/issue-triage/` slice ships with omp-build so those actions need no separate plugin installation.

## Commands and tools

| Entry | Lane |
|---|---|
| `/feature` | `omp/index.ts` → `registerCommand('feature')` → `runInstalledFeatureCommand`. Not a skill dump. User lane. |
| `/promote` | `registerCommand('promote')`. Dumps `skills/promote/SKILL.md`. User lane. |
| `/cleanup` | `registerCommand('cleanup')`. Dumps `skills/cleanup/SKILL.md`. User lane. |
| `/ci-watch` | `registerCommand('ci-watch')`. Dumps `skills/ci-watch/SKILL.md`. User lane. |
| `/dev-review` | `registerCommand('dev-review')`. Dispatches the host-authorized native review. Not a skill dump. |
| `/fix` | `registerCommand('fix')`. Dispatches the host-authorized native correction. Not a skill dump. |
| `omp_build_start_review` | `registerTool`. Same review dispatch, model lane. Not execution authority. |
| `omp_build_start_fix` | `registerTool`. Same correction dispatch, model lane. Not execution authority. |

`registerCommand` is the user lane the model cannot call. That does not make the product slash-only: review and correction are also tools. A tool call still resolves one existing target, re-reads the bound, head, and proofs, and authorizes before inventory and dispatch. Unknown, stale, ambiguous, or already-closed PR targets stop review/correction dispatch. A skill body's `disable-model-invocation` is **not** a second gate: omp normalises it to `hide`, which omits the skill from the prompt listing while `skill://<name>` and `/skill:<name>` still reach it (omp 18.2.9). Requires a **restart** (extension module), not `/reload-plugins`.

## Records

The engine (`engine/`) owns versioned records, reference checks, conservation, counting, derived groups and verdicts, and deterministic projection. It does not judge semantics, call GitHub, or authorize a merge. Roxabi (`roxabi/`) owns the product actions: preparation, native continuation, and publication of inventories before dispatch. It keeps no local durable business store. The GitHub adapters (`adapters/github/**`, `adapters/github-workflow/**`) paginate comments, check native author and revision facts, publish, and read back. They do not classify a finding or authorize landing.

`encodeRecord` frames each canonical record with its projection. The header is `<!-- omp-build-record v=1 kind=… id=… operationId=… part=i/n data=<base64url> -->`. The payload is authoritative. The Markdown is presentation; no business reader takes a verdict, head, or input from it. A final `review` carries `candidateGitSHA` and `input` (64 lowercase hex SHA-256, or null). Projection lists the record, decision, candidate, input, findings, standards, and source provenance (contribution host plus originals). Legacy `<!-- omp-build:… -->` markers — including `code-review`, `review-head`, `review-input`, and `proof` — are `legacy-format`. They are refused, not parsed, resurrected, or reset.

Projection takes an explicit host `RecordProjectionConfig`, or null. The host supplies `{ taxonomy, acceptedPolicy }`; the candidate does not derive the taxonomy or accept its own evidence policy. Only a final `review` renders a verdict, and that projection refuses null or unknown configuration. Explicit null permits only neutral evidence, decision, and stop publication. Publishers bind that host configuration once. Decoded operations need `authority` and distinct `claimedKinds`; those claims are evidence, not permission, and missing metadata refuses. Projection follows the record's required dependencies from the original history. A foreign, missing, incomplete, or ambiguous reference refuses; it is not repaired, and an opaque record outside that closure does not acquire review authority.

Authoritative review contributions retain every captured submission in `rawAttempts` and the complete SDK terminal snapshot in `native.raw`. The downstream model-input view omits only direct `native.raw.terminal.task` and `assignment` echoes; the stored record keeps both. Human contribution text may omit `native.raw` only by citing the canonical record or operation in the frame, not by dumping it. No semantic filter, compression, or truncation is applied to these retained values.

An action result refers to its confirmed start and exact scoped mandate; it does not mint a replacement start at publication. Completion belongs to that action's exact inputs: an old Spec assessment, plan or implementation does not complete a different current action. Unresolved starts and rejected effects remain blocking even when a native PR exists or its current checks are green. The original native result remains visible when host admission rejects its effects; a schema-valid `implemented` claim is not proof that its commits were admitted or reached the remote branch.

Implementation receipts retain the unchanged terminal snapshot in `native.raw` and observed Bash captures in `native.bashCalls`. Native publication distinguishes canonical receipt retention from effect admission. Stopped observations use the same publisher before terminal settlement, without continuation or approval. Expected but unobserved child slots never mint result receipts: their original starts remain uncertain.

The current receipt contract does not persist intermediate SDK yield submissions or partial text; this migration does not silently extend that format or claim complete SDK-stream retention. The offline lifetime witnesses also do not establish actual SDK shutdown ordering or task cancellation.

Before implementation or correction effects and their pushes, the host checks the current remote mandate and controls again and honors the local interruption fence. A terminal result can still be preserved after a pause without authorizing another effect. GitHub reads and Git writes are not atomic: this is not a cross-provider lock, and it cannot guarantee exclusion of a control published after the final authority read.

Implementation commands are strict claims containing only `toolCallId`, `command`, and `exitCode`. The host retains the observed stdout, stderr, and working directory in its capture; those fields are not duplicated into the claim. Native correction commands have their own schema and still carry stdout and stderr. The selected correction proof field is `proofToolCallId`, not `selectedProofToolCallId`. Candidate `0.11.1` corrects the producer instructions and generated profiles to match these existing schemas; it does not change record formats, weaken admission, or establish model obedience.

Native `/dev-review` runs spec → panel → recall → synthesis and publishes the confirmed records. Native `/fix` uses `R-review-fix-intake` and `R-review-fix-synthesis` for a standalone request; a review-bound request instead consumes the already-confirmed decision unchanged, without new intake or synthesis. Correction uses `R-review-fix-apply` and `R-review-fix-falsify`. It does not edit inline in the orchestrator turn and does not revive the absent `R-fixer`. Correction records set `landing: false`.

Existing worktrees are entered with `/move <path>`, not recreated, and not with `/wt`. The command prints that move only when the session cwd is not the intended worktree.

In the matching worktree the installed command continues implement → review → correction → land. There is no per-PR merge approval.
`resolveReviewPr` binds an explicit number or the current branch before any
review read; lookup failure is never treated as a local review. A closed PR on
the branch refuses implicit reuse, so its bound cannot be reset. Existing PRs
resume from their review records.

Automatic review-bound correction carries the actual PR, confirmed review ID, complete accepted spec body as correction scope,
and exact scoped Feature mandate reference into `/fix`. The existing scope contract requires 1–4,000 characters:
missing or longer scopes stop instead of being truncated. The handoff reuses the existing correction permission;
a missing, different or successor mandate is refused rather than minted. It is not a new operator approval
and does not manufacture operator text.

A persisted `fix-request` proves that a request was recorded, not that its execution completed. Only the exact request confirmed by the current live invocation can be trusted for that invocation's continuation; an unresolved cold request remains a refusal. This ownership is ephemeral host state, not a new local workflow journal.

Each native correction continuation re-reads the current history and validates the originally confirmed review against it
before confirming the mandate and live request from that same snapshot. A newer review or an exhausted review bound
refuses execution of the older decision; it does not reset the bound or discard the recorded request.

The full original review input is checked at entry. Subsequent owned correction commits are checked by the existing
commit, proof and head fences, rather than requiring the local HEAD to remain the original review's HEAD.

Feature-owned PR and epic reviews check local continuation before authorization, after authorization before publishing
the inventory, and before native activation. Standalone `/dev-review` and `omp_build_start_review` remain independent
of Feature inhibition. Native Feature ownership is registered before asynchronous work and is not recreated by a stop
callback; passive diagnostics remain visible under inhibition.

An already-engaged GitHub publication is not rolled back. An interrupted inventory can remain explicitly pending:
it is not an approval, does not silently restart, and does not reset the review bound. These guards do not provide
an atomic GitHub transaction or a compare-and-set guarantee.

Review → fix record contract: [root causes and member references](skills/dev-review/root-causes.md).

### Evidence-based review and fix policy

The [evidence policy](skills/dev-review/evidence-policy.md) is not the live default.
Prepared review uses `baseline`. Correction uses `baseline` unless the caller supplies
`evidence-v1` with an acceptance reference, and debt filing accepts that reference
only when it matches the independently supplied one. A record's policy field, a test
fixture, or a passing replay does not switch the live path. The prepared review
assembler does not read policy out of existing records.

When an independent acceptance is supplied for selected later work, that policy's rules are:

- Phase 4 qualifies supported applicability, evidence, consequence and unresolved
  premises. The OMP-host Jev adapter supplies separate dimensions and per-result
  backend identity, never a severity aggregate, incident probability or authority.
  Unavailable/unusable Jev is disclosed degraded mode, not a fabricated score or
  an automatic blocker.
- Blocking status and correction permission are distinct. Selected required
  corrections and admissible optional neighbors have explicit authorization and
  coherent causal plans. An absent plan does not clear a blocker. A failed optional
  addition is safely withdrawn and the required path revalidated, or the work stops
  if separation is unestablished.
- New debt issues require **importance AND prompt necessity AND excessive scope
  for the current ticket**. Every other deferral stays only in PR comments; no
  automatic bundle. Filing never discharges a required obligation.
- Differential re-review needs its own acceptance: baseline, delta, affected paths
  and residual obligations. Missing history or impact evidence means full review
  plus explicit residual inspection. Unchanged deferrals need new grounds to reopen.
- A missed required blocker, unauthorized correction, inadmissible debt issue or
  lost residual suspends candidate use pending renewed supervised acceptance.
  Existing head/input/CI safeguards and stopped review bounds remain intact.

### Earlier review/fix qualification (T2)

The earlier T2 cohort covered actual OMP 18.12.5, a local scripted provider, a fake
GitHub, and a local bare Git. A native positive path exercised spec → panel →
recall → synthesis → canonical review, and trusted gate 0 accepted it.
Invalid-only and sequential new-head paths met their gate-1 refusal checks. A
full native fix accepted two commits, with independent proofs, falsification,
restore, a clean tree, a non-default push, and final records. Typecheck,
Biome, build, and the repo suite passed on that same cohort. This is not a
paid semantic-model campaign, not proof of review efficacy, not full cold
resume, not hosted GitHub, and not T3, T5, or merge activation. That cohort does not qualify the workflow records or the installed `/feature` graph in this tree.

### Local workflow integration qualification (T3)

A private local cohort qualified candidate `0.11.0` with actual OMP 18.12.6
and Bun 1.4.4. All 29 modes passed on one frozen product-code and fixture
snapshot, with unchanged runtime binaries. This is not an installed release.

- **Product paths:** actual installed `/feature`, native tasks, the CLI landing
  path and the independent trusted review gate. The default/non-default-base
  binding case is an explicitly seeded CLI/gate witness, not an OMP session.
- **Recovery and controls:** fresh checkouts and distinct homes without session
  transfer; two actual pause/resume cycles; abandon and explicit successor;
  wrong-child-branch refusal; unconfirmed pause refused by Feature, explicit
  review preparation, trusted CI and `landPr`.
- **Nested coverage:** seven terminal-delivery reentry cases; both Epic
  completion and child-to-parent ownership interruption; both remote-pause
  interleavings during CI attribution and correction synthesis. Original
  results remain evidence even when current authority refuses further effects.
- **Ordinary checks:** build, typecheck, Biome (183 files), isolated imports
  without dependency installation, and the full suite (87 files, 2,054 tests).
  The full suite ran without concurrent native qualification jobs.
- **Limits:** scripted local model provider, fake GitHub transport and local
  bare Git only. Required-proof exercises actual acquisition against an
  external Semctx stand-in, not semantic verification. Semctx verification
  of this worktree was unavailable (`CONFIG_NOT_FOUND`). No paid-model
  efficacy, hosted GitHub adoption, global installation or merge activation
  is established; T4 and T5 require their separate authorizations.

### C1 portable preparations and coordinator witnesses (candidate 0.11.1)

The C1 cohort passed 43 tests in four focused files with an inherited global Git
configuration that requires an unavailable signing program. The admission and
correction fixtures isolate Git configuration, inherited hooks and shell startup;
every allocated repository or remote is owned before setup can fail. A real
failing Git setup also left no allocated sandbox behind.

The affected historical landing-proof integration suite separately passed all
201 tests using its retained producer-record fixtures. This is a local replay
qualification, not a new Semctx/assertledger acquisition or hosted landing.
A subsequent preservation commit ports the principal's merge-race regression to
the actual native landing process and strict GitHub simulator. Its focused check
passed: a completed merge adds no `reviewed` label and makes no second arm attempt.

The witnesses exercise the actual `continueFeature`, `publishFeatureNativeResult`,
`consumeWatchExit`, and `requestFeatureSessionPause` bodies before their later
decomposition. They use real disposable Git, the existing strict GitHub simulator,
fresh Bun processes, distinct homes and cold checkouts. The public extension's
registered `/feature` handler uses its real source-module loader and an external
API stand-in; this is not a running OMP session. Assertions inspect durable
controls, original action bindings and refused effects, not message wording.
The CLOSED-watch case proves a stopped result, not a successful MERGED landing.

The real producer build completed. A separate runtime smoke used the locked OMP
18.12.6 agent parser and both source and distributed strict schemas. Typecheck
and Biome on the eight changed TypeScript files passed. These are not a full
suite result, a C2 deterministic-generation/parity proof, a C4 lifecycle
qualification, model-obedience evidence, hosted GitHub validation, installation
or merge activation. Semctx verification returned `CONFIG_NOT_FOUND`; no semantic
certification is claimed.

### Existing review and landing safeguards

The review bound is two automated corrections per PR (#710), derived again on every
read from complete canonical `review` records whose native author is the automation
login (`gh api user`). The count and the latest review come from that history. A
refusal is not an empty history. Nothing writes accounting. A legacy marker is not a
review and does not reset the bound.

When a bound is spent, its PR remains stopped and disarmed. The operator approves
the revised scope, diagnostic/correction plan and continuation checkpoint; Phase 8
then directs agents to perform the recovery, targeted proof and independent review
on a superseding PR. Its fresh admission still follows the normal review, proof, CI
and `landPr` path; the original dossier and records remain evidence.

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

- `nextReviewStep(cwd, pr, { ciFailed?, reviewing? })` returns `land`, `fix`, `stop`
  or `review`. The transition comes from the fresh canonical summary, not a
  caller-supplied verdict. A fix is allowed while the PR has at most two final
  reviews: the fix's push moves the head, and a latest review of another commit
  asks for a review first. A review past the second that does not approve spends
  the bound for good — a later green does not lift it. A CI failure on the head
  the third review approved stops too, and that observation is published as a
  canonical `stop` before continuation.
- `landPr(cwd, pr)` arms only when the latest canonical review approves and its
  `candidateGitSHA` equals the current `headRefOid` (both 40 lowercase hex). Records
  then head are refreshed before each arming write, including after disable/remove
  preparation. A spent bound is `not-approved` with reason `review-bound`; an
  unreadable candidate is `review-unbound`, and a moved head is `head-moved`.
  Unreadable authorization never permits arming; acquired gates use the shared exit
  policy. Native auto-merge pins that refreshed reviewed head with
  `--match-head-commit`, checked when it is enabled: a later push or base switch by
  an account with write access leaves it enabled. Merge-on-green remains
  label-driven: a later push by another actor is not refused by GitHub. A legacy
  review marker does not arm, so a PR that has only the old head line needs one
  canonical re-review before it can land.
  The selected PR base's name and tip are captured too. Each pre-arm checkpoint
  and the retained-arm epilogue re-read the base name alongside the head and
  re-fetch the base. A retarget or moved tip is `proof-blocked` / `candidate` /
  `unbound`; missing coordinates are `unreadable`. Both force clearing, never
  silently switch landing policy; re-entry captures the current base normally.
  A clean PR merges as soon as it is armed, moving the base itself: a PR whose
  merge commit's first parent is the selected tip keeps its base; merged onto
  another tip it is refused, and the disarm reports the merge.
  Each landing or acquisition attempt resolves `git remote get-url origin`
  through `gh repo view <URL> --json nameWithOwner` and requires that repository
  to match the selected GitHub repository before reading policy or applicability.
  Mismatch is `candidate/unbound`; missing/unresolved identity is
  `candidate/unreadable`, never an exemption based on a fork's absent config.
  The fetch uses that verified explicit URL, not the mutable remote name, while
  retaining the established `refs/remotes/origin/<base>` readers. Each refresh
  revalidates the identity. It selects the tip the fetch reads —
  never GitHub's `baseRefOid`, which is recorded when the PR opens, its head is
  pushed or it is retargeted, and does not follow later pushes to the base.
  Policy, declarations and merge-base consume that immutable commit, not a
  tracking ref another await can rewrite. Failed fetches refuse as
  `candidate/unreadable`. Acquisition revalidates head, base name, a re-fetched
  base tip and OPEN state before producers, every publication part and its
  final reuse/absence report.
  Proof summaries are presentation only. Admission reads the canonical `proof`
  record: `candidateGitSHA` plus untouched native JSON in `data`. The proof owner
  remains the semantic validator. A legacy `<!-- omp-build:proof … -->` frame
  cannot admit landing.
  Fresh and reused acquisition both return `semctxAssessment` in CLI JSON: the
  current shared Semctx reader's results or refusal, not landing authorization.
  Reuse preserves native proof bytes and publication metadata; an archival human
  summary may still describe the older reader's refusal.
- Then `landPr` admits that head (`admitLanding`, `proof.ts`), reading only: the
  local tip must be it; Semctx applies when `origin/<base>`, the head or the
  uncommitted `.semctx/config.json` on disk at the root and the principal
  configures it, and a PR that changes or deletes the base's committed
  configuration refuses; applicable proof records — canonical `proof` comments
  `proof-acquire.ts` publishes after the push, one per producer and head — must bind
  the repository, PR, head, base, merge base, changed contracts (at least one
  added by the head) and the Semctx configuration's sha256, and carry
  VERIFIED, or PARTIAL with each gap (every warning finding, pending evidence
  and open unknown it names) justified by a closed-enum NO TEST row in
  a PR body last edited before the approving record (an edit after it returns
  the PR to review); a PARTIAL with a stale link or a blocking impact refuses.
  A modified historical companion may retain `superseded` only when Git proves
  its file contains only its own `change <id>` block, whose sole lifecycle field
  changed from `active`, `partial` or `verified`, with one explicit preserved
  provenance matching native inspect. A neighbouring block's provenance cannot
  qualify it. Every other byte stays identical except permutation within the same contiguous run of literal
  `  link: file:<nonempty>` lines, preserving duplicates, separators and line
  endings; both source strings must round-trip to their Git blob IDs.
  Broader formatting, changed obligations or insufficient provenance do not
  qualify. The companion is still natively verified and keeps its verdict,
  unknowns and gaps; this proves conservation, not a native transmission
  relation. The added own contract is still mandatory and cannot use this
  historical exception.
  Every applicable native proof part's creation/revision facts must be readable,
  unmodified and published before approval, regardless of producer or verdict.
  A recorded edit requires acquisition again; a late publication requires
  same-head review without a producer at admission.
  A proof-aware review captures the exact body and complete selected producer
  runs before judgement and stores their digest as the review's plain `input`
  SHA-256 (`hashReviewInput`: repository, PR, candidate, body bytes and
  `lastEditedAt`, and each selected part's id, body, and native times). It
  compares again before posting. Admission compares that field with a fresh
  capture of the same bytes and native metadata, including VERIFIED and
  detection. Missing, malformed, or changed binding requires same-head review;
  a recorded proof revision still needs acquisition first. Genuine no-proof
  repositories acquire no new landing prerequisite. The digest is equality of
  observed inputs, not authentication.
  A fix PR — a `fix/…` head branch, or a closing ticket or the ticket the head
  branch names (`<type>/<N>-…`) typed Fix or Bug, labelled `bug` or titled
  `fix…:` — needs a detection only when the established base or candidate commits
  a root `assertledger.config.json` with an `adapter`; a PR whose type nothing
  establishes refuses. The bundled Kit Vitest module alone is incidental tooling:
  assertledger is `not-applicable`, not per-ticket exemption, and shell/CP fixes
  remain under CI/validate and review. An explicitly configured unsupported
  producer remains fail-closed. GitHub links closing keywords only for a PR into
  the default branch, so the named ticket is what classifies a PR into another base.
  No producer, test or model runs at landing. A refusal is
  `proof-blocked` with `producer`, `reason` and `error`, unarmed; `watching`
  reports the admitted `proof`. `proof-acquire` reuses a record that still
  binds, so an unchanged head is never re-proved. Assertledger records bind only
  `assertledger check` manifests (git provenance); no Kit Vitest `verify`
  working-tree provenance is admitted as a git-regression detection.
  Assertledger acquisition freezes the exporter bytes in an owned read-only
  private manifest before awaiting the tool, replays only that file, conserves
  those same UTF-8 bytes and native result, and removes only its snapshot in
  `finally`. An exporter rewrite cannot lend another manifest's valid replay.
  Every pre-arm checkpoint and the retained-arm epilogue re-read these inputs,
  even at the same head: body revisions, ignored configuration/access, ticket
  classification and the latest native record are not immutable with a commit.
  `landPr`'s retention never transfers an arm it wrote to a later approved
  head; CI-watch observer exits and the review step's `land` retain an arm on
  current-head approval and an unspent bound alone, and never re-admit.
- What admission does not establish. VERIFIED attests Semctx's composition over
  declared evidence statuses, never a test run. Landing's runtime-proof claim
  depends on CI GitHub actually enforces on the selected base and head.
  The existing native `no-required-checks` guard takes explicit `requiredContexts`,
  otherwise a nonempty stack `landing.required_checks`, otherwise GitHub
  protection/ruleset discovery. A supplied/declared name is not evidence of
  enforcement: an unprotected native PR can merge before that check completes.
  The watch's declared list names what it observes, not what GitHub enforces.
  The review judges each `tested` evidence's named test; nothing binds CI to it.
  Applicable producer records must be published before approval, with
  readable native creation/revision times and no recorded edit, regardless of
  verdict. A late publication needs a new review; a revised record needs
  acquisition again. Nothing ties required checks to a `tested` evidence's test.
  Under the [operator-authorized reviewer ceiling](https://github.com/Roxabi/roxabi-plugins/issues/768#issuecomment-6114046814),
  reason truth and credible browser-check performance belong to the proof-aware
  review; unsupported claims block it. Admission checks their policy/form and
  availability and exact observed input equality to approval, not those two
  truths. A row/block is form, dates show availability, the digest identifies
  the observed inputs (not who actually read them), and approval is judgement:
  none certifies an unproved gap. An invented check or false reason accepted
  by that trusted reviewer is not independently detected by admission.
  `landPr` and the pinned trusted reader used by
  `.github/workflows/auto-merge.yml` both require shared admission before
  writing their arms. The workflow refuses and disarms when its current
  gate read refuses; it does not treat a `reviewed` label as sufficient proof.
  This source change is not hosted activation: the immutable tooling pin
  and installation capabilities remain a separately authorized T5 check.
  Another actor can still enable auto-merge or merge outside these entry
  points. GitHub reads and arming are not transactional; this does not
  establish continuous enforcement or close the queued-run race
  ([#787](https://github.com/Roxabi/roxabi-plugins/issues/787)).
  A canonical record is published as one or more PR comments by the automation
  account (`part=i/n` when it exceeds GitHub's comment ceiling, read only whole).
  The header carries the record; the Markdown is the projection. Any account with
  write access can edit or delete the comment, so it attests that comment's current
  body, not what the producer printed nor who ran it. Legacy markers are refused,
  not repaired. Both producers' parts are checked for native publication and
  revision facts; a recorded edit refuses, including a PARTIAL edited into
  VERIFIED or a WEAK_ORACLE/miss edited into detection.
  The digest is not a signature or lasting pin. GitHub reads, the review post
  and arming are not one transaction; `landPr` re-reads the inputs only at its
  own checkpoints and on re-entry, so a change after its last read goes
  undetected while observers retain the arm.

The bound guards against agent mistakes, not against an agent that bypasses it:
records by other accounts are ignored, and edits or deletions of the account's
comments are not detected. Every posted review counts, with or without a fix
before it. Older accounting comments and the `## Review Fixes Applied` receipt
decide nothing.

The canonical choices and escalation dossier live in `skills/dev-review/SKILL.md`
Phase 8. `continueFeature` → `reconstructWorkflow` selects the next Feature lifecycle
action. `nextReviewStep` retains specialized PR review/bound policy; `landPr` and
`applyCiWatchExit` retain guarded landing/watch execution, with shared
`requireLandingMandate` admission at actual landing. Explicit standalone review
and autonomous correction keep their separately admitted paths; neither grants
landing authority. The feature skill is reference material, not another router.

Landing resolves mode from `readLanding` on the PR base ref (`origin/<base>`): stack `landing.mode`, else
`merge-on-green.yml`, else native. It returns the absolute `/ci-watch` command,
including GitHub's fresh labeled-event time under merge-on-green. Native also
enables auto-merge. An OPEN `BEHIND` observation stops further arming and watching:
`landPr` returns `behind` after clearing known OPEN arms, including a pin written
earlier in that call. A failed clear throws naming the remainder; a merge during
the clear returns `merged`. The watch exits 7, and its mapper uses the same behind
contract (`applyCiWatchExit` in `skills/feature/workflow-watch.js`). Both name `gh pr update-branch <pr>`;
omp-build never updates the branch itself. `applyCiWatchExit` preserves watch statuses while enforcing
gate authorization; `disarmReviewedBeforePush` in `skills/feature/landing-foundation.js` confirms clearing before invoking
the push once, and reuses that receipt if the callback fails. Neither review nor
fix labels a PR. No duplicate spec files or `validated` gate.

The trusted auto-merge checkout (`.github/workflows/auto-merge.yml`) reads canonical records only from tooling pinned by repository variable `OMP_BUILD_TOOLING_SHA` (40 lowercase hex) and attributes them to `OMP_BUILD_AUTOMATION_LOGIN`. A missing or non-hex pin refuses. There is no fallback to the candidate checkout, the workflow SHA, a moving branch, candidate code, or a dependency install; the pin's committed `dist/contracts.js` is the reader. Dependabot keeps its existing semver-major exception and does not require that human review record. The pin is the T5 activation variable. Its absence is a refusal, not an activation.

T5 capability check, separately authorized, not done in this tree. The gate reads with the App token (`GH_TOKEN: ${{ steps.app.outputs.token }}` in `.github/workflows/auto-merge.yml`), not the job `GITHUB_TOKEN`. Job `issues: write` does not apply to that token ([workflow permissions](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions) cover the job token only). The reader must be able to read issue bodies, comments, and each explicit parent scope: `GET /repos/{owner}/{repo}/issues/{issue_number}` and `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`, through `review-gate.ts` → `currentLandingMandate`. Applicable App permission for the body route is Issues: read; Pull requests does not cover it ([App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)). Comments are also listed under Pull requests. Live installation permissions are unverified. Do not claim they are missing, and do not change the token or the installation from this tree. This is not a new tamper control.

That capability check must also exercise the trusted gate's selected-base Git fetch, including private-repository access when applicable. Its process-local credential helper does not persist credentials. Local transport smoke coverage does not prove the hosted App can fetch that base or read all referenced scopes.

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

## Worktree bootstrap

`skills/feature/worktree-bootstrap.sh` is the script contract. `runWorktreeBootstrap` in `roxabi/workflow-checkout.ts` runs it in the foreground after worktree identity is valid and before dispatch: on `/feature new` before the successor publish, on the first mandate, and on select, resume, or new in an already valid worktree. It refuses the principal. The marker `omp-build-bootstrapped` and lock `omp-build-bootstrap.lock` are environment cache, not business records. `/feature init`, `prepareFeatureCheckout`, `session_start`, and `agent_start` do not run it. Do not shell it out as a second process.

- The script holds a lock in the git dir, so repeated explicit calls wait for a running invocation and then no-op.
- ccc's `settings.yml` lands before `worktree.setup`, so ccc never indexes an ancestor directory while an install runs.
- Worktree lists and setup scalars are read with Bun.YAML (Bun ≥1.2.21) before any transfer or indexing. Flow/block string lists agree and `[]` means no transfer. Invalid YAML or consumed list types fail with the stack filename, leave no completion marker and release the lock. A non-empty `worktree.setup` runs as a Bash snippet; absent, empty or whitespace-only setup falls back to the file declared by `commands.worktree_setup`, from the worktree root. A failed setup also stays retryable. `feature init` preserves a declared setup command instead of adding an empty override. Cleanup uses the same YAML parser for the principal's `worktree.base`, preserving environment > stack > default precedence and quoted/block scalars.

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
Correction does not revive `R-fixer`. `/fix` and `omp_build_start_fix` dispatch the native profiles `R-review-fix-intake`, `R-review-fix-synthesis`, `R-review-fix-apply`, and `R-review-fix-falsify`.

Resolution when a spawn passes no `model`: explicit call model, then `task.agentModelOverrides`, then this frontmatter, then the active parent. An operator override for an agent masks the manifest role until it is removed. A role alias in an override expands through `modelRoles`, `@default` included, and OMP uses the override only when that expansion yields at least one model; otherwise it skips the override and reads the frontmatter. `R-devops: "@default"` therefore pins the configured `modelRoles.default`, not the parent's live model, and has no effect while `default` is unset. In omp 18.8.0 the parent's active model is taken by a per-call `model` entry `@default`, a single-entry frontmatter `@default`, and a single-entry frontmatter `@task` while `modelRoles.task` is unset: `R-devops` and `R-tester` run the parent's model until the operator maps `task`. The two-entry `@review, @slow` never takes that path; only the credential fallback above reaches the parent. The dev-review spawn template passes no `model`, so it does not defeat these declarations.

## Skills

| Skill | Lane |
|---|---|
| `feature` | Installed `/feature` command. `SKILL.md` is the reference, not a dumped lifecycle. |
| `dev-review` | `/dev-review` and `omp_build_start_review` · native spec → panel → recall → synthesis |
| `fix` | `/fix` and `omp_build_start_fix` · native correction profiles; not an inline walk |
| `promote` | `/promote` (registered command) · the optional tail |
| `cleanup` | `/cleanup` (registered command) · the optional tail |
| `ci-watch` | `/ci-watch` (registered command) · watches checks, then the merge |

`dev-review` and `fix` dispatch native pipelines, not an inline Markdown walk. Baseline still applies blocking causes and defers non-blocking causes to one sibling issue; `evidence-v1` uses selected correction authorizations only when an independent acceptance reference is supplied. An admissible follow-up keeps its origin parent's complete `OWNER/REPO#N` coordinate, never a number reconstructed under the origin repository; an absent parent keeps it top-level. They read their own bundled files through `skill://dev-review/<file>`. `lib.sh` is the exception: it sits one level up, in a non-skill directory, and `skill://` rejects `..`, so `dev-review` Phase 1 traverses from `$SKILL_DIR` instead. **Nothing in this plugin exports `SKILL_DIR`** — only the registered commands print a skill directory (`omp/index.ts`) — so that fence asserts the variable (`${SKILL_DIR:?…}`) and stops when it is unset, rather than sourcing `/../shared/lib.sh` and detecting a base branch against nothing. `cleanup/analyze-branches.sh` has no such problem: it is a script, so it resolves `../shared/lib.sh` from its own `BASH_SOURCE`.

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

**The names are deliberately not `R-dev-review`/`R-fix`.** Skill discovery dedups by `name` across every provider, first-wins. `dev-core` is archived and is not an installable sibling. Snapshotted agent bodies still call the workflow `/R-dev-review` in prose; that is a label, not an invocation, and the dispatch prompt in `skills/dev-review/SKILL.md` is the contract they actually obey.

## Maintenance

Lint-only fixture changes must preserve the emitted shell text and cleanup/release safety behavior, not replace executable checks with source-text assertions. Publish OMP changes with matching, newer versions in `package.json` and `.omp-plugin/marketplace.json` so the version-keyed install cache is refreshed.

### Canonical source ownership

| Responsibility | Direct source owner |
|---|---|
| Record values, shapes and construction | `engine/record-values.ts`, `record-schema.ts`, `record-construction.ts` |
| History integrity, conservation and review decisions | `engine/history-*.ts`, `review-*.ts` |
| Deterministic human projection | `engine/record-projection.ts` |
| Workflow authority, spec continuity and reconstruction | `engine/workflow-control.ts`, `workflow-*-admission.ts`, `workflow-accepted-spec*.ts`, `workflow-plan-macro.ts`, `workflow-action-completion.ts` |
| Installed public contracts | `contracts.ts` is the actual flat distribution entry; consumers load generated `dist/contracts.js` |

Source callers import the canonical owner directly. Removed engine aggregate paths have no compatibility re-exports. The engine and GitHub adapters compile together inside the contracts bundle; they never import a previous generated bundle. Installed Roxabi/OMP/skill consumers use that bundle for engine runtime values and type-only source imports for canonical types, so catalogue installation does not require the repository's development dependencies.

| Product boundary | Canonical source owners |
|---|---|
| Review, correction and standalone fix | `roxabi/review-contract.ts`, `review-dispatch.ts`, `correction-plan-*.ts`, `fix-entry-{lifecycle,ci}.ts` |
| Feature coordination | `roxabi/feature-contract.ts`, `workflow.ts`, `feature-result.ts`, `feature-watch.ts` |
| GitHub history and publication | `adapters/github/`, `adapters/github-workflow/` |
| Native OMP capture, settlement and lifetime | `omp/review-runtime/`, `omp/omp-controller.ts`, `omp/omp-feature-session.ts` |

The Feature contract has four operations: continuation, native-result publication, watch-exit consumption, and session pause. Native completion and watch exits use their own operations rather than unused fields on continuation input. This internal contract cleanup does not reset review bounds or grant landing authority. CLI and trusted CI still apply the common admission contract through their concrete entry points.

The review class catalogue has one source: `skills/dev-review/review-classes.yml`. The aggregate plugin validator checks that this complete asset is readable UTF-8, valid YAML and non-empty; it no longer compares an obsolete second list or pair-rule paragraphs in the skill. Native panel and recall tasks receive the canonical catalogue itself. This preserves guidance delivery, not proof that a model obeys subsumption rules; final labels remain model judgments, not classifications repaired by the engine.

### Test ownership

Generic record mechanics live in `testing/record-*.ts`; generic workflow records and actions live in `testing/workflow-fixtures.ts` and `testing/workflow-actions.ts`. Product scenarios select the shipped Roxabi graph explicitly through `testing/roxabi-presets.ts`; it is not a hidden default in the generic workflow builders.

Engine behavior families live in `engine/__tests__/` and `testing/workflow-decision-cases/`. Their shared support arranges inputs and external boundaries, without re-exporting the product under test. Expected consumer-visible outcomes stay in the scenarios, outside model inputs. Process-spawning scenarios retain the `*.integration.test.ts` suffix and owned resource cleanup.

Feature domain simulators and subprocess harnesses live in `skills/feature/testing/{gh-simulator,epic-driver,goal,proof-integration}/`; cross-boundary SDK and recovery drivers are named explicitly in `testing/feature-*.ts` and `testing/native-review-driver.ts`. They arrange external state and invoke the real canonical product owners, rather than implementing alternate admission. Proof acquisition itself remains runtime code, not fixture support.

Retained native data stays in `skills/feature/__fixtures__/proof/{records,historical.records}.json`. Raw-byte retention, conservation through the current codec, and acceptance of original historical wire framing are different claims: re-encoding retained data alone does not prove that the original framing was accepted.

### Quality contract

Run `bun run quality:omp-build` for the same owned-source check used by the pre-commit hook and CI. Physical discovery feeds both the line counter and the pinned Biome command; warnings fail, and an empty lint set is not success.

Vitest bounds concurrent test files globally at `min(8, max(1, availableParallelism() - 1))`. Both inline projects inherit the root value and share the default group, so the cap contains aggregate process and I/O pressure rather than excepting a single scenario. It preserves the installed non-watch default on runners with 1, 2, or 4 available CPUs; the unit 5s and integration 30s budgets remain unchanged.

| Surface | Enforced limit |
|---|---|
| Runtime code, helpers, types, schemas, live configuration and exclusive omp-build tools | 300 physical lines |
| Genuine executable assertion scenarios, not arbitrary files named as tests | 600 physical lines |
| Every owned JavaScript-family function, including CommonJS and scenarios | Cognitive complexity 15 |
| Focused tests | Error |
| Runtime TypeScript promises | Floating and misused promises are errors; declaration, scenario and test-support roles are excluded |

Generated distribution files and retained inert data are distinguished by their actual ownership/provenance, not a blanket test-directory exception. Other plugins and shared root controls are outside these new caps. Parser and AST types are pinned at `8.0.8`, Biome at `2.6.2`; no effect runtime, database or workflow framework is introduced.

### Owned distribution (candidate 0.11.3)

`agent-sources/*.md` holds the seven authored generic agents. The producer copies them byte for byte and derives native profiles from `roxabi/native-*-profiles.ts` and the existing strict schemas. Tests and support stay outside the generated surface, in their owning engine, product, adapter and testing trees.

The single producer, `tools/build-omp-build-contracts.ts`, owns all of `agents/**` and `dist/**`, including the existing issue-triage runtime slice. Do not edit these outputs. Its inventory comes from successful writes and Bun build outputs, not a second list of expected artifacts. Duplicate output claims and incomplete build metadata fail. A normal build never purges the candidate or its dependencies; stale outputs remain visible to verification.

1. Use the exact producer Bun version in the repository's `.bun-version` and physical dependencies installed from the frozen lock:

   ```bash
   bun install --frozen-lockfile --backend=copyfile
   bun run build
   ```

2. Commit the matching sources, configuration and complete generated `agents/**` and `dist/**` surface.
3. Verify that committed candidate:

   ```bash
   bun run verify:omp-build-distribution
   ```

The verifier snapshots the physical candidate before reconstruction and never repairs it. It binds producer/verifier sources, `.bun-version` and `bun.lock` to HEAD independently of Git index flags, checks the static import closure and physical dependencies, rebuilds A from the actual checkout, and clones B at that same commit with its own frozen physical installation. Separate producer processes load their own checkout's modules. Only their fresh temporary output destinations vary.

Verification compares complete inventories and raw bytes: candidate = A = B, with candidate and untouched B distribution also bound to HEAD. Comments are not stripped. Modified, missing, untracked/ignored, orphaned or path-dependent outputs are refusals, not approvals. Negative probes exercise the actual verifier CLI and producer only in owned temporary copies; cleanup covers success and failure. CI runs the same verifier before consumer checks; its existing draft-PR skip is unchanged and is not a CI validation.

This is a distribution proof, not evidence of model judgment, hosted landing, installation or activation. It changes neither review records nor execution authority, bindings, bounds or approvals.

Catalogue installation copies the plugin subtree; it does not install npm dependencies. Runtime consumers therefore use the shipped common bundle, which includes Zod; the root development dependency is needed to build it, not to run an installed plugin. No separate npm or issue-triage plugin installation is required.
