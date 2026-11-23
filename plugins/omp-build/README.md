# omp-build

OMP-only delivery plugin. `/feature` prepares a leaf UW and hands the session instructions to implement, review, correct, merge and finish it. A session `/goal` grants no delivery authority.

Not a Claude/Grok factory — does not invoke host `/dev` or dev-core Skill() children. This source tree alone is not proof of an installed or activated release.

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

**Check the loaded surfaces.** A loaded extension does not prove that skills and agents were discovered. If they remain unavailable with the `claude-plugins` provider disabled, add the stable `node_modules` symlink to `extensions:` in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/plugins/node_modules/omp-build
```

After a marketplace update or install, **restart** OMP — do **not** use `/reload-plugins`; agents and extension modules are not picked up otherwise.

Keep this package's existing **legacy** layout: no `plugin.json` at the package root. Migrating discovery providers requires separate host-loading verification; it is not part of repository cleanup.

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

The installed extension registers `/feature` and hands off to its installed `skills/feature/SKILL.md` after admission. Do not install a separate copy of the skill; it can shadow the plugin.

### After you change the plugin

| Change | Pick up |
|---|---|
| `skills/`, `commands/`, MCP config | `/reload-plugins` |
| `hooks/`, `omp.extensions`, **new/changed generated `agents/*.md`** | **restart** OMP session |
| `agent-sources/`, native profile/schema sources, issue-triage helper source | `bun run build` from the repo root regenerates the distribution. Commit matching sources and generated files before distribution verification. Install does not run the build. |
Symlinking into `~/.omp/agent/agents/` is not supported — use `link` (or the catalog install armed by `extensions:`) + restart.

## Process

The thin `/feature` handler resolves the issue, manages framing and operator controls, selects or establishes the applicable mandate, and prepares the canonical worktree. When ready, it sends the installed [feature instructions](skills/feature/SKILL.md), the skill directory, and `## Feature context`: repository, issue, mandate, branch, base, worktree and the bound open PR if observed. A bare skill read grants no delivery authority.

`/promote` prepares the technical changelog and any existing user-facing release source together; its [release-artifact procedure](skills/promote/references/release-artifacts.md) defines discovery, sourced N/A and the pre-finalize and post-deploy gates.

| Stage | Session action |
|---|---|
| Resume from facts | Compare local, remote and PR tips with the selected base. Match PRs across states by repository, branch and base; confirm the canonical binding. Preserve dirty files and existing commits. A fresh checkout recovers only published work. |
| Plan and implement | Map each accepted criterion and invariant to code and a targeted check. Implement what is missing, verify the exact committed tip, then use `push` and `open-pr` from the [trusted delivery CLI](#trusted-feature-delivery-cli). |
| Review and correct | Follow the installed `/dev-review` and `/dev-fix` instructions without nested slash commands. Review every new head independently. Stop after two automatic correction rounds per invocation, or earlier if scope conflicts or progress stalls. |
| Land and finish | Observe the exact head, base and required checks. `land` makes one head-pinned merge attempt under the base ruleset. An already merged bound PR goes straight to `finish`, which closes the UW through `closeLinked` with its delivery proof. |

Re-running `/feature` re-observes Git and GitHub, not native receipts or callback state. It does not lift an explicit pause. Stop on ambiguous, divergent, closed-unmerged or uncertain delivery until the facts are reconciled. [Parent delivery is suspended](#parent-uw-delivery).

### Controls

`parseFeatureCommand` is the word list. Routine transitions do not ask again; explicit material and interruption decisions require their genuine operator confirmation. There is no per-PR merge approval.

| Command | Boundary |
|---|---|
| `/feature <reference>` | Publishes or reuses the applicable leaf mandate, then hands off to the composition instructions. Re-entry re-observes Git and GitHub. |
| `/feature resume <reference>` | Checks the runtime version and effective configuration before resuming an ordinary confirmed pause. The mandate's pinned review requirements remain in force. A review-bound or safety stop is not a pause. |
| `/feature pause <reference>` | Inhibits local continuation and publishes the control. Confirmed only after observed disarm. |
| `/feature abandon <reference>` | Revokes the selected mandate, including when that mandate has its own confirmed pause. No automatic renewal. |
| `/feature new <reference>` | Explicit successor over the authenticated own abandoned mandate tip. It names the antecedent, publishes `select-successor` and preserves a compatible existing PR. Historical framing is not current authority, ancestor revocation is not own abandonment, and `/feature <reference>` never renews a mandate. `new init` is this control, not init. |
| `/feature material-decision <reference>` | Opens the genuine operator-confirmation route for the exact authenticated material or unknown assessment. An `accept`/`reject` argv suffix is not authority and is refused. `/uw accept-material` uses the same acceptance chain. |
| `/feature resolve-interruption <reference> [--start <recordId>]` | Retained recovery for an exact native START. Requires compatible runtime, an own confirmed pause, current-process no-admission proof and genuine confirmation. Success remains paused. |
| `/feature init` | Preview of the invoking checkout. Not a subject, not framing, not a mandate, not a native task. |

The retained interruption control covers native `plan`, `plan-review`, `implement`, `integrate`, `assess-spec` and `attribute-ci` starts, not the separate review-replacement or fix protocols. Closure before admission counts only after a fenced stop and confirmed terminal RESULT. Missing, conflicting or already-admitted dispatch evidence refuses resolution, including after restart. A stop request, missing result or human attestation is not proof.

Resolution rereads causal history, runtime and exact dispatch evidence before publication. It proves no native child dispatch, not absence of earlier preparation or root-turn effects; it does not reconcile effects, adopt commits or roll back preparation already performed. Ordinary subsequent admission owns fresh checkout and code checks. Invalid terminal output, ordinary context-negative results and malformed legacy history remain blocking; an invalid legacy START is not bypassed by an abandon record.

Explicit leaf succession retains compatibility checks for accepted obligations and ordered inherited references. Parent delivery and parent succession via `/feature` are suspended.

An existing PR is not automatically replaced:
- Complete own-UW PR facts are collected even when ordinary terminal-state observation omits that scope. Their commitments must survive bootstrap unchanged. Closed, ambiguous, mismatched or unproved bindings stop before publication. Compatible open or merged requests retain their identity; native facts and authenticated binding parts are rechecked before later writes. Publication is sequential, not atomic: a later refusal may retain the new Mandate or selection control, without rollback or automatic replay.

Initial free text and eligible unframed issues enter assisted framing before checkout. The human presses `ctrl+alt+u` to open the staged proposal, not to approve it. `Confirmer` alone authorizes it; `Refuser` discards it, while Escape or `Plus tard` closes without a decision and leaves that exact proposal available to the same shortcut in the same live session and location. After a completed framing, when a move is needed, the human runs `/move <path>`, observes its success and presses `ctrl+alt+u` from the fresh destination to attest it. The same UW continues without retyping the command; checkout preparation is not relocation or a Mandate. The model's read-only `omp_build_framing_submit` tool cannot confirm or attest. Existing resume and successor controls retain their checkout guards. There is no `/wt`. `/dev-review` and `/fix` do not grant landing.

The confirmation starts on `Plus tard`. Tab/Left/Right selects an action, Enter activates it; C confirms, R refuses and Escape defers. Up/Down/PageUp/PageDown scroll the summary; D toggles the captured JSON, digest and detail reference. Supplied values are quoted with visible line-break and bidirectional-control escapes, without changing the prepared payload. Wrapped continuation rows retain a `| ` marker even when their origin has scrolled away.

Select, resume and new retain the `session-cwd` checkout guard and may stop with `principal-dispatch-refused`; move the session with `/move <path>` as directed.

During intake and framing the read-only gate covers the root extension instance and refuses new task spawns; it does not gate subagents or background jobs started earlier. Hiding a generic confirmation during `/feature` intake is not classification: that gate remains until the decision allows classification or the command is replaced/revoked. The held proposal remains available through `ctrl+alt+u`. USER-attributed entries are not authenticated against other extensions; final approval still requires human confirmation. First words `new`, `pause`, `abandon`, `resume`, `material-decision`, `resolve-interruption` and `init` are parsed as controls, not framed as free text.

The retiring native runtime awaited a durable pause for a pausable owner on detected mid-turn interruption, session switch or shutdown. A local interruption is not a confirmed mandate pause. For composed delivery, use `/feature pause` or `/feature abandon` to record an operator stop. A write already started is not rolled back by local interruption.

Interactive `/feature` and `/uw` confirmation capabilities are bound to their root command: ordinary idle settlement preserves an open confirmation; root abort, session switch, shutdown, or command replacement invalidates it. Escape or `Plus tard` keeps that exact proposal pending. `ctrl+alt+u` reopens it in the same live session and location and does not approve it. A command that was not deferred this way still requires explicit re-entry.

A valid command receives an immediate UI acknowledgment before ports and long remote reads, plus persistent phase status. The shortcut explains preparation, a queued or already-open confirmation, a reopened proposal, an action already applying, or the absence of a confirmation here. It does not prepare or confirm again. A stopped capability cannot roll back an action already started: its feedback is replaced with that warning and retained until the action settles, without vetoing a genuine live successor framing owner. Only its own status is removed; cleanup does not reannounce another command. A predecessor's delayed stop signal cannot revoke its successor.

Neither the shortcut, the default action, nor closing the dialog approves. omp-build 0.21.9 is a manual source change: it is not an activation, tooling pin, installed-cache upgrade or permission to continue a suspended witness.

Workflow history reads revalidate comment pages with GitHub (`If-None-Match`). A `304` confirms the retained in-memory page and does not charge the primary rate limit; a failed request never returns that copy. Unavailable observations retain their refusal diagnostics rather than being treated as empty history.

Late `/feature` and generic root `/uw` command reports, their UI notifications and command-result records stay bound to the original session and agent, live cwd, session file, manager artifact mapping, actual report directory and command ownership. Current failures before or after a held confirmation are reported once; a newer command suppresses the old in-flight command report. An admitted framing handoff keeps only that exact lease's command-reporting permission; controller-owned framing journals retain their existing storage lifecycle. A confirmed choice is not proof that the domain operation published successfully.

The retired Feature flow advanced from native results and CI-watch exits. Composed `/feature` has no delivery callback or background delivery watch. It makes bounded read-only check observations and stops for re-entry when needed. Standalone `/ci-watch` and the retiring native review/fix runtime retain their own operations.

Spec assessment receives the exact accepted and proposed canonical snapshots together with their original raw bytes, tier and accepted-child commitments. Its original classification stays in the action result. Additions/removals of criteria, invariants or exclusions, and tier/accepted-child changes are mechanically material; a stable-ID rewording still receives semantic editorial/material/unknown judgment. Material or unknown acceptance requires a real operator decision bound to that exact assessment and proposal. Declining publishes no acceptance and grants no continuation or landing authority.

### Init

`/feature init` and `/feature init --dry-run` are the same preview. The host captures `git rev-parse --show-toplevel`. A failed capture stops and does not frame. Otherwise it runs `bun --no-env-file <plugin>/skills/feature/feature-init.ts --dir <that root>` with Bun's cwd set to the script directory, and forwards only the operator's tokens. It does not add `--approve` or `--operator-approval`.

Tracker planning uses the repository and checkout selected by `--dir`; importing the tracker does not require repository discovery from the installed script directory.

The preview prints proposed stack additions, conflicts, the tracker plan, and a digest, then `digest is not authorization`. A printed digest is not an init reference. Explicit apply is the operator's own `/feature init --approve <digest> --operator-approval '<reply>'`. The CLI refuses a digest used as the approval text. `skills/feature/SKILL.md` states the rest of that boundary.

### Storage and recovery

Three parts, one plugin, no second runtime, no database, and no mandatory local business workflow store. Local environment caches are separate and reconstructible.

| Part | Owns | Does not own |
|---|---|---|
| Engine (`engine/`) | Canonical records, reference/conservation checks, bounded traversal from confirmed histories and landing-mandate admission | Semantic judgement, GitHub calls, merge |
| Roxabi (`roxabi/`) | Feature admission, mandate and worktree preparation, UW operations and retiring native product paths | A project-defined graph or an admission override |
| GitHub adapter (`adapters/`) | Complete comment history, confirmed publication, scope reads | Finding classification, landing permission |

GitHub comments hold `mandate`, `spec-identity`, `operator-control` and `workflow-binding` records. Retained native history also includes `action-receipt` (including START/RESULT from the retired Feature flow), `epic-event` (retired parent delivery), and `review`, `correction`, `review-interruption` and `review-replacement-grant` (retiring native review/fix and recovery). Mandates use `omp-build-mandate/4`, Spec assessments `omp-build-spec-assessment/3`, action receipts `omp-build-action-receipt/2`, and reviews carrying input `omp-build:review-input/4`. Incompatible formats, obsolete payload fields and the removed `kind: 'proof'` refuse explicitly. Historical decoding does not grant current authority or imply migration.

Trusted complete workflow records, including retained action receipts, require readable UTC native creation/revision facts on every part, with `updatedAt === createdAt`. Missing or unreadable facts refuse as `record-unreadable`; a revised part refuses as `record-edited`. Foreign observations remain readable but never become authoritative. Foreign copies cannot veto authenticated candidates by reusing their identifiers; missing, conflicting or damaged expected-author records still refuse.
Correction checkpoints and review recovery authenticate their own records; foreign claims remain observable without vetoing authenticated evidence, while incomplete or conflicting expected-author evidence still refuses.

Cause state is durable on its original UW: `cause-disposition`, exact-confirmed `cause-operation`, sister-only `debt-receipt`, and `report-promotion`. A newly published review explicitly references its complete dispositions through `causeDispositionRefs`; omitting that field cannot select historical semantics at a live admission gate. Historical verdicts remain diagnostic records, not fresh approvals. Admission authenticates the referenced decision, action inputs, accepted Spec and cited observations before a successor can release a hold.

Cause resolution uses the complete authenticated causal history and the catalogue pinned by each producing action, not the currently installed catalogue. The host supplies an immutable table derived from exact pinned bytes, retaining per-pin failures; missing, conflicting or invalid evidence refuses rather than inventing a class. The full causal context resolves references but does not enlarge the selected mandate, parent or execution authority.
Cause-wait projection discovers cause histories from expected-author claims, including incomplete or invalid claims; a foreign-only cause claim does not trigger that projection. Independent review and causal validation still apply to their own authenticated evidence and context.

External citation loading authenticates external scopes without promoting the raw primary observation to external authority. Incomplete or interrupted primary history remains available for diagnostics, but still refuses review approval; an unreadable, edited or forged external source remains invalid.

Publication treats supplied external histories as scope seeds and refreshes the required evidence at each pre-write and post-readback boundary; an idempotent publication is validated against current evidence too. A failure before the first native history read reports no observed history (`null`), not a fabricated empty history. Report promotion can authenticate retained archival evidence without granting current delivery admission. Parent insertion uses a bounded fresh parent-engagement read, not an expanded causal closure.

Removed integration configuration is not read during adoption, worktree start, review-input capture, or landing.

The committed `.dev/stack.yml` at `refs/remotes/origin/<base>:.dev/stack.yml` supplies `review.additional_requirements`, recorded as `effective.additionalRequirements` on the mandate. An absent or null list means none. Working-tree edits are not that snapshot. `review.graph`, `review.workflow` and `.omp-build/workflow.json` are not Feature configuration routes.

The accepted Spec, live mandate and confirmed binding establish authority; current Git and GitHub facts determine what work remains. A goal, transcript, local session file or bootstrap marker is not authority. When an effect is uncertain, observe before writing again. Retained native START/RESULT records remain readable for their original action and eligible recovery, not as the composed delivery cursor.

The landing binding on every base is the confirmed `workflow-binding` on that PR. A closing keyword, issue body, or branch name is not landing authority.

Issue state is a scope fact, not execution authority. A closed Spec remains readable when reconstructing its bound mandate. Closing an issue neither pauses or revokes that mandate nor approves landing; a closed PR still cannot authorize another review or correction.

#### Interrupted native review

Recovery for retiring `omp_build_start_review` is three explicit write-approved host actions, each with `{ "pr": <number> }` in the PR's worktree. Composed `/dev-review` does not use these tools.

| Tool | Confirmed effect |
|---|---|
| `omp_build_terminalize_interrupted_review` | Publishes a neutral interruption for the unfinished initial PR inventory after reconstructing its historical mandate, binding and input. No verdict or review tasks. |
| `omp_build_grant_review_replacement` | Captures fresh review inputs against the verified current binding and grants one replacement. No review tasks. |
| `omp_build_replace_interrupted_review` | Recaptures those inputs, confirms the exact linked inventory by remote readback, then activates and announces its native review batch. |

Historical inputs need not equal the fresh grant's inputs. Replacement inputs, head and binding must equal the grant's freshly verified values. Roots and publication identities are derived from the recorded chain, not supplied by the caller. A confirmed linked inventory consumes the grant once; a transport acknowledgement alone does not. Incomplete, conflicting or unauthenticated evidence refuses progression rather than minting another attempt.

The interruption, grant and unfinished replacement all leave ordinary review/correction progression stopped. A genuine completed replacement verdict re-enters normal review/correction accounting with all historical bounds and stops retained. An interrupted replacement needs a new human checkpoint; these tools do not grant a third recovery, a new review bound, a mandate succession or landing permission. An uncertain publication must be reconciled against native history before retrying; restarting the host does not refill the allowance.

### Criterion delivery and action inputs

For composed `/feature`, the session maps accepted criteria and invariants to code and targeted checks, verifies the committed diff, and commissions independent review of the open PR head.

The retired graph wrote criterion-ID plans and implementation receipts. Each receipt accounted for every criterion at its exact code version, with evidence or an explicit unverified reason. The action-input and evidence rules below describe retained native records and retiring native review/fix paths, not the composed Feature cursor.

Execution ownership is the full scoped mandate reference, not the accepted Spec's `sourceAccepted` identifier. Editorial or material Spec succession does not silently replace that owner. PR reviews reconstruct it through their pinned workflow binding; parent-range reviews without a PR use their unique authenticated own-UW mandate payload pin. Both preserve the separate exact accepted `OwnSpecRef` and version vector. Initial inventory subjects, manifest subjects and record scopes must agree; a PR inventory cannot downgrade to the unbound parent-review path.

| Evidence method | Required observed material |
|---|---|
| Test | Original command, completed exit status and observed output, plus an explicit assertion identifying the version actually exercised. Native `sdk-view` output is the SDK-presented view, labeled potentially or known incomplete—not complete/raw process output. Review must independently establish that the observed material suffices for the criterion; necessary omitted material remains unverified. Host Git boundary samples and the directory probed are context, not execution attestation. Combined output remains combined; separate streams require actual separate observation. Empty observed output is valid; mutable artifact files or printed artifact markers cannot authenticate missing output. |
| Prompt observation | Scenario, observed result and durable supporting references. |
| Manual interface observation | Steps, address, observed result and durable supporting references. |
| Content reading | Pinned references and a finding, admissible only for content criteria. |

Review judges truth, applicability, actual code linkage and demonstrated bug restoration. Each examined test needs independent support for its exact after-run version assertion and, when recorded, its before-run assertion; observations need explicit support for their candidate-version relationship. Matching Git endpoints, a printed SHA or an exit-zero result alone never establish execution linkage. Missing, unknown or unsupported linkage cannot satisfy a criterion. Mechanical policy authenticates the exact evidence and review subjects, enforces coverage and resolves references independently of finding count and tier; it does not establish the semantic truth of the reviewer's judgment. An exclusion must identify the exact accepted version and excluded additional work; it cannot waive an accepted criterion, introduced regression, security defect or invariant violation.

#### Portable manifest versus local integrity

The durable manifest identifies the effective Spec, selected delivery data, code head/base, applicable configuration and the exact repository, installed-plugin and expanded-context references supplied. Pinned file digests describe Git-object bytes. Installed plugin files must match their immutable source pin; a package version, cache directory or consumer HEAD does not establish that provenance. Missing pin, mismatched bytes or unreadable required references refuse rather than falling back.

Set-valued manifest references use identity-stable canonical ordering: equal identities retain their input order, including conflicting digests, while duplicate/conflicting references still refuse validation. Identity keys are computed once per entry within each nontrivial sort. This same-call computation does not cache source observations or change fingerprints, receipt validation or fresh authorization/readback cuts.

For `assess-spec` and `attribute-ci`, the manifest also carries purpose-tagged exact operands. Assessment binds the authenticated accepted own Spec and the observed proposal, including their snapshots, tiers, children, identity references and mechanical delta. CI attribution binds the candidate, PR scope and observed native failed-check identities, names, conclusions and evidence digest; status evidence does not imply diagnostic logs. The request supplies an expected observation, not acceptance authority: preparation reconstructs and checks it against current sources. Missing or inconsistent operands refuse. Their canonical identity excludes descriptive raw-source edit timestamps, while retaining the substantive comparison and evidence.

The Instantané projects those manifest operands into `action/exact-inputs.json`, indexed as accepted and proposed states or CI failures. That file is local material, not a second authority; the prepared operands bind the action receipt and are reconstructed on replay.

Remote catalogue batching requires the configured reader to support GitHub's [GraphQL Blob content fields](https://docs.github.com/en/graphql/reference/git#blob) and REST Git-object reads. Text bytes must match the declared size and pinned Git blob SHA before the existing per-reference SHA-256 checks. Binary, indeterminate-encoding and known-truncated blobs use the pinned remote REST blob reader; malformed data or integrity mismatches refuse. After obtaining every file, the batch makes its final remote source read with REST `GET repos/{repository}/git/commits/{pinnedCommit}` and requires the exact commit SHA before releasing any bytes.

That final read preserves GitHub's documented repository Contents-read permission floor for [App](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-contents) and [fine-grained PAT](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-contents) readers; it does not prove an explicit grant for public resources or identical endpoint-specific enterprise/proxy policy. Additional GraphQL query requirements can refuse even when a REST request would succeed. Preparation, confirmation, replay and hosted admission retain separate fresh cuts, with required blockers re-evaluated at transitions. Unreadable, incomplete or prohibited private cross-repository data refuses without a local fallback; no atomic GitHub transaction or zero-race guarantee is claimed.

Within one selected-record materialization or replay call, references to the same issue or PR share one complete history observation. Every reference still undergoes its own selector, authentication and digest checks. That observation is discarded after the call; it is not shared with a later confirmation, dispatch, publication or admission cut.

Review admission reconstructs the currently eligible inputs from complete authenticated histories, not just the old manifest's listed records. A new eligible evidence receipt at the same HEAD changes the inputs or produces an explicit ambiguity. The review's own outputs stay outside its normative fingerprint; its authenticated stage annex supplies the records later stages actually need. Prose-only PR edits do not change that fingerprint.

UW review and correction manifests pin the full prior disposition/adjudication lineage as `cause-state` delivery data. These records are not criterion evidence. A changed authenticated operator decision changes the next action's inputs; the current review's own dispositions remain outputs rather than circular self-inputs.

Reconstructing a selected review names its exact authenticated `review-attempt` reference as well as its persisted input fingerprint. The reference selects that review's own initial outputs; the fingerprint only checks input equality, never record identity. A later adjudication invalidates this reconstruction and belongs to the next review's full prior cause lineage. A new review neither reuses the old root nor resets the review bound.

Recall inventories retain each task's exact prepared action for later review-bound correction. Confirmed replacement dispatch validates the confirmed replacement root initially and the runner-supplied root at subsequent stages; an interrupted inventory or an equal fingerprint is not a substitute.

The separate read-only Instantané contains the index of criterion/invariant ids, titles, versions and paths; pinned diff, useful records, repository instructions and touched-area glossaries; and referenced assets copied from the verified installed plugin. Planning uses base references; review uses candidate references. The task carries only the procedure and index path, not copied UW data.

Repository reference discovery uses actual changed paths and paths from the selected authenticated plan to find ancestor instructions and glossaries, including cited glossaries. Planning pins those references at the base; review pins them at the candidate. A planned path need not exist yet and does not create a future code blob: candidate HEAD blobs are collected only for actual changed files. For a first plan without selected paths, discovery inventories tracked `AGENTS.md`, `CLAUDE.md` and `GLOSSARY.md` files at the pinned base and follows their glossary citations. An unreadable required inventory or citation refuses rather than silently reducing context; working-tree bytes are not a substitute.

Review manifests also pin the full changed files present at candidate HEAD and the context-generation helpers. Each panel dossier identifies its assigned chunk and preserves the original chunk diff, every cross-chunk digest and the full pinned source, including unchanged lines. Binary files retain their bytes; deletions remain explicit. Spec, recall and synthesis use the whole-review view. Chunk assignment and the resolved context window belong to the local integrity seal, not the common review fingerprint.

Snapshot integrity covers its actual paths, entry types and bytes, independently of the portable input digest. The expected baseline is host-owned, not a mutable hash file in the dossier. A changed, added, removed or symlinked entry invalidates the action before its result can become usable. If `local://` is unavailable to a child, placement uses the linked worktree's own Git directory, not the shared Git directory or tracked tree.

#### Code exploration and UW authority

The snapshot index identifies authoritative UW data and pinned normative references, not a source-code allowlist. Code-reading roles discover relevant implementation, tests, technical documentation (including READMEs and changelogs), and CI/build/test configuration in the action worktree at the indexed code version. These files, including plugin instructions under review, are product context to inspect, not replacement authority: governing instructions and normative references still come from their indexed snapshot copies.

In the retired native Feature graph, planning and plan review could explore code without shell or write access and required a clean, readable checkout. Native correction and verification keep their role-specific permissions; dossier-only decision and synthesis roles remain restricted to indexed records. The native child inherits the root session's working directory; this is not filesystem isolation.

A source file need not be preselected in the snapshot for an authorized role to discover it. Missing authoritative UW information still requires a concrete missing-context result; repository exploration does not authorize live-record reads, replacement of accepted obligations or publication.

#### Required context and explicit expansion

The native `missing-context` result binds to the action and sealed inputs; it is not a satisfied criterion, approval, or Report. The retired Feature planner, plan review, implementation and CI attribution used authenticated START/RESULT pairs to scope context-negative or rejected results to the producing mandate. Those records remain readable for history and eligible recovery. Spec assessment and retiring native review/correction still require their applicable authenticated inputs; a missing observation is not acceptance.

Prepare the replacement explicitly with `/uw action /absolute/path/action.json`. Its `expandedContext` cites the authenticated negative's `/payload` and genuinely additional pinned references. Preparation preserves the supplied context, required stage sources, accepted authority, code, subject and purpose, and creates a distinct manifest fingerprint and sealed snapshot. A missing required source remains blocking; unreadable, edited, wrong-digest or ambiguous lineage refuses. Repeated negatives must form a unique authenticated chain, not competing successors.

Preparation does not dispatch the new action, renew a mandate, reset review/correction limits or authorize recovery of an effectful correction. A previously resolved or cross-purpose negative can remain authenticated input data without becoming new resume authority. Session changes revoke pending native publication as well as continuation; pausing continuation alone does not revoke an already admitted publication.

#### Communication and publication authority

OMP's footer and status surface acknowledge commands, show phase changes and explain confirmation shortcuts. UI-only progress grants no authority. Once ready, the composed Feature instructions and scoped context are sent to the session; native result publication and dispatch guards below apply to the retiring runtime.

Framing confirmation presents titled members, repository/UW scope, replacement effects, identity changes and retirements, source accounting and merges, criterion-to-child coverage, foundations, relations and business context. Supplied text is visibly escaped rather than allowed to forge structural summary lines. The full captured proposal, exact digest and detail reference are separate under `D Détails`, not a raw payload in the default view.

The fixed action footer offers `C Confirmer`, `R Refuser` and `Esc Plus tard`. Tab or left/right selects an action; Enter activates it, initially `Plus tard`. Up/down and Page Up/Down scroll the content without moving the actions. The layout adapts to terminal resizing; when too small to present a decision safely, confirmation and refusal have no effect while Escape can still defer. Native buttons remain clickable so their live viewport guard can accept the first action after a height-only recovery. Reopening preserves freshness, revocation and one-use checks; neither closure nor chat grants authority.

The same dialog confirms abandon, reopen, proposal write or creation, material acceptance, cause adjudication and causal-dependency adjustment. Each summary asks a direct question, then names the target and the effects the current writer actually performs. Supplied text stays quoted. Captured JSON, digests and the detail reference stay under `D Détails`.

Read-only `/uw evidence` and `/uw verdicts` results use a compact successful record count, including zero; the full arrays remain in the consultable detail.

In the retiring native runtime, agents return forms for host verification and confirmed record publication. Role permissions do not authorize GitHub writes. Worktree isolation, tool omission and procedural restrictions are not a credential sandbox.

Reserved omp-build child roles require a correlated, sealed action. SDK child-factory rebinding shares private execution observations, not parent/child event-bus identity. A child must match one active, admitted root call and its SDK-observed slot, child/session identities and session file, with explicitly non-detached execution. These observations grant no authority beyond the registered action and verified inputs. The guard verifies the pinned profile bytes and uses their canonical prompt and tool allowlist; it does not attest which agent-definition file the SDK selected. Before the child starts, it clamps tools to the pinned names actually available as unique built-ins plus the required built-in `yield`, and verifies the exact enabled set and provenance. Unavailable pinned tools are omitted, not replaced by ambient extension or MCP tools. SDK initialization, accepted context, schema and guarded yield remain checked before root-result acceptance. The guard does not check which model answers: OMP's configured `retry.fallbackChains` may switch the child's model, and the child continues on the fallback model. No record or admission check reads the model. With `externalThinking` enabled, a fallback model that adds OMP's `think` tool changes the enabled tool set, so the child still stops.

The first provider request requires the exact bound task in an SDK agent-attributed user message. Later turns retain that task anchor and the same live binding, canonical prompt and tools; SDK agent-attributed user or developer controls may continue the execution, while human-attributed, unattributed or unknown message roles refuse. Attribution relies on the trusted SDK and privileged extensions, not a public hook that authenticates the origin of each prompt.

An unbound, stale or invalid reserved child aborts during prompt preparation and cannot use tools, including yield. Unrelated child roles are not restricted by this protocol. Missing or invalid guard evidence refuses completion. The SDK, installed privileged extensions and configured model routing are trusted host composition: these checks prevent data-only project/user profile shadows from changing the prescribed session contract, not arbitrary privileged extension code from replacing it. They do not attest final provider-wire bytes or provide hostile-host-process isolation. Without child-factory rebinding, root refusal is not proof that earlier child side effects were prevented.

Generated feature and promotion bodies do not request issue closure; their neutral issue references are not approved bindings. No prose-driven auto-close job replaces calculated termination. A person can still write a keyword that GitHub acts on at the default branch; that native state remains an observation, not proof of UW completion.

### UW Spec and admission

The [glossary](GLOSSARY.md) distinguishes proposed, accepted and effective Specs. The effective Spec contains the UW's own criteria plus every qualified ancestor invariant and exclusion, with the complete accepted version vector. Ancestor criteria are not copied into the child's obligations. Missing, stale, conflicting or incompletely observed ancestry refuses; an editorial label cannot bypass the operator decision for a mechanically material ancestor change. Planning, implementation, review and criterion evidence bind that same effective Spec.

Calculated completion requires the uniquely active authenticated Mandate and its exact accepted OwnSpecRef for the UW and every inherited ancestor; an older pinned grant remains historical evidence, not a substitute for current authority. It checks each current native own Spec's canonical version and accepted tier, including standalone leaves and roots. A mechanically material body or tier discrepancy holds the affected UW, its inherited descendants and managed dependents; proceeding with that change requires the ordinary operator decision. Editorial-only body drift is not a new accepted version. Known or unknown Wayfinder labels cannot retain UW completion or release a managed dependency. This validates current inherited obligations, not a child-to-parent wait edge or a requirement that the parent finish first.

An accepted parent freezes each child's scope, canonical Spec version and tier, not presentation bytes. Its coverage map assigns every own criterion to accepted children and accounts for every engaged child. Missing assignments, unknown children or version drift hold progress. The coverage editor binds the displayed parent, inherited references and child commitments; a changed basis needs a fresh decision. Historical parent review and completion retain those exact commitments.

Leaf admission checks the current parent commitment, inherited Spec and blockers before establishing the leaf mandate. Parent scheduling is suspended. Missing or held proof never counts as child completion, and native `CLOSED`/`COMPLETED` alone cannot release a managed dependent.

Completion is calculated bottom-up from one complete observation. A leaf needs its bound PR merge and delivery proof: a successful `review` check read by the merged PR head SHA, or admissible historical structured-review proof. A parent still requires completed engaged children, its own criterion proofs and directly reviewed integration containing the delivered child commits. Parent delivery is suspended; native issue closure is never a substitute for proof.

A parent's criterion citations must resolve to each covered child's actually selected delivery proofs; a shared ancestor citation is not the child's own integration or review proof. Before closing the bound UW, the installed closure's own final writer read obtains a concordant binding and whole common completion observation, including fresh native delivery facts. It evaluates that complete proof before projecting the native root; no later graph-only read can discard related facts. The same full reader confirms the effect. Observed proof loss before the state mutation refuses without a PATCH; proof loss after it remains partial and retains the actual close effect. Unreadable or lost-effect responses do not establish completion or trigger an automatic retry. This is not an atomic GitHub snapshot.

Retiring native continuation used a bounded fresh UW observation after a Fix UW withdrawal, retaining the confirmed withdrawal even if unrelated drift stopped continuation. It did not provide an atomic GitHub snapshot.

One parser/renderer in `adapters/github-native/uw-spec.ts` owns body grammar. `roxabi/uw-spec/` supplies its reads; the old `hasScope` and loose acceptance-list parsers are gone. The engine owns canonical content versions, durable C/I identities and admission; framing and confirmed UW writes account for source obligations. Review-reference loading remains in `roxabi/review-assets.ts`.

A conforming hand-written body uses this grammar; the identifiers below illustrate engine output, not permission to allocate identifiers manually:

```md
<!-- omp-build-spec/1 -->

# Origin

Source of the request.

# Context

Context in the author's language.

# Change

The intended change.

# Acceptance Criteria

- C1 : A valid request is persisted once.

# Invariants

- I1 : Existing authorized requests remain readable.

# Exclusions

- Additional export formats.

# Open Questions
```

All seven headings are fixed English H1s in that order; their text may use the author's language. Empty sections contain no placeholder item. The existing optional complexity comment is metadata, not another tier or part of canonical Spec identity. `Acceptance Criteria` and its bullets remain consumable by the current plan/review path.

Canonical rendering encloses text values in visible `~~~omp-build-text` literal fences, indented beneath list prefixes where needed. The delimiter is lengthened beyond every tilde run in the value, so literal headings, bullets, code fences, indentation and leading/trailing blank lines round-trip without becoming body structure. The parser reads that visible payload directly; there is no hidden authoritative copy. Plain hand-written values remain valid where they satisfy the same structural grammar.

`Spec.version` identifies parsed canonical content, not presentation-only blanks. Meaningful literal/code whitespace remains content. The raw `bodySha256` separately protects exact observed bytes and authenticated assessment pairs. Existing-UW prepare/write inputs bind that exact current hash as required `sourceBodySha256`; preparation and the pre-write read recheck it together with exhaustive normalization accounting before allocation or effects. A conforming manual edit creates a proposed version; it never changes the accepted reference by itself.

The engine allocates criterion/invariant IDs durably on the UW through `spec-identity`, including before the first mandate. Rewording preserves an existing identity; accepted withdrawal retires it, and re-adding requires a new ID. Unknown, duplicate, retired, conflicting or incompletely observed identities refuse. Proposed omission does not withdraw an accepted obligation. Exclusions are cited within a Spec version, not by a stable C/I allocation.
Accepted retirements are issue-lifetime facts replayed from authenticated historical chains, including after abandonment or explicit succession. Historical snapshots remain readable without restoring an inactive mandate's delivery authority; missing or contradictory required history refuses.
Current child commitments also remain observable when their historical parent grant becomes inactive, but only with authenticated historical provenance. Reading these facts does not renew the grant or restore the child's delivery authority.

Assisted framing retains source obligations with explicit kept/reworded/new/removed accounting. One genuine operator confirmation covers the entire aggregate, including members, relationships and coverage. Existing issues are converted in place. Incomplete aggregates stay held; partial or uncertain effects are reported without retry or rollback. Framing and identity allocation do not accept a Spec or authorize delivery.
If a framing aggregate is held, delivery, landing and continuation transitions are refused, including after a concurrently published first Mandate; pause, abandon and stop remain available. The hosted gate adopts this only after the tooling pin advances.

Before first acceptance, a framed member's title, Spec body, tier label and recorded edges are pinned: `/uw` proposal writes refuse it with `framing-result-pinned`, and a manual GitHub edit holds it as `framing-result-drift`, with no release in this version.

Relation-endpoint checks read an ordinary issue's complete native graph and own history without fetching unrelated descendant delivery sources. Framing-bound endpoints retain strict aggregate closure and pre-acceptance currentness; verified past acceptance does not restore a paused or inactive Mandate or bypass the Parent engagement guard.

The three installed framing procedures are pinned and byte-checked; a mismatch stops continuation. Context projection and typed forms are procedural controls, not proof of provider receipt or human reasoning. Real host and provider behavior requires separate qualification.
`/feature new` refuses an abandoned or revoked UW with a nonconformant body as `successor-spec-nonconformant`, with parser diagnostics and no write, checkout or bootstrap. omp-build has no in-place conversion for an inactive UW: `/uw write` is refused while its mandate is abandoned or revoked, and framing does not admit it. Start the work again as a new UW with `/feature <text>`. A body that already parses as conformant with confirmed identities follows the existing successor path; ordinary continuation cannot renew an inactive mandate. Nonconformant initial selections enter confirmed framing.

Native graph reading consumes every required parent/child/blocker/label page and closes the relevant graph across repositories. Incomplete, inaccessible or ambiguous portions are named, never treated as absent. Children stay in their parent's repository; blockers may cross repositories. Hierarchy, blocking and combined-wait cycles refuse.
Every native graph page must match the requested repository and issue number before its facts or connection items are attributed to that UW.

A UW is framed by a unique native tier, at least one valid criterion and no open question. Delivery requires its applicable accepted effective Spec and lifted blockers. A managed blocker lifts only when its completion is calculated from authenticated delivery; a native-only blocker requires readable `CLOSED` with reason `COMPLETED` and complete evidence that no managed authority applies. On a UW without a trusted mandate, a foreign or incomplete workflow claim leaves that absence unproven. Once a trusted mandate exists, foreign frames remain observable and do not by themselves hold its calculated completion or current engagement as an accepted child. Foreign control claims do not veto an otherwise authenticated cause-dependency control. Incomplete, conflicting or damaged expected-author records still hold. Unknown, incomplete, not-planned or abandoned states remain held and require an operator decision on the actual native dependency, not a success override. A previously complete delivery proof does not override a held native dependency state. Wayfinder maps and decision issues are non-UW, excluded from the work graph and without UW tier; reclassifying an already accepted child cannot silently remove that commitment.

Manual native closure never completes a managed UW without its authenticated delivery proof. The reader reports `native-closure-unproven`; the operator must reopen it or record abandonment. Confirmed reopening writes and reads back `OPEN` / `REOPENED`, but does not manufacture missing criterion, review, merge or parent-integration evidence.

These checks run at advancing transitions and final admission. A newly observed blocker does not interrupt an action already in flight: its result is conserved, and the next transition refuses. Pause, abandonment and proposal repair remain available. Pre-read/readback detects conflicts but is neither GitHub CAS nor continuous race-free enforcement.
For composed assessment and creation readback, a pre-existing foreign copy retained in both cuts cannot impersonate the selected authenticated assessment start, result or creation intent. The whole observation cut remains strict: a new foreign append during the action is still a concurrent history change.
An authenticated assessment of a mechanically material change still requires the existing operator decision when its classification says `editorial`; the label cannot override the canonical delta.

### UW operator command

The command accepts explicit repository coordinates and JSON files. `<ref>` is `owner/repo#N`; `<repo>` is `owner/repo`.

| Syntax | Operation |
|---|---|
| `/uw read <ref>` | Read parsed, proposed and accepted Specs, admission, graph, completion and decoded histories. Findings and causes are in those histories; no dedicated listing verb exists. Admission diagnostics expose gaps. |
| `/uw read-effective <ref>` | Read the effective Spec. |
| `/uw read-coverage <ref>` | Read parent coverage. |
| `/uw read-completion <ref>` | Read calculated completion and diagnostics (the termination projection). |
| `/uw reports <ref>` | Read durable reports on the UW and its native subtree. |
| `/uw evidence <ref>` | Read delivery declarations. |
| `/uw verdicts <ref>` | Read authenticated criterion verdicts. |
| `/uw propose <ref> --proposal-file FILE` | Preview a proposal without mutation. |
| `/uw write <ref> --proposal-file FILE` | Confirm and write a proposal. |
| `/uw create <repo> --proposal-file FILE` | Confirm and create a UW. |
| `/uw action FILE` | Prepare an action manifest and local snapshot, or replay supplied reviewed inputs. |
| `/uw accept-material <ref>` | Confirm an exact authenticated material assessment. |
| `/uw reopen <ref>` | Reopen through the UW operation. |
| `/uw abandon <ref>` | Abandon through the UW operation. |
| `/uw adjudicate --request-file FILE` | Decide an exact pending cause disposition. |
| `/uw sister --request-file FILE` | Create an adjudicated cause's same-parent sister. |
| `/uw promote-report --request-file FILE` | Promote an exact durable report. |
| `/uw adjust-cause-dependency --request-file FILE` | Withdraw or replace a causal dependency. |

`propose`, `write` and `create` take strict proposal JSON containing the body draft, labels, relations and sizing factors; the proposed tier is computed as part of preparation, not by a separate tier verb. Writes and creation require the real context-bound UI on the exact proposal. Material acceptance requires an applicable own authority and an authenticated exact assessment; no argv token supplies confirmation.

Host routes are not extra `/uw` verbs. `/feature` performs confirmed framing, the parent coverage UI confirms initial coverage, and composed delivery uses `open-pr` for the authenticated PR binding and `finish` for `closeLinked` after calculated completion. There are no separate `/uw` frame, gaps, termination, findings, causes, manifest, snapshot, parent-coverage, link-pr or close verbs.

omp-build automated issue body, label, relation and state writes go through UW operations and their shared writer. Standalone issue-triage remains independent. Human GitHub edits are legitimate, but an edited proposal is not an accepted Spec and a manual close is not calculated completion.

GitHub publication follows the [public-safe content instructions](skills/feature/SKILL.md#public-safe-publication). Semantic review is procedural; existing-tool secret scanning is best-effort, not an automatic publication gate or proof of complete coverage. These source instructions do not establish installation or activation.

`evidence` and `verdicts` read applicable delivery declarations and authenticated criterion verdicts, including the approved bound PR's review history; they do not publish. `action` accepts a JSON object containing `request: UwActionRequest`: it resolves the durable inputs and creates a local read-only snapshot without a GitHub write. Adding `reviewed: ActionInputs` instead replays the stored inputs against current durable sources. The request's code coordinates and references must be readable and match their pinned identities. The installed-plugin pin comes from trusted host composition, never the request file or argv; a missing or mismatched pin refuses.

Retained native review inputs bind the selected initial root to the authenticated subject: exact PR history for PR review, or UW history and exact base-to-head range for historical parent final review. Complete history, fingerprint and subject checks still apply. Review Spec inputs come from canonical grammar and authorized records.

| Cause command | Boundary |
|---|---|
| `/uw reports example/demo#42` | Reads durable reports on that UW and its native subtree, without discovering every PR or creating an issue. |
| `/uw adjudicate --request-file /absolute/path/adjudication.json` | Prepares a motivated decision on an exact pending disposition, then requests genuine confirmation. |
| `/uw sister --request-file /absolute/path/sister.json` | Prepares the selected cause's framed same-parent sister; confirmation precedes allocation and relation writes. |
| `/uw promote-report --request-file /absolute/path/promotion.json` | Promotes one exact durable report through the shared UW creation backend, with its own confirmed receipt. |

Request files use the strict [cause request schemas](engine/cause-disposition-schema.ts). Adjudication names `pending`, `rejectedFindingIds`, `judgment`, `reason`, and `references`; supported necessity, urgency and size judgments require their cited observations. A retained-finding resolution rejects exactly its original finding with a null judgment; a rule-error resolution supplies no finding ids and a null judgment. Both preserve the original subject and diagnostics in a named final report, with a reason and cited observations, rather than inventing a root cause. Rejection affects only the exact authenticated findings, never criterion satisfaction, CI or an unrelated later observation. Sister requests name the exact `disposition`, sizing `factors`, `tierOverride`, and label changes. Promotion names the exact `report`, a complete ordinary `create` input, and its `reason`.

The confirmed operation intent is published and read back before any creation effect. An active or indeterminate parent holds sibling creation until parent coverage admission is available. An uncertain or partial effect is reported as such and must be reconciled from native facts; it is not success or permission to retry creation blindly.

A blocking sister remains an obligation until a fresh authoritative completion observation, even if its native blocker edge is removed. Its creation receipt alone never proves completion. Historical report promotion authenticates the immutable report lineage on the originating UW; fresh parent and creation admission remain separate and do not require reopening the historical review's PR.

An explicit `adjustCauseDependency` proposal can withdraw or replace that causal obligation. Genuine confirmation precedes the declared native blocker delta through the shared writer; only its fresh effect readback and authenticated control publication make the adjustment applicable. Declined confirmation writes nothing, and an unconfirmed effect stays partial. A historical withdrawal never overrides a blocker that is present again in the current native graph.

Historical pending causes retain the accepted Spec that produced them. Adjudication reconstructs that origin from the complete authenticated Spec chain; current native acceptance, the exact live pending head and genuine operator confirmation remain mandatory. Immutable successor replay cannot authorize a new operation.

Covered and new-policy delivery discovery searches each distinct relevant repository and mandate head branch across open, closed and merged PRs, reading every page without filtering by base. Branches locate candidates; canonical authenticated bindings establish association. A retargeted PR stays visible and is refused. Incomplete pages, ambiguous bindings or unreadable required history refuse rather than producing an apparently complete empty result.

For new-policy bindings, publication and selection require a non-null mandate branch and matching mandate, binding and native PR branch and base. Historical off-branch and branchless facts remain subject to their original rules; they are not erased or made landable by this policy.

The first succession of an uncovered legacy history retains both exhaustive repository-wide observations and examines every old mandate in the UW home, not just the selected lineage. An off-lineage, orphaned or competing mandate refuses coverage rather than being ignored or treated as covered. The transition can therefore remain expensive. A genuine successful new-policy successor control can bound a fully observed, rediscoverable old prefix; an incomplete prefix or an old mandate added after that boundary refuses explicitly. Ordinary reads do not silently launch a global fallback scan, and a version or cache alone does not prove historical absence.

Foreign claims do not veto UW **home-history coverage**. This does not relax the existing candidate PR binding guards: a foreign-only binding claim on a branch-matching candidate, including a fork PR or an unbound same-repository PR, can still refuse the delivery observation. A refused pause does not mean the own PR was disarmed. If necessary, an operator may independently verify the own PR and manually disable auto-merge and remove `reviewed` as containment only; this is not workflow authority or recovery.

Pause, abandon and control-disarm require complete ordinary authority and retain their existing PR ownership checks. An uncovered legacy history refuses instead of confirming containment; the one-time historical succession path remains subject to its existing terminal-antecedent and complete-observation preconditions. The `legacy-coverage-incomplete` diagnostic can also indicate missing, damaged, partial or ambiguous current-policy home history, or an unknown policy; it does not justify ignoring history or automatically migrating it.

Release policy: every new product version remains unknown to binding discovery until deliberately recognized in `engine/workflow-binding-policy.ts`. Versions 0.19.0 through 0.19.3, 0.20.0 through 0.20.1 and 0.21.0 through 0.21.13 retain the bounded semantics of 0.18.8 through 0.18.11; other versions remain unknown. Rebuild the distributed contracts after changing this policy. A version bump neither migrates records nor activates tooling.

A create input has this shape; coordinates and content here are fictional:

```json
{
  "repository": "example/demo",
  "title": "Report named admission diagnostics",
  "draft": {
    "criteria": [
      {
        "kind": "new",
        "draftKey": "criterion-1",
        "statement": "Missing admission data is reported with a named, located diagnostic."
      }
    ],
    "invariants": [],
    "exclusions": [],
    "openQuestions": [],
    "sections": {
      "origin": "Explicit operator request.",
      "context": "Admission must distinguish missing facts from an empty result.",
      "change": "Report the missing fact without starting delivery."
    }
  },
  "factors": { "files": 2, "risk": 2, "architecture": 2, "unknowns": 2, "domains": 2 },
  "writes": {
    "labels": { "add": [], "remove": [] },
    "relations": { "addChildren": [], "removeChildren": [], "addBlockers": [], "removeBlockers": [] }
  },
  "normalization": [
    { "kind": "new", "target": { "kind": "new", "draftKey": "criterion-1" }, "reason": "Explicitly requested criterion." }
  ],
  "tierOverride": null
}
```

For an existing UW, replace `repository` with `"uw": { "repository": "example/demo", "target": "example/demo#42" }` and add required `"sourceBodySha256"` copied exactly from its current `/uw read` detailed result's raw source. A create input omits that field. The optional `writes.relations.parent` distinguishes omission from explicit `null` removal; when set, its repository must match the UW's repository. Existing draft items name a known durable ID; new items use a unique draft key and leave C/I allocation to the engine. The normalization accounting must match the observed source, not merely this illustrative new-item case. κ determines the proposed tier unless an explicit, explained override is included in the confirmed proposal.

Intentional new prose uses `{"kind":"new","target":{"kind":"section","section":"context","range":{"start":0,"end":12}},"reason":"Explicitly requested context."}`; exclusions and open questions use their existing typed destinations and indices. Ranges are nonempty, half-open UTF-16 offsets into the proposed content. New content and source-backed content share exact destination coverage: no gaps or overlaps. Every old source span still needs its own kept, reworded or removed decision; a new decision cannot account for it or claim an existing C/I identity.

The command emits compact status and a consultable detailed-result path in the session artifact store, not an automatic dump of bodies/graph/results into the conversation. Artifacts are derived observations with session retention, never workflow authority. A create response lost after POST is `uncertain`: the issue may exist, no reference is invented, and no search/retry/rollback is automatic. Known partial effects remain explicit.

### Parent UW delivery

Parent `/feature` delivery is suspended until slice 6 of [#1031](https://github.com/Roxabi/roxabi-plugins/issues/1031). Selecting a parent stops before delivery checkout or mandate preparation. The current authenticated accepted child set determines delivery role; an unaccepted relation change does not replace it. Framing, coverage, calculated completion and operator containment are separate from delivery scheduling.

The `epic-driver` delivery loop was removed. Its `epic-event` records remain readable: `goal-stop` is a UW stop, `goal-report` records a shared-state stop or report, and `epic-review` and `post-merge` retain integration evidence. Historical `epic-drop` reports are stops; `epic-fix` events are diagnostic only.

The surviving `epic-driver-control.ts` and `epic-driver-containment.ts` helpers serve parent pause and abandonment, not scheduling. Containment checks applicable own and approved child PRs against their exact authenticated bindings. An issue link or branch is only a discovery hint. Incomplete discovery cannot confirm disarm, and containment never reactivates delivery.

Feature init imports the emitted `migrate-labels.ts` and `init.ts`, and binds the checkout with `defaultInitDeps(repository, checkout)`. It does not relabel existing issues; standalone issue-triage retains its own init behavior. The resolver is `triage-runtime.ts`; a missing emit stays `issue-triage-unavailable` or `IssueTriageMissing`. `skill://issue-triage` remains the separate optional advisory skill, not the action runtime. The generated `dist/issue-triage/` slice ships with omp-build.

## Commands and tools

| Entry | Lane |
|---|---|
| `/feature` | User lane. Resolves framing, controls, leaf mandate and worktree; then loads the installed composition instructions with scoped context. Delivery effects use `feature-cli.ts`. |
| `/uw` | Native operator command for proposed/accepted reads, exact proposals, confirmed writes/creation and material acceptance. No agent tool or argv confirmation grant. |
| `/tooling-pin status\|activate` | Inspect or confirm an isolated root-session tooling pin; user lane only. |
| `/promote` | `registerCommand('promote')`. Dumps `skills/promote/SKILL.md`. User lane. |
| `/cleanup` | `registerCommand('cleanup')`. Loads the worktree-only guide; inventory and confirmed single-path removals use its guarded CLI. |
| `/ci-watch` | `registerCommand('ci-watch')`. Dumps `skills/ci-watch/SKILL.md`. User lane. |
| `/dev-review` | `registerCommand('dev-review')`. Dumps `skills/dev-review/SKILL.md`: reviewer agents on an open PR head, a findings comment, the verdict line when approved. User lane. |
| `/dev-fix` | `registerCommand('dev-fix')`. Dumps `skills/dev-fix/SKILL.md`: implementer agents fix the latest `/dev-review` findings and the failing checks on an open PR head, the exact tip is pushed over the reviewed head, then `/dev-review` again. User lane; the operator who runs it authorizes its push. |
| `/fix` | Retiring user-lane native correction. Still installed; use `/dev-fix` for composed delivery. |
| `omp_build_start_review` | Retiring model-lane native review on an existing PR. Its records support native `/fix` and recovery, not composed review. Not execution authority. |
| `omp_build_recover_interrupted_fix` | Retiring native recovery. Inspects an interrupted PR correction and offers exact-state root-operator confirmation. Accepts only `{ pr }`; requires host write approval and current authority. Neutral closure or unstarted existing-review adoption only; never landing authority. |
| `omp_build_prepare_checkout` | `registerTool`. Canonical checkout for one unambiguous issue reference. A pull-request number checks out that request's existing head instead of minting an issue branch. Returns `ready`, `move`, or `blocked` with the path. Host write approval. Does not publish authority, bootstrap, resume, move the session, or simulate `/feature`. |
| `omp_build_execute_native_batch` | Retiring native runtime's restricted execution tool. Accepts only `{ batchId }` for an announced, sealed batch; does not authorize or publish work. |

`registerCommand` is the user lane. Retiring native review and correction still verify the target, head, bound and proofs before dispatch; unknown, stale, ambiguous or closed PRs refuse. The restricted execution tool runs only a host-admitted batch. `disable-model-invocation` omits a skill from the prompt listing but neither prevents explicit reads nor grants authority.

The retiring runtime uses SDK child sessions through owned execution, not interception of built-in `task` results. It retains outcomes and errors before settlement. These records conserve SDK observations, not a complete raw stream, and grant no publication authority by themselves.

The owned execution tool declares the SDK's `essential` load mode for direct top-level dispatch in the standard CLI. This does not enable a tool the user disabled or change an existing tool presentation; the lease still requires the owned tool to be active before announcing a batch.

During an owned dispatch turn, a root- and batch-scoped lease temporarily removes the built-in `task` tool while retaining the other enabled tools. The owned tool must already be enabled. Restoration is limited to the same root identity and an unchanged observed tool presentation; if that presentation drifts, omp-build leaves it untouched and stops the owned continuation. This is not a compare-and-swap or an ABA/zero-race guarantee.
Both native root capture and the tool-mask lease bind journal, file and cwd to the live session and command context. A fresh capture after `/move` may observe an older registry `sessionFile` locator; it captures that metadata separately instead of treating it as the live file. Subsequent registry-ref, session, journal, live-file, cwd or provider drift still invalidates the capture; registry locator drift also refuses. Both paths retain the captured model-registry and cost-gate identities; ordinary changes within the same cost gate do not replace that identity. No SDK registry metadata is rewritten, and this does not permit a move during an active lease or relax tool-presentation restoration.

The qualified SDK baseline is OMP CLI 18.20.2, also pinned for development; this is not a claim that it is the earliest compatible version or that later versions are compatible. OMP CLI 19.1.0 renamed the mounted `xd://` tools to tool commands; the native task mask reads either name, which does not qualify 19.1.0. Catalogue installation does not install the declared host peers: the running OMP host must provide the matching SDK packages. The root-capture and tool-mask paths were smoke-tested before and after a real `/move` on unmodified official OMP CLI 18.14.0, without starting a model turn or native workflow; those historical observations do not qualify the current recovery path on that version. The common confirmation UI has runtime proof only on official OMP CLI 18.18.5, as detailed below. Standard CLI credential and model-pool composition is assumed. A custom embedding can present compatible APIs while using opaque credential or pool provenance; that provenance cannot be automatically detected or attested here. Offline and adapter evidence is not real native acceptance: a separate native cold-restart recovery acceptance run is still required.

The earlier framing confirmation path was exercised on unmodified official OMP CLI 18.18.3 at 80×18, 40×12 and 40×8, including defer/reopen, explicit choices, scrolling and resizing. Diagnostic parent coverage, foundations and escaped supplied text were also observed. External native writes were denied in those probes: they qualify that UI/controller path, not the later generic confirmation surface, native delivery or hosted landing.

The common confirmation path was additionally exercised in native mode on unmodified official OMP CLI 18.18.5 at 101×14 and 39×11: preparation status, deferred reopening of the same proposal, explicit counter-only choices, scrolling with pinned actions, resizing and actual session-switch revocation. Shortcut input used exact Kitty Control+Alt+U bytes through Tern's text transport because its `key Ctrl` alias emitted Super+Alt instead; no physical-keypress attestation is claimed. Fictional proposals and denied external writes qualify the UI/controller path only, not Mandate publication or hosted landing.

## Records

The engine (`engine/`) owns versioned records, references, conservation, counts and deterministic projection. Roxabi (`roxabi/`) prepares delivery authority and UW operations and retains the retiring native review/fix paths. GitHub adapters paginate comments, check native authorship and revisions, and confirm publication by readback. These checks do not judge review semantics.

For multi-page GitHub histories, each next page is followed by a comparison of the preceding page's native IDs and revision facts. A changed or unverifiable page returns `complete: false`, retains comments already read, and reports `github-pagination-changed`; read failures retain their existing diagnostics. Relative to GitHub's documented ascending-ID ordering and the undocumented assumptions that new IDs increase, deleted IDs never reappear, and responses are non-stale and monotonic, a complete read includes every comment present throughout the read. Stale or replayed responses can defeat the check. Edits within a preceding page's comparison window cause a hold; revisions outside those windows are not checked, and the result is not a snapshot.

A record frame whose native author is not the trusted login is `foreign`. It stays observable in the decoded history, but it never completes, collides with, blocks, or deduplicates a trusted operation; an identical foreign body does not suppress a publication. A review's time is the native creation time of its final part; editing the comment does not move it.

`encodeRecord` frames each canonical record with its projection. The header is `<!-- omp-build-record v=1 kind=… id=… operationId=… part=i/n data=<base64url> -->`. The payload is authoritative. The Markdown is presentation; no business reader takes a verdict, head, or input from it. A final `review` carries `candidateGitSHA` and `input` (64 lowercase hex SHA-256, or null). Projection lists the record, decision, candidate, input, findings, standards, and source provenance (contribution host plus originals). Legacy `<!-- omp-build:… -->` markers — including `code-review`, `review-head`, `review-input`, and `proof` — are `legacy-format`. They are refused, not parsed, resurrected, or reset.

Projection takes an explicit host `RecordProjectionConfig`, or null. The host supplies `{ taxonomy, acceptedPolicy }`; the candidate does not derive the taxonomy or accept its own evidence policy. Only a final `review` renders a verdict, and that projection refuses null or unknown configuration. Explicit null permits only neutral evidence, decision, and stop publication. Publishers bind that host configuration once. Decoded operations need `authority` and distinct `claimedKinds`; those claims are evidence, not permission, and missing metadata refuses. Projection follows the record's required dependencies from the original history. A foreign, missing, incomplete, or ambiguous reference refuses; it is not repaired, and an opaque record outside that closure does not acquire review authority.

Authoritative review contributions retain captured submissions in `rawAttempts` and SDK-observed terminal material in `native.raw`. The owned execution result conserves outcomes and errors in the referenced local artifact while exposing a compact response; it does not assert an unobserved complete SDK stream. Human contribution text may cite the canonical record or operation rather than dumping retained material. These observations do not replace review judgment or publication authority.

In the retired Feature flow, a result bound its confirmed START, exact mandate and action inputs. Plan and implementation receipts retained terminal and Bash observations; a completed child, schema-valid claim or published commit did not establish result retention or effect admission. Missing child outcomes left their START uncertain. These records remain readable; composed delivery checks its live mandate and reconciles publication from Git and GitHub facts instead.

Native command claims are not observations. Historical criterion evidence needs matching completed host captures and demonstrated code linkage; a printed SHA, selected tool ID or combined output relabeled as two streams does not prove linkage.

The retiring `omp_build_start_review` runs spec → panel → recall → synthesis and publishes confirmed native records. Retiring `/fix` uses `R-review-fix-intake`, `R-review-fix-synthesis`, `R-review-fix-apply` and `R-review-fix-falsify` as applicable. An existing-review-bound request uses its confirmed decision unchanged. Correction records set `landing: false`.

Correction mandates use the same strict own-UW contract. A bound PR reuses its real accepted UW snapshot, tier and durable identity references, with correction permission but no landing permission. A PR without an authenticated UW binding refuses `fix-own-uw-required` before publication or dispatch; neither its prose nor a correction-scope string becomes an invented `C1`.

Pre-decision correction synthesis binds to the complete initial intake of the same correction root. CI correction additionally pins the authenticated attribution result as stage evidence, not dispatch or landing authority. An issue reference to `/fix` aliases its unique current authenticated bound open PR; the binding must identify that exact current mandate, not a predecessor in the same UW. The issue must be open and its PR branch checked out. Issues without such a PR are refused before writes; correction without a PR is unsupported.

Before publishing a correction root, the effective push remote must be credential-free and its branch tip must equal the candidate head. Missing or different remote heads refuse rather than creating an unusable request. Credential-bearing URLs refuse without echoing the URL; use SSH or credential-free HTTPS with a credential helper instead. These checks do not replace repository identity, current authority or publication ownership checks.

Pre-release stranded roots, including legacy synthetic CI roots, are not migrated or repaired. New authenticated owners use the [bounded correction recovery](#bounded-correction-recovery) path; a refusal never permits clearing history or replacing an entered attempt.

Existing worktrees are entered with `/move <path>`, not recreated, and not with `/wt`. The command prints that move only when the session cwd is not the intended worktree.

Composed `/feature` resumes from Git and GitHub facts once in the matching worktree and reviews each changed PR head independently. The retired review-bound handoff pinned the PR, review, scope and exact mandate; these bindings remain readable for native history and eligible correction recovery.

A persisted `fix-request` proves recording, not completed execution. Ordinary continuation remains bound to its live invocation. Durable `fix-owner` records additionally prevent another ordinary, review-bound or CI start from bypassing active or interrupted ownership, including an opening with no complete request. A cold request can continue only through the explicit bounded recovery protocol below; local artifacts are not a replacement workflow journal.

Each native correction continuation re-reads the current history and validates the originally confirmed review against it
before confirming the mandate and live request from that same snapshot. A newer review or an exhausted review bound
refuses execution of the older decision; it does not reset the bound or discard the recorded request.

The full original review input is checked at entry. Subsequent owned correction commits are checked by the existing
commit, proof and head fences, rather than requiring the local HEAD to remain the original review's HEAD.

Retiring standalone `omp_build_start_review` is independent of Feature inhibition; composed `/dev-review` uses independent reviewer agents, not a native review batch. A native interrupted inventory may remain pending; it is not approval, does not restart silently and does not reset the native review bound.

Review → fix record contract: [root causes and member references](skills/dev-review/root-causes.md).

### Native review policy and cause dispositions (retiring)

Prepared review uses `baseline`. The separate [evidence review policy](skills/dev-review/evidence-policy.md) requires independent operator acceptance for explicitly selected `evidence-v1` work. A record's policy field, a test fixture or a passing replay cannot switch the live policy; the prepared review assembler does not read policy from old records.

Correction disposition follows the same evidence-backed D14 table under either review policy. Per-cause cited judgments determine correction, an exact-confirmed sister or an original-UW report; no review-policy value authorizes automatic issue filing or optional-neighbor work. Unsupported or contested blocking causes remain pending for motivated operator adjudication. Rejecting a finding cannot satisfy a missing criterion or bypass the head/input/CI and mandate gates.

Mechanical inspection of original findings is independent of synthesis. An intrinsically unusable blocking original remains retained even if synthesis marks it usable or downgrades its severity; genuinely usable originals may still be reclassified. Unassigned exclusion-rule errors remain named blocking dispositions, including when an otherwise authenticated correction has no findings or causes.

Historical dispositions authenticate their exact accepted-Spec prefix against the complete authoritative chain. Legitimate editorial or material succession does not invalidate an immutable final report, and historical rejections cannot waive findings under a different accepted Spec. Sequential adjudication validation reuses authenticated prefixes only within one observation; a fresh history requires fresh validation.

The optional evaluator supplies separate qualification dimensions and per-result backend identity, not aggregate severity, probability or authority. Unavailable evaluation is disclosed degraded mode, never a fabricated score or automatic clearance. Shadow outputs remain separate from authoritative records and authorize no effects.

Differential re-review retains its independent acceptance requirements: baseline, delta, affected paths and residual obligations. Missing history or impact evidence requires full review plus explicit residual inspection. A missed required blocker, unauthorized correction, inadmissible sister or lost residual suspends candidate use pending renewed supervised acceptance; existing stopped review bounds remain intact.

### Earlier review/fix qualification (T2)

The earlier T2 cohort covered actual OMP 18.12.5, a local scripted provider, a fake
GitHub, and a local bare Git. A native positive path exercised spec → panel →
recall → synthesis → canonical review, and trusted gate 0 accepted it.
Invalid-only and sequential new-head paths met their gate-1 refusal checks. A
full native fix accepted two commits, with independent proofs, falsification,
restore, a clean tree, a non-default push, and final records. Typecheck,
Biome, build, and the repo suite passed on that same cohort. This is not a
paid semantic-model campaign, not proof of review efficacy, not full cold
resume, not hosted GitHub, and not T3, T5 or merge activation. It does not qualify composed `/feature`.

### Historical native workflow integration qualification (T3)

A private local cohort qualified candidate `0.11.0` with actual OMP 18.12.6
and Bun 1.4.4. All 29 modes passed on one frozen product-code and fixture
snapshot, with unchanged runtime binaries. This is not an installed release.

- **Product paths:** the then-installed native `/feature`, native tasks, the CLI landing
  path and the independent trusted review gate. The default/non-default-base
  binding case is an explicitly seeded CLI/gate witness, not an OMP session.
- **Recovery and controls:** fresh checkouts and distinct homes without session
  transfer; two actual pause/resume cycles; abandon and explicit successor;
  wrong-child-branch refusal; unconfirmed pause refused by Feature, explicit
  review preparation, trusted CI and the now-removed local landing command.
- **Nested coverage:** seven terminal-delivery reentry cases; both parent
  completion and child-to-parent ownership interruption; both remote-pause
  interleavings during CI attribution and correction synthesis. Original
  results remain evidence even when current authority refuses further effects.
- **Ordinary checks:** build, typecheck, Biome (183 files), isolated imports
  without dependency installation, and the full suite (87 files, 2,054 tests).
  The full suite ran without concurrent native qualification jobs.
- **Limits:** scripted local model provider, fake GitHub transport and local bare Git only. No paid-model efficacy, hosted GitHub adoption, global installation or merge activation is established; T4 and T5 require their separate authorizations.

### Historical C1 portable preparations and coordinator witnesses (candidate 0.11.1)

The C1 cohort passed 43 tests in four focused files with an inherited global Git
configuration that requires an unavailable signing program. The admission and
correction fixtures isolate Git configuration, inherited hooks and shell startup;
every allocated repository or remote is owned before setup can fail. A real
failing Git setup also left no allocated sandbox behind.

A subsequent preservation commit ports the principal's merge-race regression to
the actual native landing process and strict GitHub simulator. Its focused check
passed: a completed merge adds no `reviewed` label and makes no second arm attempt.

The historical witnesses exercised `continueFeature`, `publishFeatureNativeResult`,
`consumeWatchExit`, and `requestFeatureSessionPause` in the retired Feature coordinator.
They used disposable Git, the strict GitHub simulator, fresh Bun processes, distinct
homes and cold checkouts. The old handler used its source-module loader and an
external API stand-in; this was not a running OMP session. Assertions inspected
durable controls, original action bindings and refused effects, not message wording.
The CLOSED-watch case proves a stopped result, not a successful MERGED landing.

A separate runtime smoke used the locked OMP 18.12.6 agent parser and both source
and distributed strict schemas. Typecheck and Biome on the eight changed TypeScript
files passed. These are not a full suite result, a C2 deterministic-generation/parity
proof, a C4 lifecycle qualification, model-obedience evidence, hosted GitHub
validation, installation, or merge activation.

### Existing review and landing safeguards

The [trusted delivery CLI](#trusted-feature-delivery-cli) is `/feature`'s only merge path; it performs a head-pinned merge without arming auto-merge. Legacy head authorization, hosted CI and disarm safeguards remain separate. The composed flow's two correction rounds are counted per invocation, not by canonical final reviews per PR.

The review bound is two automated corrections per PR (#710), derived again on every
read from complete canonical `review` records whose native author is the automation
login (`gh api user`). The count and the latest review come from that history. A
refusal is not an empty history. Nothing writes accounting. A legacy marker is not a
review and does not reset the bound.

A spent native bound remains a stop for native review/correction and hosted structured admission. Revised work requires separate operator scope and a superseding PR; the original dossier and records remain evidence. It does not restore the removed local landing command.

#### Trusted Feature delivery CLI

Run from the canonical worktree using the installed skill directory reported by the host, not the candidate's copy:

```sh
bash "<skill dir>/trusted-bun.sh" "<skill dir>/feature-cli.ts" <sub> --repo <owner/repo> --issue <N> --mandate <recordId> [args]
```

Every effect rechecks the live, applicable mandate. Inactive or mismatched authority refuses.

The non-finish effects also require the mandate base to be the repository default branch. `push` rechecks the `origin` push URL immediately before writing. Use the installed launcher so target configuration and `.env` loading cannot change startup.

On approval, `/dev-review` posts `review-verdict v1 head=<sha> approve evidence=<url>`; the Review Verdict workflow turns it into the `review` check for that exact head. A new head needs fresh review and verdict. With no verdict lock, stop for the operator rather than falling back to legacy arming.

| Subcommand | Checks and effect |
|---|---|
| `push --tip <sha> [--from <sha>] [--pr <N>]` | Match the mandate branch and verify the sole `origin` push URL names the repository. The tip must descend from the base on first push or from `--from` on update. Omit `--from` only for an observed absent branch. Correction requires `--from` and the bound open `--pr` at that head. Push the exact commit with a lease and no tags, then read back the remote tip and correction PR head. |
| `open-pr --tip <sha>` | Verify the published tip and a nonempty branch delta. Create or reuse one matching PR and confirm its `workflow-binding` against the mandate, head, branch and base. Ambiguous matches refuse. |
| `land --pr <N> --head <sha>` | Verify the bound PR and exact head. The base's active rules must require `review`, or the CLI refuses with `no-verdict-lock`. GitHub enforces the configured `review` + `ci` ruleset on that head. For an open PR, attempt `gh pr merge <N> --repo <owner/repo> --merge --match-head-commit <sha>` once, without auto-merge, bypass or a `reviewed` label. Read back the merge; pending/red checks or head movement are not success. |
| `finish --pr <N>` | Verify the bound leaf PR is merged. A successful `review` check read by the merged PR head SHA is delivery proof; admissible historical structured-review proof remains readable. Use `closeLinked` for calculated UW completion and verified closure. |

Exit 0 emits one JSON status: `pushed`, `already-published`, `created`, `existing`, `merged` or `finished`. Exit 1 emits `refused`, `waiting` or `uncertain` with a reason; observe before retrying. Exit 2 is a usage error on stderr, with no effect.

#### Legacy Kit merge-on-green head authorization

An existing Kit merge-on-green integration reads authenticated `kit-head-authorization:v1` PR comments; `reviewed` is only a hint. The grant binds immutable repository and PR identities, PR number, reviewed head and base ref. The manual CLI rechecks identity, scope and predecessor before issuing, and confirms the grant by readback. A newer withdrawal denies all lanes. Dependabot grants additionally bind the evaluated base SHA. Issuing a receipt does not enable native auto-merge or merge the PR.

Configure trusted repository Actions variables `HEAD_AUTH_REPOSITORY_ID` (numeric
repository ID), `HEAD_AUTH_OPERATOR_IDS` (JSON array of numeric trusted human IDs),
`HEAD_AUTH_APP_ID` (numeric CI App ID), and `HEAD_AUTH_BOT_USER_ID` (numeric bot
user ID). The plugin reads these through the repository Actions variables API, not
the local process environment. All four are required for this receipt protocol.
Without them the manual CLI refuses; partial or unreadable policy fails closed.
Operators use their authenticated `gh` identity; the machine issuer must match both
configured App and bot identities and the PR must be authored by the real
Dependabot identity. The existing target-only CI App credentials are used; these
variables are not secrets.

For an operator-supervised independent review, invoke the installed plugin's
trusted launcher from the target repository:

```sh
bash "$PLUGIN_ROOT/skills/feature/trusted-bun.sh" "$PLUGIN_ROOT/skills/feature/head-authorization-cli.js" inspect --pr "$PR"
bash "$PLUGIN_ROOT/skills/feature/trusted-bun.sh" "$PLUGIN_ROOT/skills/feature/head-authorization-cli.js" issue-manual --pr "$PR" --head "$REVIEWED_SHA" --evidence "$EVIDENCE_REFERENCE"
bash "$PLUGIN_ROOT/skills/feature/trusted-bun.sh" "$PLUGIN_ROOT/skills/feature/head-authorization-cli.js" withdraw --pr "$PR" --reason "$REASON"
```

Set `PLUGIN_ROOT` to the absolute path of the installed omp-build directory. The
launcher keeps the target repository as working directory, explicitly selects the
installed Bun and compiler configurations and disables automatic `.env` loading.
Do not invoke the CLI with naked `bun` from a target repository: its configuration
can change startup or module resolution before the CLI runs.

Manual issuance requires the exact reviewed lowercase 40-hex head and an opaque
evidence reference; it does not parse a review report or bypass native ownership,
spent-bound or refusal guards.
It uses the current authenticated `gh` operator and reads the repository Actions
variables through the API; exporting local environment variables is not a substitute.

`inspect` reads the current grant state; `issue-manual` issues a grant for an independently reviewed head; `withdraw` publishes its revocation. Withdrawal alone does not prove native auto-merge or a `reviewed` label was cleared. For confirmed containment, read back both the applicable receipt and native PR state.

The stream is append-only by publisher contract, not immutable GitHub storage:
trusted deletion or editing can erase history. Trusted operators, default-branch
writers/dispatchers and App managers remain in the trust boundary. GitHub reads
and merge are not atomic; a change after the final read remains a residual risk.
Returning to the identical head without an accepted withdrawal can match again;
authority for one head never authorizes another.


#### Existing arms and disarm

The surviving `workflow-gate.js` reads native PR state and, where configured, Kit authorization. Retiring native review/fix admission and pause/abandon use its disarm checks: disable auto-merge and remove `reviewed` when present, withdraw applicable authorization, and confirm the result by readback. An unreadable or still-armed PR is not a confirmed disarm. This code does not arm a new merge.

Standalone `/ci-watch` observes the existing merge state using `workflow-readiness.js`: committed base `landing.mode`, otherwise `merge-on-green` if that workflow exists on the base, otherwise `native`. It does not advance Feature or restore an arm.

#### Legacy hosted structured admission

| Condition | Admission requirement |
|---|---|
| Current review and bound | The latest review approves the current head and the review bound is unspent. |
| CI | Red or unreadable CI refuses. The hosted native auto-merge workflow may arm on pending CI only for an otherwise admissible approved head; GitHub still requires checks before merging. |
| Normative inputs | The accepted configuration and effective Spec with its full version vector, current eligible delivery data, code head/base and pinned repository/plugin/context references reconstruct the approved `/4` manifest digest without the local dossier. PR prose and the review's own outputs are excluded. |
| UW admission | The fresh complete native graph, parsed own proposal, confirmed identity history, accepted ancestor/child versions, tier, coverage and calculated blocker states satisfy the shared UW admission rules at this invocation. |
| Authentic outputs | The expected automation author published every record that establishes the selected review's verdict and findings: its review, inventories, decision, synthesis and finding contributions, and their bound inputs; it also published the workflow binding and mandate chain. Every selected part has readable native `createdAt` and `updatedAt` values, and no part was edited. |

Legacy landing reads `omp-build-mandate/4`, `omp-build-spec-assessment/3`, historical `omp-build-action-receipt/2` and `omp-build:review-input/4`. Incompatible formats and obsolete fields refuse; no migration, automatic renewal or cross-format recovery is implied. An active 0.17.x mandate with the removed grouped-fix action refuses `unsupported-graph`: pause or abandon it under 0.17.x before upgrading. A genuinely abandoned or revoked, conformant UW can still be eligible for `/feature new`. An older incompatible mandate or history held by an unconfirmed native normalization receipt cannot be repaired by pause or succession; start a new UW.

In the retired Feature graph, an adopted open PR moved directly from `ready` to `review`.

Behavioral evidence is required by criterion at every tier. A satisfied criterion cites an admissible, code-bound test or observation; content reading alone cannot establish behavioral satisfaction. Bug restoration needs a failing-before/passing-after test or an admissible observed restored behavior. Missing, unverified, proofless or absent criterion verdicts mechanically request changes even with zero findings. Reviewers judge truth and applicability; the engine checks structure, references, versions and the resulting rule. Correction falsification remains a separate obligation; neither green CI nor a digest replaces this review.

The repository's separate `.github/workflows/auto-merge.yml` invokes pinned `plugins/omp-build/scripts/review-gate.ts` for the legacy `reviewed` wakeup. After admission it can enable GitHub auto-merge with `--match-head-commit`. A label alone is not admission. Kit merge-on-green instead uses the scoped authorization protocol above. Neither is part of composed delivery, nor makes GitHub reads and merge atomic.

When an admitted PR merges during landing observation, the base ref has advanced to the merge commit. Review-input revalidation uses the captured pre-merge base only when the native merge commit's two parents match that base and the admitted head; other input and authority checks remain fresh. A different or unreadable merge ancestry does not grant this exception.

Freshness is per transition and per admission invocation, not a time-to-live. A newly observed blocker stops the next transition rather than interrupting the current action. Final hosted admission reconstructs current manifested inputs, then rereads required blockers, applicability and PR coordinates at its last admission seam. This is not an atomic transaction with later GitHub mutations.

The hosted reader needs readable metadata, issue/PR comments and histories, Git/Contents objects and CI checks/statuses for every required repository, including the pinned plugin repository and inter-repository dependencies or evidence. The existing App-token declaration for this repository does not establish access to another private repository. A missing installation right, incomplete page/part or unreadable required source refuses with the missing repository/reference named; local success or a local dossier is not a fallback. Arming/writing permissions are separate from these read requirements.

A canonical record can span multiple PR comments (`part=i/n`); readers accept only a complete record. The header carries the payload and the Markdown is projection. Native authorship and native timestamps establish what the gate read, not a signature or a lasting pin. GitHub reads, review publication, and arming are separate operations, so a change after the last read can remain undetected while an observer retains an arm.

Record authorship under `OMP_BUILD_AUTOMATION_LOGIN` does not separate author and reviewer when that login also owns the PR. Composed Feature instead delegates independent review in the session and relies on the GitHub ruleset.

The same trusted author is used for review records, workflow mandates, and bindings. Any future author separation must preserve durable CI-stop records and keep review reads separate from workflow-authority reads.

GitHub viewer identity is fixed for one OMP process. `gh auth switch` requires a new session; the viewer memo includes `GH_HOST`, `GH_CONFIG_DIR`, `GH_TOKEN`, and `GITHUB_TOKEN` but does not observe an in-place account switch.

The bound guards against agent mistakes, not against an agent that bypasses it:
records by other accounts are ignored, and the bound does not detect edits or
deletions of the account's comments; landing admission separately refuses an
edited selected review, mandate or binding record. Every posted review counts, with or without a fix
before it. Older accounting comments and the `## Review Fixes Applied` receipt
decide nothing.

The retired Feature graph used `continueFeature` and `reconstructWorkflow` for next-action selection, including CI attribution and watch exits. Composed `/feature` observes Git and GitHub directly. The hosted legacy gate has no callback into it.

The trusted auto-merge checkout (`.github/workflows/auto-merge.yml`) reads canonical records only from tooling pinned by repository variable `OMP_BUILD_TOOLING_SHA` (40 lowercase hex). It derives the expected author from `--automation-login` for records, the landing mandate and its binding/parent chain, and the selected review. The gate never calls `gh api user`, which installation tokens cannot use. A missing or non-hex pin refuses. There is no fallback to the candidate checkout, workflow SHA, moving branch, candidate code, or a dependency install; the pin's committed `dist/contracts.js` is the reader.

The workflow uses `pull_request_target` so GitHub selects its arming logic from the base repository's default branch, not the PR merge ref. The candidate is an isolated, credential-free data checkout. Bun runs only from the pinned tooling directory, with ambient Bun/Node preloads cleared; candidate scripts, configuration, and dependencies are never executed. A trigger change takes effect only after it reaches the default branch; a local shell smoke does not prove hosted trigger selection.

Every failed or skipped labeled-path admission has a final job-token cleanup, including App-token mint failure. It independently attempts native auto-merge disable and `reviewed` removal, then reads both back; failed writes or a remaining arm are errors. Cleanup never depends on the App token used by the reader. Dependabot is eligible only for semver-minor or semver-patch updates whose every commit author is `dependabot[bot]`.

Admission requires a mandate's `productVersion` to equal the version of the pinned tooling; otherwise it refuses with `config-drift`. The repository variable is the only record of the current pin:

```sh
gh variable get OMP_BUILD_TOOLING_SHA --repo Roxabi/roxabi-plugins
```

#### Tooling-pin update

After every merged omp-build version bump, set the variable to the full `main` SHA that carries that distribution, then update and restart the installed plugin. Until the pin moves, the hosted gate reads with the previous version and refuses mandates published by the new one.

#### Isolated session tooling pin

When a separately installed distribution intentionally differs from the shared source pin, set the target GitHub repository's `OMP_BUILD_TOOLING_SHA` to the full lowercase 40-character source commit and run `/tooling-pin activate` in the root TUI. Review the source, installed version, package digest and target clone, then explicitly confirm. The candidate must be on the installed source repository's default-branch ancestry and match the installed package bytes. This is an explicitly confirmed commit selection, not a minimum-version or upgrade-only policy: an older matching installation may qualify. A matching or unreadable shared pin, active native work, child session or headless invocation cannot activate it.

`/tooling-pin status` reports the current pin. Approval lives only in this extension instance and confirming root session, scoped to the current GitHub repository and clone, including linked worktrees. A same-session `/move` retains it; a session switch, branch or tree selection, shutdown or reload requires fresh confirmation. Clearing conversation context does not itself revoke activation if the session and agent identities remain unchanged; a changed identity makes it unusable. The root and clone checks still apply. Invalidation does not replace a pin already captured by a surviving admitted operation; its existing origin, stop and control guards still apply. Activation creates no UW or workflow authority, changes no shared pin or installation, and does not alter the hosted gate.

A product-version bump changes the effective workflow config digest. Complete or genuinely abandon active mandates before an incompatible activation. If the current reader cannot authenticate abandonment, retain the blocker and request an explicit owner recovery decision; a source fix or manual merge grants no cutover exception. After applicable activation prerequisites, a genuinely abandoned, conformant current-format UW can use `/feature new #N` for a fresh same-UW successor with current checks and a new config pin, not continuation of the old authority.

```sh
gh variable set OMP_BUILD_TOOLING_SHA --repo Roxabi/roxabi-plugins --body "$MAIN_SHA"
omp plugin marketplace update roxabi-marketplace
omp plugin upgrade omp-build@roxabi-marketplace
```

### Legacy hosted activation prerequisites

- **W1 — event policy:** configured in policy `8844` to allow `pull_request_target` and `push` for `.github/workflows/auto-merge.yml`.
- **W2 — secret visibility (deferred, #892):** `ROXABI_CI_APP_PRIVATE_KEY` is an organization secret visible to all repositories, so a workflow on any branch of this repository can mint the `roxabi-ci` token. Deferred on 2026-10-25 under the single-operator decision. Only the operator or their agent pushes branches here, and forks and Dependabot receive no organization secrets. This workflow does not declare `environment:`. #892 lists the triggers to reopen and the change.
- **W3 — App token permissions:** the `roxabi-ci` installation grants checks read, contents write, issues write, pull requests write, statuses read and workflows write (observed 2026-10-25). The minted token is scoped to this repository, as before, and narrowed to checks read, contents write, issues read, pull requests write, statuses read and workflows write. Contents write performs the native auto-merge; workflows write lets it merge a PR that changes `.github/workflows/`. An explicit parent scope in another repository stays unreadable and refuses.

The separately authorized T5 capability check passed in [run 40180871966](https://github.com/Roxabi/roxabi-plugins/actions/runs/40180871966). The gate reads with the App token (`GH_TOKEN: ${{ steps.app.outputs.token }}` in `.github/workflows/auto-merge.yml`), not the job `GITHUB_TOKEN`; job `issues: write` does not apply to that App token ([workflow permissions](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions) cover the job token only). With the App token narrowed by W3, the run exercised reading issue bodies and comments, including the explicit parent scope [#720](https://github.com/Roxabi/roxabi-plugins/issues/720), PR coordinates and rollup, and the trusted gate's selected-base Git fetch through its process-local credential helper. The real reader ran and refused a PR without a record with `reviewed-head-mismatch`; the token then armed native auto-merge. The credential helper does not persist credentials. This historical capability run is not admission evidence for another PR and does not prove access to private repositories. Local transport smoke coverage likewise does not prove that access.

This is not a new tamper control.

## Bounded correction recovery

In the active OMP root, `/uw` or a refused native correction can expose an inspection hint for the retiring `omp_build_recover_interrupted_fix({ pr })`. The hint is factual, not eligibility. The tool rechecks the release/pin, accepted Spec, mandate, UW/PR binding, current head, controls, history and owner before proposing recovery and again before effects. Root-operator confirmation authorizes only the displayed recovery.

| Observed retiring correction | Confirmable transition |
|---|---|
| Authenticated opening, torn C0 or R, no native/startup or correction-plan entry | Neutral closure; a subsequent native `/fix` can create a fresh canonical attempt on the same UW/PR. |
| Complete R before native intake/decision | The same neutral closure; old predecision findings do not transfer. |
| Existing-review-bound R/D, genuinely unspent correction execution | A new confirmed owner executes the same R and D with the original logical run and unchanged bounds. Pending or infeasible obligations still hold. |
| Native/startup or plan entered; witness missing; ambiguous effects or authority | Reconciliation hold. No generic cursor restoration, post-push completion, or automatic local cleanup. |

The originating host seals admission and joins the real tracked driver, Git/source publications, streams and callbacks before preparing its no-entry witness. Preparation trusts the maintained host operations; it does not certify every custom helper or establish generic descendant cessation. The final witness publication is a bounded immutable self-write, not permission to resume source work. A live origin additionally requires its retained in-memory attestation; a cold origin requires compatible, positively observed process-lifetime evidence. A clean tree, completed task or free mutex is insufficient.

One protocol-checked process context connects source, bundled and reloaded host operations. Cohorts, fences, reservations and receipts remain owned by their originating run; sharing context does not create shared workflow authority. Incompatible context protocols refuse operation rather than silently splitting observation, and finishing one run never resets another run's context.

Every start holds the same publication-destination OS mutex through its tracked driver. It is independent of checkout, OMP profile and recovery qualification. Linux uses its native network-namespace lock domain; Windows uses the native global mutex; Darwin uses a protected persistent sidecar under the OS-account home, not an environment-selected HOME. Darwin sidecars are never unlinked or treated as stale workflow state. Kernel release, explicit release and normal termination are logical exclusion facts, not no-entry witnesses or durable-owner resolution. Physical-host exclusion across isolated Linux network namespaces is not claimed.

Positive recovery requires Linux-qualified host observations, including compatible boot, UID, process and namespace identities and the protected runtime-root observations. Missing qualification leaves ordinary corrections available under the real mutex, but their interrupted owners remain held. An unavailable Linux network-namespace observation never qualifies recovery or changes the mutex key. Darwin/Windows runtime qualification of this new host path is not claimed.

The engine owns owner/claim admission and confirmed `fix-recovery` replay. Owner/claim records live on the UW; C0, R, D and recovery controls live on its bound PR. GitHub adapters retain raw records and fragments; ordinary UW, correction and review consumers use the same authenticated effective projection. Late retired fragments cannot reopen a closed attempt; unrelated corruption remains blocking. Embedded pinned catalogue bytes make historical replay independent of current catalogue availability, while new execution still requires current ordinary preflight. Neither recovery nor owner termination relaxes final-head proof, review, pause or landing gates.

Qualification distinguishes native scenarios from the complete-C0/torn-R protocol case. No valid current public producer input yielding a multipart R at the fixed 65,536-byte limit has been established. That case uses an explicit reduced test framing limit and structural origin fixture at the engine/adapter boundary; it is not native origin/witness or default-limit reachability proof. Production framing is unchanged, and this exception does not replace the other native recovery requirements.

## Guards

The plugin arms its guard chain **in-process**, through `omp.extensions` → `omp/index.ts`. It intercepts `tool_call` and refuses, before the tool runs:

| Tool | Refusal |
|---|---|
| `bash` | bare `bun test` (`bun run test` passes) |
| `bash` | `git switch`/`checkout` off `staging\|main\|master` **in the principal worktree** — escape hatch `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1` |
| `write`, `edit` | content matching the hardcoded-secret / SQL-injection / command-injection table |

The scan **fails open** above `SECURITY_SCAN_MAX_BYTES` (256 KB): a payload larger than the ceiling is not scanned at all. Once `dev-core` is uninstalled there is no second layer behind this one.

Guards are **off** unless the project declares the host-neutral contract (`.dev/stack.yml` or `.dev/dev-core.yml`); without it the interceptor is a no-op and warns once per cwd.

`omp/guards.ts`, `hooks/`, `agent-sources/R-*` (except `R-advisor`) and `skills/shared/` originate in a **self-contained snapshot** (ADR-020): omp-build resolves nothing through a sibling plugin at runtime, so it stays installable on its own. The snapshot is not resynced. Model selection and the Discovery rules on the five review agents are maintained local divergences, not a resync.

`skills/shared/` holds `lib.sh` (base-branch / worktree helpers, sourced as `. "$SCRIPT_DIR/../shared/lib.sh"`) and its `artifact-classify.ts` closure. No `references/` directory travels: the one reference a snapshotted agent cited is inlined into `R-architect` itself, because a `${CLAUDE_PLUGIN_ROOT}` token only expands in SKILL.md bodies — never in an agent body, and never at all in this plugin. No skill sources `lib.sh` any more; only its tests run it. Cleanup no longer classifies or deletes branches.

> **Known caveat, this slice only.** While both this plugin and `dev-core` are installed, both interceptors see the same `tool_call` and reach the same verdict — the snapshots are byte-identical and read the same escape hatch. Expect the refusal, and the no-contract warning, to be reported **once per plugin**: each extension owns a private warned-cwd set, so neither dedupes the other.

## Worktree bootstrap

`skills/feature/worktree-bootstrap.sh` is the bootstrap contract. `runWorktreeBootstrap` in `roxabi/workflow-checkout.ts` runs it in the foreground after worktree identity is valid and before the Feature handoff: before successor publication on `/feature new`, on the first mandate, and on select, resume or new in an already valid worktree. It refuses the principal. `omp-build-bootstrapped` and `omp-build-bootstrap.lock` are environment cache, not business records. `/feature init`, bare checkout preparation and session or agent start do not run it. Do not run it as a second process.

- The script holds a lock in the git dir, so repeated explicit calls wait for a running invocation and then no-op.
- omp-build does not automatically copy or build a ccc or codegraph index and requires neither CLI. Project-configured `worktree.copy`, `worktree.seed` and setup still run normally.
- Worktree lists and setup scalars are read with Bun.YAML (Bun ≥1.2.21) before any transfer. Flow/block string lists agree and `[]` means no transfer. Invalid YAML or consumed list types fail with the stack filename, leave no completion marker and release the lock. A non-empty `worktree.setup` runs as a Bash snippet; absent, empty or whitespace-only setup falls back to the file declared by `commands.worktree_setup`, from the worktree root. A failed setup also stays retryable. `feature init` preserves a declared setup command instead of adding an empty override. Cleanup uses the same YAML parser for the principal's `worktree.base`, preserving environment > stack > default precedence and quoted/block scalars.

## Agents

`agent-sources/` contains the frozen authored agents: two OMP-native (`R-advisor`, `elon` — `model: "@advisor"`, typed `output:` schema) and five `dev-core` review snapshots (ADR-020 decision 7). `agents/` is generated output: seven copied authored agents plus 18 generated native profiles; do not edit it. The five review snapshots declare `@review, @slow` for the judgment agents `R-adversarial`, `R-architect` and `R-security-auditor`, and `@task` for `R-devops` and `R-tester`. When an unmapped role still hands the choice to the parent is stated below the table. Every authored agent carries an explicit `tools:` pin: the snapshots arrived with their posture stated in prose only, and a read-only floor whose read-only-ness is unenforced is not a control.

Agent-profile `tools` pins the child's built-in capabilities. Composed `/feature` uses ordinary `task` agents. The retiring native runtime still uses sealed batches through its owned execution tool; this is not a credential sandbox.

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

The parent-model fallback described here applies to ordinary built-in spawns. An owned workflow batch starts its child on the model route resolved from the agent's role and refuses a spawn hook whose route differs from it, fallback entries included; after start, OMP's configured model fallback applies as in any session.

For ordinary operator-directed spawns outside an owned workflow batch: `task` `{ agent: "R-adversarial" | "R-advisor" | "R-architect" | "R-devops" | "R-tester" | "R-security-auditor" | "elon", ... }`. Owned workflow batches use the execution tool described above. Profiles are read from `agents/` of whichever package root is in the extension lane — the `link` symlink, or the marketplace install's `node_modules` symlink once it is listed in `extensions:`. `R-advisor` is a spawnable task agent, **not** the session WATCHDOG (`advisor.enabled`).

`R-frontend-dev`, `R-backend-dev`, `R-fixer`, `R-doc-writer` and `R-product-lead` are deliberately absent (ADR-020 decision 7): their concerns fall to the `R-adversarial` floor through the sibling-drop rule.
Retiring native `/fix` can dispatch `R-review-fix-intake`, `R-review-fix-synthesis`, `R-review-fix-apply` and `R-review-fix-falsify`. Composed `/dev-fix` uses implementer agents instead; neither revives `R-fixer`.

For built-in task spawns without a `model`: explicit call model, then `task.agentModelOverrides`, then this frontmatter, then the active parent. An operator override for an agent masks the manifest role until it is removed. A role alias in an override expands through `modelRoles`, `@default` included, and OMP uses the override only when that expansion yields at least one model; otherwise it skips the override and reads the frontmatter. `R-devops: "@default"` therefore pins the configured `modelRoles.default`, not the parent's live model, and has no effect while `default` is unset. In omp 18.8.0 the parent's active model is taken by a per-call `model` entry `@default`, a single-entry frontmatter `@default`, and a single-entry frontmatter `@task` while `modelRoles.task` is unset: `R-devops` and `R-tester` run the parent's model until the operator maps `task`. The two-entry `@review, @slow` never takes that path; only the credential fallback above reaches the parent. This describes generic built-in task spawns, not the owned native workflow dispatch.

## Skills

| Skill | Lane |
|---|---|
| `feature` | `/feature` prepares a leaf delivery and supplies `SKILL.md` with the mandate and worktree context. |
| `dev-review` | Standalone `/dev-review` or composed Feature review · independent agents (`R-adversarial` floor), one findings comment and a head-bound verdict when approved. |
| `dev-fix` | Standalone `/dev-fix` or composed Feature correction · fix current findings and failing checks, push the exact tip, then review the new head. Composed mode uses the delivery CLI. |
| `promote` | `/promote` (registered command) · the optional tail |
| `cleanup` | `/cleanup` · read-only inventory, then explicitly selected guarded removal; optional manual `--force` requires local-data discard approval; branches preserved |
| `ci-watch` | `/ci-watch` (registered command) · watches checks, then the merge |

The retiring native review and correction pipelines retain evidence-backed [cause dispositions](GLOSSARY.md), exact-confirmed sisters and reports on the original UW. Composed review and correction follow their installed instructions instead.

`/dev-review` finds its checklists (`evidence-policy.md`, `review-blind-spots.md`, `review-smells.md`) through the `[Skill directory: …]` line that the registered command appends to the body.

`promote` and `cleanup` are optional after confirmed `finish`, never automatic or inside the review → fix loop. `/feature` offers `promote` only for `release.model: staging-train`, not trunk. `promote/preflight.sh` is read-only; its merge rules are in `promote/SKILL.md`.

### Worktree-only cleanup

`/cleanup` inventories the current repository without mutation. Repeated
`--repo <path>` selects repositories; repeated `--root <path>` discovers nested
repositories and archives. `--all` now discovers below the current directory
instead of acting as a synonym for a single-repository sweep. Linked worktrees
are deduplicated by canonical Git common directory. Discovery exclusions and
observation errors are explicit; a partial report is not an empty inventory.

The bundled `skills/cleanup/worktrees.ts` exposes `inventory` and one-path
`remove`. Removal re-inspects the inventory token, path identity, retained HEAD,
local data (tracked changes, untracked files, ignored data and index-hidden
files), locks, in-progress Git operations and observable same-user process
usage. Detected active usage always blocks. Unsupported or incomplete usage
observations stay explicitly unknown and require an additional human
confirmation for that path, carried as `--ack-unknown-usage <path>`. Structural
preservation reasons remain blocking in every mode; there is no blanket override.
Process observations do not prove that every agent session is idle. Tokens and
CLI confirmation flags are selection data, not evidence of human consent. The
human text inventory omits tokens; `inventory --json` carries them.

In safe mode, ignored data is classified from the same `git status` pass; only
entries Git already ignores can qualify, each under the exact path Git reports. A fixed,
case-sensitive allowlist with no repository override recognizes dependency
directories (`node_modules`, `.venv`) and caches (`__pycache__`,
`.pytest_cache`, `.ruff_cache`, `.cache/trufflehog`), including entries Git
lists inside them, regular `*.tsbuildinfo` files, and build/test output
directories (`.astro`, `dist`, `test-results`) only when Git reports the
directory itself as ignored. Every other ignored entry keeps the worktree,
including `.env`, databases, a file Git lists individually inside a build-output
directory, any `.git` path, a file or symlink bearing a directory name, and
exposed names matching a partial, defense-in-depth sensitive-name list; truly
untracked files and tracked changes keep it too. A directory Git reports as one
entry is approved as a whole subtree: file contents are never read, names do
not prove regeneration, and any manual dependency patch, secret or state inside
it is deleted with the worktree.

Before such a row becomes removable, a metadata-only walk of the recognized
entries (names and no-follow file types; no file contents, `HEAD` or Git
configuration read, no symlink followed) keeps it on a Linux mount point at or
below the worktree, a nested `.git` of any type, a directory holding `HEAD` next
to Git directory names, a special file, a symlink or replaced directory where
Git saw a directory or regular file, or any observation error. `git worktree
remove` would otherwise delete nested repositories with their refs and stashes
and recurse through mounts. The walk detects Git metadata only; human approval
must exclude any other version-control checkout or unique data. Other platforms keep artifact rows, and the mount
table is reread immediately before removal. The walk is one non-atomic pass, so
writers and mount changes must stop before selection. A row with recognized
artifacts additionally requires the human to confirm their disposability for
that exact path, carried as `--ack-ignored-artifacts <path>`; the flag is
rejected where fresh inspection finds none. The token binds every reported path
and kind, so an entry that appears or vanishes stales the selection. Ignore
rules are never edited to unlock a row.

Manual `inventory --force` is still read-only. It assesses registered or detached
worktrees for explicit abandonment of tracked/staged changes, genuinely
untracked files and ignored data, including sensitive or unrecognized entries.
It reports exact `localEntries`, `ignoredEntries`, the `removalMode` and whether
`requiresDiscardConfirmation` applies. The operator must select exact paths and
approve the loss of all those data before `remove --force` may carry
`--ack-discard-local-data <path>`. This replaces the artifact acknowledgement in
force mode, not the separate unknown-usage confirmation. A broad cleanup request
or a CLI flag does not constitute approval.

Force walks the entire worktree without following symlinks or reading payloads,
not just allowlisted ignored roots. All structural and active-usage guards remain
blocking, including index-hidden files, initialized submodules, retained
administrative `modules/` data (even without a visible gitlink), nested Git,
mounts and an unretained detached HEAD. Its token binds the mode, exact status,
index and a deterministic worktree-metadata fingerprint, including ignored-root
contents. A changed observation requires a new inventory/selection, and changed
data to abandon requires renewed human approval. Metadata is not a content hash
or an atomic lock: stop writers and mount changes before selection. See the
[manual-mode contract](skills/cleanup/SKILL.md#manual-force-mode).
Git status disables fsmonitor/untracked-cache shortcuts, and force rechecks
observable process usage after the tree walk before mutation.

Safe registered worktrees use ordinary `git worktree remove`; an explicitly
approved manual force row uses exactly one `--force` with that command. Both
preserve branch/tag refs and their reachable commits, merged or not. Removal is
not atomic: a failure may leave a partially removed directory, reported as
observed with no automatic escalation, pre-deletion, raw fallback or additional
force.

The complementary orphan scanner retains configured feature, legacy
`~/.omp/worktrees/<repo>` and principal `.claude/worktrees` roots. Only freshly
revalidated empty shells can be removed, using `rmdir`; nonempty shells remain
diagnostic and force does not unlock them. `--scope <#N>` filters exact branch
issue numbers and excludes unattributed shells. `--report-only` stops after
inventory; `--yes` is rejected. Branch deletion, fetch/prune, GitHub labels and
CI cancellation are outside this workflow and require separate operator mandates.

**The names are deliberately not `R-dev-review`/`R-fix`.** Skill discovery dedups by `name` across every provider, first-wins. `dev-core` is archived and is not an installable sibling. Snapshotted agent bodies still call the workflow `/R-dev-review` in prose; that is a label, not an invocation, and the reviewer brief from `skills/dev-review/SKILL.md` is the contract they actually obey.

## Maintenance

Lint-only fixture changes must preserve the emitted shell text and cleanup/release safety behavior, not replace executable checks with source-text assertions. Publish OMP changes with matching, newer versions in `package.json` and `.omp-plugin/marketplace.json` so the version-keyed install cache is refreshed.

### Canonical source ownership

| Responsibility | Direct source owner |
|---|---|
| Record values, shapes and construction | `engine/record-values.ts`, `record-schema.ts`, `record-construction.ts` |
| History integrity, conservation and review decisions | `engine/history-*.ts`, `review-*.ts` |
| Deterministic human projection | `engine/record-projection.ts` |
| Workflow authority and Spec continuity | `engine/workflow-control.ts`, `workflow-*-admission.ts`, `workflow-accepted-spec*.ts` |
| Installed public contracts | `contracts.ts` is the actual flat distribution entry; consumers load generated `dist/contracts.js` |

Source callers import the canonical owner directly. Removed engine aggregate paths have no compatibility re-exports. The engine and GitHub adapters compile together inside the contracts bundle; they never import a previous generated bundle. Installed Roxabi/OMP/skill consumers use that bundle for engine runtime values and type-only source imports for canonical types, so catalogue installation does not require the repository's development dependencies.

The root declaration bridge retains published types; it is not a mirror of every new domain alias. New UW types are exported by their canonical owners and imported type-only. The #897 model cutover replaces the former root types `AcceptedSpec` and `AcceptedSpecRef` with `AcceptedOwnSpec` and `AcceptedSpecStep`, without compatibility aliases.

| Product boundary | Canonical source owners |
|---|---|
| Review, correction and standalone fix | `roxabi/review-contract.ts`, `review-dispatch.ts`, `correction-plan-*.ts`, `fix-entry-{lifecycle,ci}.ts` |
| Leaf Feature admission and delivery | `omp/omp-feature-command.ts`, `roxabi/feature-live-mandate.ts`, `skills/feature/{SKILL.md,feature-cli.ts}` |
| UW linked closure | `roxabi/uw-linked-closure.ts` owns fresh binding/graph proof, native state mutation and readback; `uw-installed-operations.ts` composes its ports |
| GitHub history and publication | `adapters/github/`, `adapters/github-workflow/` |
| Retiring native OMP capture, settlement and lifetime | `omp/review-runtime/`, `omp/omp-controller.ts` |

The Feature handler hands off scoped leaf delivery to the installed instructions. Its delivery CLI rechecks live authority for each effect; it does not reconstruct a native action graph, publish native results or consume watch exits.
The review class catalogue has one source: `skills/dev-review/review-classes.yml`. The aggregate plugin validator checks that this complete asset is readable UTF-8, valid YAML and non-empty, and validates its declared subsumption-pair notes. Native panel and recall tasks receive the canonical catalogue itself. This preserves guidance delivery, not proof that a model obeys subsumption rules; final labels remain model judgments, not classifications repaired by the engine.

History merge guards avoid serializing a retained native-decoded history against itself. Distinct objects still receive the complete conflict comparison; the shortcut retains no cache and skips no fresh observation, closure-growth refresh or selected-history verification.

### Test ownership

Record and engine scenarios share fixtures for histories and external boundaries, without re-exporting the product under test. Cross-boundary native support includes `testing/extension-api-stub.ts` and `testing/review-runtime-support.ts`. Keep expected consumer-visible outcomes in scenarios, outside model inputs. Process-spawning scenarios use `*.integration.test.ts` and own resource cleanup.

Feature tests use the GitHub simulator and disposable Git repositories. Retiring native review and recovery harnesses arrange external state and invoke the canonical product owners rather than implementing alternate admission.

Review-race fixtures finish initial review preparation before arming the Git barrier; only decision settlement overlaps that barrier. The third canonical review case has a 30-second marker bound, a 60-second subprocess bound and a 120-second test budget. The pause race retains the 10-second marker, 30-second subprocess and default integration bounds; the shell release bound remains 20 seconds for both.

The GitHub simulator's shared kernel owns lock, hydration, audit, command handling and atomic state replacement. It does not grant delivery authority or model an atomic GitHub transaction.

Commit and comparison metadata is batched from real Git within each request, retaining exact SHAs, trees, all parents and page order. Range observations and simulator transactions remain fresh; no metadata cache spans requests.

Integration fixtures use lightweight `gh`, pin, and fix-recovery fault clients to send commands to a dedicated simulator server per test file; the server is compiled with automatic loading of ambient Bun configuration and `.env` files disabled, and fixtures pass their environment explicitly. The server path is Linux `/proc`-based. The `gh` client uses a standalone executable for comment-barrier calls, calls made while the state lock is held, and hosts without `/proc`; a nested `gh` call inside a server request fails fast.

The pin client uses its compiled standalone executable when `/proc` is unavailable or a gate or synchronization call must wait. The fault client's release-gate wait stays client-side, and its standalone fallback is a TypeScript script.

### Quality contract

Run `bun run quality:omp-build` for the same owned-source check used by the pre-commit hook and CI. Physical discovery feeds both the line counter and the pinned Biome command; warnings fail, and an empty lint set is not success.

Vitest runs unit first, then integration (`groupOrder: 1`). Unit inherits `min(8, max(1, availableParallelism() - 1))` workers; integration uses `min(8, max(1, floor(availableParallelism() / 4)))` independently. The unit timeout is 5s and the default integration timeout is 60s; scenario-specific fixture clocks are not product limits.

The candidate CI correction lifecycle has a 90-second subprocess clock inside a 120-second case budget. The complete correction and current-head follow-on review finished in 59.8 seconds under a controlled process CPU quota, with all seven candidate-pinned stages checked; its former 55-second clock cut off the same scenario with `SIGTERM/ETIMEDOUT`. This calibrates the finite fixture workload without changing Native admission or consumer assertions. The resource probe does not establish the exact resource conditions of the historical hosted failure.

The physical SDK adoption scenario caps its new-root worker at 420 seconds and its correction/final-review observation loop at 240 seconds. Each physical worker is also limited to the time remaining on a monotonic 720-second case deadline; an exhausted budget fails before another process is launched. A separate CPU-quota observer completed the new-root worker in 372.3 seconds and checked the original request/decision, distinct physical roots, preserved history, changed head, and clean current-head review. The former 240-second parent clock cut off the worker; extending only that clock left its 150-second loop expiring with final-review synthesis still queued. Prelude and old-root phase caps remain 240 seconds. These are fixture budgets, not SDK or Native admission bounds, and do not establish the historical hosted resource conditions.

| Surface | Enforced limit |
|---|---|
| Runtime code, helpers, types, schemas, live configuration and exclusive omp-build tools | 300 physical lines |
| Genuine executable assertion scenarios, not arbitrary files named as tests | 600 physical lines |
| Every owned JavaScript-family function, including CommonJS and scenarios | Cognitive complexity 15 |
| Focused tests | Error |
| Runtime TypeScript promises | Floating and misused promises are errors; declaration, scenario and test-support roles are excluded |

Generated distribution files and retained inert data are distinguished by their actual ownership/provenance, not a blanket test-directory exception. Other plugins and shared root controls are outside these new caps. Parser and AST types are pinned at `8.0.8`, Biome at `2.6.2`; no effect runtime, database or workflow framework is introduced.

### Owned distribution

`agent-sources/*.md` holds seven authored generic agents. The producer copies them into `agents/` byte for byte. The 18 native profiles generated from `roxabi/native-*-profiles.ts` and strict schemas still ship, pending retirement in #1037 PRs 3b/3c. Tests and support stay outside the generated surface.

The single producer, `tools/build-omp-build-contracts.ts`, owns all of `agents/**` and `dist/**`, including the issue-triage runtime slice. Do not edit these outputs. The inventory records each [produced output](GLOSSARY.md#language) (*Sortie produite*) only after a successful write. Duplicate output claims and incomplete build metadata fail.

`bun run build` with no arguments builds in place. Only after all copies, generated files, bundle writes and metadata checks succeed does it remove [obsolete outputs](GLOSSARY.md#language) (*Sorties obsolètes*) and empty subdirectories from `agents/` and `dist/`. It keeps both roots, does not follow obsolete links, and leaves sources and other paths alone. Writes reject linked directories, symbolic links, non-regular files and multiply linked files at output destinations. A generation failure leaves old outputs in place without restoring already rewritten files. A pruning failure fails the build without undoing earlier deletions.

`bun run build --output-root <fresh-owned-directory>` builds only in that destination, without pruning or changing the in-place distribution. It refuses every existing destination (including dangling links and the plugin root) and fresh paths that overlap protected source or distribution paths, including through a linked parent.

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

Git reads used by verification have a finite 64 MiB buffer to accommodate generated contracts larger than the process default; exceeding it remains a failure.

The verifier imports the declared extension from an isolated copy of B's plugin subtree through B's lockfile-pinned physical development SDK graph loader and requires a default extension factory. This is cold module-load proof, not `/feature` execution or qualification. Automatic dependency installation remains disabled; ambient `node_modules` ancestors and plugin symlinks remain refusals. The designated host SDK surface is not a plugin npm dependency.

Verification compares complete inventories and raw bytes: candidate = A = B, with candidate and untouched B distribution also bound to HEAD. Comments are not stripped. Modified, missing, untracked/ignored, orphaned or path-dependent outputs are refusals, not approvals. Negative probes exercise the actual verifier CLI and producer only in owned temporary copies; cleanup covers success and failure. CI runs the same verifier before consumer checks; its existing draft-PR skip is unchanged and is not a CI validation.

This is a distribution proof, not evidence of model judgment, hosted landing, installation or activation. It changes neither review records nor execution authority, bindings, bounds or approvals.

Catalogue installation copies the plugin subtree; it does not install npm dependencies. Runtime consumers therefore use the shipped common bundle, which includes Zod; the root development dependency is needed to build it, not to run an installed plugin. No separate npm or issue-triage plugin installation is required.

Parent coverage prompts, canonical graph checkout and Parent integration-pin authentication use that same compiled facade. Those runtime paths must not re-import the Zod-owning source schemas or their transitive adapters; the canonical source implementations remain the producer's inputs.

The clean-import guard also requires a temporary tree with no `node_modules` ancestor. If the default tree is contaminated, a process-local `TMPDIR` pointing to a genuinely clean tree provides environment isolation, not a packaging correction: it changes where owned temporary files are written, never the guard. Remove that override when the default tree is clean; do not delete unrelated dependencies or disable isolation.
