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
| `hooks/`, `omp.extensions`, new or changed `agents/*.md` | **restart** OMP session |
| `agent-sources/`, contracts sources, issue-triage helper source | `bun run build` from the repo root regenerates the distribution. Commit matching sources and generated files before distribution verification. Install does not run the build. |
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

Re-running `/feature` re-observes Git and GitHub. It does not lift an explicit pause. Stop on ambiguous, divergent, closed-unmerged or uncertain delivery until the facts are reconciled. [Parent delivery is suspended](#parent-uw-delivery).

### Controls

`parseFeatureCommand` is the word list. Routine transitions do not ask again; explicit material decisions require genuine operator confirmation. There is no per-PR merge approval.

| Command | Boundary |
|---|---|
| `/feature <reference>` | Publishes or reuses the applicable leaf mandate, then hands off to the composition instructions. Re-entry re-observes Git and GitHub. |
| `/feature resume <reference>` | Checks the runtime version and effective configuration before resuming an ordinary confirmed pause. The mandate's pinned review requirements remain in force. A review-bound or safety stop is not a pause. |
| `/feature pause <reference>` | Inhibits local continuation and publishes the control. Confirmed only after observed disarm. |
| `/feature abandon <reference>` | Revokes the selected mandate, including when that mandate has its own confirmed pause. No automatic renewal. |
| `/feature new <reference>` | Explicit successor over the authenticated own abandoned mandate tip. It names the antecedent, publishes `select-successor` and preserves a compatible existing PR. Historical framing is not current authority, ancestor revocation is not own abandonment, and `/feature <reference>` never renews a mandate. `new init` is this control, not init. |
| `/feature material-decision <reference>` | Opens the genuine operator-confirmation route for the exact authenticated material or unknown assessment. An `accept`/`reject` argv suffix is not authority and is refused. `/uw accept-material` uses the same acceptance chain. |
| `/feature resolve-interruption <reference> [--start <recordId>]` | Always refuses: the current plugin cannot prove non-dispatch of a historical START. |
| `/feature init` | Preview of the invoking checkout; not framing or mandate preparation. |

Historical START and resolution records remain readable. To restart an eligible leaf, run `/feature abandon <reference>` and wait for confirmed abandonment before running `/feature new <reference>`.

Explicit leaf succession retains compatibility checks for accepted obligations and ordered inherited references. Parent delivery and parent succession via `/feature` are suspended.

An existing PR is not automatically replaced:
- Complete own-UW PR facts are collected even when ordinary terminal-state observation omits that scope. Their commitments must survive bootstrap unchanged. Closed, ambiguous, mismatched or unproved bindings stop before publication. Compatible open or merged requests retain their identity; native facts and authenticated binding parts are rechecked before later writes. Publication is sequential, not atomic: a later refusal may retain the new Mandate or selection control, without rollback or automatic replay.

Initial free text and eligible unframed issues enter assisted framing before checkout. The human presses `ctrl+alt+u` to open the staged proposal, not to approve it. `Confirmer` alone authorizes it; `Refuser` discards it, while Escape or `Plus tard` closes without a decision and leaves that exact proposal available to the same shortcut in the same live session and location. After a completed framing, when a move is needed, the human runs `/move <path>`, observes its success and presses `ctrl+alt+u` from the fresh destination to attest it. The same UW continues without retyping the command; checkout preparation is not relocation or a Mandate. The model's read-only `omp_build_framing_submit` tool cannot confirm or attest. Existing resume and successor controls retain their checkout guards. There is no `/wt`.

The editor shows the next action while a framing proposal is ready or the worktree move is pending. The framing confirmation lists the destination and publication effects first, then the final Spec. `Détails` (D) opens the framing audit trail and the exact captured proposal, digest and reference.

The confirmation starts on `Plus tard`. Tab/Left/Right selects an action, Enter activates it; C confirms, R refuses and Escape defers. Up/Down/PageUp/PageDown scroll the current view. Supplied values are quoted with visible line-break and bidirectional-control escapes, without changing the prepared payload. Wrapped continuation rows retain a `| ` marker even when their origin has scrolled away.

Select, resume and new retain the `session-cwd` checkout guard and may stop with `principal-dispatch-refused`; move the session with `/move <path>` as directed.

During intake and framing the read-only gate covers the root extension instance and refuses new task spawns; it does not gate subagents or background jobs started earlier. Hiding a generic confirmation during `/feature` intake is not classification: that gate remains until the decision allows classification or the command is replaced/revoked. The held proposal remains available through `ctrl+alt+u`. USER-attributed entries are not authenticated against other extensions; final approval still requires human confirmation. First words `new`, `pause`, `abandon`, `resume`, `material-decision`, `resolve-interruption` and `init` are parsed as controls, not framed as free text.

A local interruption is not a mandate pause and does not roll back a write already started. Use `/feature pause` or `/feature abandon` to record an operator stop.

Interactive `/feature` and `/uw` confirmations belong to their root command. The session becoming idle leaves a confirmation open; abort, switch, shutdown or command replacement invalidates it. Escape or `Plus tard` keeps the exact proposal pending. `ctrl+alt+u` reopens it in the same live session and location; it does not approve it. A command that was not deferred this way still requires explicit re-entry.

A valid command receives an immediate UI acknowledgment before ports and long remote reads, plus persistent phase status. The shortcut explains preparation, a queued or already-open confirmation, a reopened proposal, an action already applying, or the absence of a confirmation here. It does not prepare or confirm again. A stopped capability cannot roll back an action already started: its feedback is replaced with that warning and retained until the action settles, without vetoing a genuine live successor framing owner. Only its own status is removed; cleanup does not reannounce another command. A predecessor's delayed stop signal cannot revoke its successor.

Neither the shortcut, the default action, nor closing the dialog approves. omp-build 0.21.9 is a manual source change: it is not an activation, tooling pin, installed-cache upgrade or permission to continue a suspended witness.

Workflow history reads revalidate comment pages with GitHub (`If-None-Match`). A `304` confirms the retained in-memory page and does not charge the primary rate limit; a failed request never returns that copy. Unavailable observations retain their refusal diagnostics rather than being treated as empty history.

Late `/feature` and generic root `/uw` command reports, their UI notifications and command-result records stay bound to the original session and agent, live cwd, session file, manager artifact mapping, actual report directory and command ownership. Current failures before or after a held confirmation are reported once; a newer command suppresses the old in-flight command report. An admitted framing handoff keeps only that exact lease's command-reporting permission; controller-owned framing journals retain their existing storage lifecycle. A confirmed choice is not proof that the domain operation published successfully.

Composed `/feature` makes bounded read-only check observations and stops for re-entry when needed. Standalone `/ci-watch` observes independently; it does not advance delivery.

An authenticated Spec assessment binds the exact accepted and proposed canonical snapshots, their source bytes, tiers and accepted-child commitments. Changes to the set of criteria, invariants or exclusions, tier or accepted children are mechanically material. A material or unknown assessment requires a genuine operator decision bound to that exact proposal. Declining accepts nothing and grants no continuation or landing authority.

### Init

`/feature init` and `/feature init --dry-run` are the same preview. The host captures `git rev-parse --show-toplevel`. A failed capture stops and does not frame. Otherwise it runs `bun --no-env-file <plugin>/skills/feature/feature-init.ts --dir <that root>` with Bun's cwd set to the script directory, and forwards only the operator's tokens. It does not add `--approve` or `--operator-approval`.

Tracker planning uses the repository and checkout selected by `--dir`; importing the tracker does not require repository discovery from the installed script directory.

The preview prints proposed stack additions, conflicts, the tracker plan, and a digest, then `digest is not authorization`. A printed digest is not an init reference. Explicit apply is the operator's own `/feature init --approve <digest> --operator-approval '<reply>'`. The CLI refuses a digest used as the approval text. `skills/feature/SKILL.md` states the rest of that boundary.

### Storage and recovery

Three parts, one plugin, no second runtime, no database, and no mandatory local business workflow store. Local environment caches are separate and reconstructible.

| Part | Owns | Does not own |
|---|---|---|
| Engine (`engine/`) | Canonical records, reference/conservation checks, bounded traversal from confirmed histories and landing-mandate admission | Semantic judgement, GitHub calls, merge |
| Roxabi (`roxabi/`) | Feature admission, mandate and worktree preparation, UW operations | A project-defined graph or an admission override |
| GitHub adapter (`adapters/`) | Complete comment history, confirmed publication, scope reads | Finding classification, landing permission |

GitHub comments hold `mandate`, `spec-identity`, `operator-control` and `workflow-binding` records. Retained readers still decode `action-receipt`, `epic-event`, and historical `review`, `correction`, `review-interruption` and `review-replacement-grant` records. Mandates use `omp-build-mandate/4`, Spec assessments `omp-build-spec-assessment/3`, action receipts `omp-build-action-receipt/2`, and review inputs `omp-build:review-input/4`. Incompatible formats, obsolete payload fields and the removed `kind: 'proof'` refuse explicitly. Historical decoding supports UW, completion and Feature admission; it does not grant current authority or imply migration.

Trusted complete workflow records, including retained action receipts, require readable UTC native creation/revision facts on every part, with `updatedAt === createdAt`. Missing or unreadable facts refuse as `record-unreadable`; a revised part refuses as `record-edited`. Foreign observations remain readable but never become authoritative. Foreign copies cannot veto authenticated candidates by reusing their identifiers; missing, conflicting or damaged expected-author records still refuse.

Cause state is durable on its original UW: `cause-disposition`, exact-confirmed `cause-operation`, sister-only `debt-receipt`, and `report-promotion`. Historical reviews reference their complete dispositions through `causeDispositionRefs`. Historical verdicts are not fresh approvals. Admission authenticates the referenced decision, action inputs, accepted Spec and cited observations before a successor can release a hold.

Cause resolution uses the complete authenticated history and the catalogue pinned by each producing action, not the installed copy. Missing, conflicting or invalid evidence refuses rather than inventing a class.
Cause-wait projection discovers cause histories from expected-author claims, including incomplete or invalid claims; a foreign-only cause claim does not trigger that projection. Independent review and causal validation still apply to their own authenticated evidence and context.

External citation loading authenticates external scopes without promoting the raw primary observation to external authority. Incomplete or interrupted primary history remains available for diagnostics, but still refuses review approval; an unreadable, edited or forged external source remains invalid.

Publication treats supplied external histories as scope seeds and refreshes the required evidence before writing and at readback. An idempotent publication is validated against current evidence too. A failure before the first history read reports no observed history (`null`), not a fabricated empty history. Authenticating a retained report does not grant delivery admission.

The committed stack declaration below is the source of review configuration.

The committed `.dev/stack.yml` at `refs/remotes/origin/<base>:.dev/stack.yml` supplies `review.additional_requirements`, recorded as `effective.additionalRequirements` on the mandate. An absent or null list means none. Working-tree edits are not that snapshot. `review.graph`, `review.workflow` and `.omp-build/workflow.json` are not Feature configuration routes.

The accepted Spec, live mandate and confirmed binding establish authority; current Git and GitHub facts determine what work remains. A goal, transcript, local session file or bootstrap marker is not authority. When an effect is uncertain, observe before writing again. Historical START/RESULT records remain readable as evidence of their original action.

The landing binding on every base is the confirmed `workflow-binding` on that PR. A closing keyword, issue body, or branch name is not landing authority.

Issue state is a scope fact, not execution authority. A closed Spec remains readable when reconstructing its bound mandate. Closing an issue neither pauses or revokes that mandate nor approves landing; a closed PR still cannot authorize another review or correction.

#### Historical review and correction records

A `review-interruption` is a neutral terminal for the initial inventory, not a verdict. A `review-replacement-grant` is consumed only by its confirmed linked replacement inventory. Incomplete or conflicting chains do not count as approval or reset the legacy review bound.

Historical `fix-owner` and `fix-request` records show ownership and intent, not completed execution. Confirmed `fix-recovery` records preserve neutral closure or transfer of an unstarted request and its unchanged decision. Replay keeps retired fragments from reopening the recorded attempt; unrelated corruption still blocks. Composed correction does not resume these attempts.

### Criterion delivery and action inputs

For composed `/feature`, the session maps accepted criteria and invariants to code and targeted checks, verifies the committed diff, and commissions independent review of the open PR head.

Retained action-input records include criterion-ID plans and implementation receipts. Each receipt accounts for every criterion at its exact code version, with evidence or an explicit unverified reason. They are evidence, not the composed Feature cursor.

Historical action records bind the full scoped mandate reference, not the accepted Spec's `sourceAccepted` ID. PR review records resolve it through the pinned workflow binding; parent-range review records use their unique authenticated own-UW mandate. Both retain the separate exact `OwnSpecRef` and version vector.

| Evidence method | Required observed material |
|---|---|
| Test | Original command, completed exit status, observed output and an assertion of the exact version exercised. Historical `sdk-view` output is the SDK-presented view, not a complete raw process stream. Missing material stays unverified; a mutable artifact or printed marker cannot authenticate it. |
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

That final read preserves GitHub's documented repository Contents-read permission floor for [App](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-contents) and [fine-grained PAT](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-contents) readers; it does not prove an explicit grant for public resources or identical endpoint-specific enterprise/proxy policy. Additional GraphQL query requirements can refuse even when a REST request would succeed. Preparation, confirmation and replay retain separate fresh cuts, with required blockers re-evaluated at transitions. Unreadable, incomplete or prohibited private cross-repository data refuses without a local fallback; no atomic GitHub transaction or zero-race guarantee is claimed.

Within one selected-record read or replay, references to the same issue or PR share one complete history observation. Each reference still undergoes its own selector, authentication and digest checks. The observation is discarded after the call.

Review admission reconstructs the currently eligible inputs from complete authenticated histories, not just the old manifest's listed records. A new eligible evidence receipt at the same HEAD changes the inputs or produces an explicit ambiguity. The review's own outputs stay outside its normative fingerprint; its authenticated stage annex supplies the records later stages actually need. Prose-only PR edits do not change that fingerprint.

Historical review and correction manifests pin the prior disposition and adjudication lineage as `cause-state` delivery data, not criterion evidence. The review's own dispositions are outputs, not its inputs.

Reconstructing a historical review requires its exact authenticated `review-attempt` reference and persisted input fingerprint. The reference selects the initial outputs; the fingerprint checks input equality, not record identity. A later adjudication changes the applicable cause lineage.

Historical recall inventories retain each task's exact prepared action. A replacement is identified by its confirmed linked root, not an equal fingerprint or the interrupted inventory.

The read-only snapshot indexes criterion and invariant IDs, titles, versions and paths. It includes the pinned diff, records, repository instructions, touched-area glossaries and verified plugin references.

Repository reference discovery uses actual changed paths and paths from the selected authenticated plan to find ancestor instructions and glossaries, including cited glossaries. Planning pins those references at the base; review pins them at the candidate. A planned path need not exist yet and does not create a future code blob: candidate HEAD blobs are collected only for actual changed files. For a first plan without selected paths, discovery inventories tracked `AGENTS.md`, `CLAUDE.md` and `GLOSSARY.md` files at the pinned base and follows their glossary citations. An unreadable required inventory or citation refuses rather than silently reducing context; working-tree bytes are not a substitute.

Historical review manifests pin changed files at candidate HEAD and the context-generation helpers. Local chunk boundaries and context windows are distinct from the common review fingerprint.

Snapshot integrity covers actual paths, entry types and bytes, independently of the portable input digest. A changed, added, removed or symlinked entry invalidates the snapshot.

A historical `missing-context` result binds to its action and inputs; it is not a satisfied criterion, approval or report. To prepare expanded inputs for inspection, `/uw action` accepts `expandedContext` with the authenticated result's `/payload` and genuinely additional pinned references. This produces a distinct fingerprint without dispatching work, renewing authority or resetting a limit.

#### Communication and publication authority

OMP's footer and status show command acknowledgment, phase and confirmation shortcuts. Once ready, `/feature` sends the installed instructions and scoped context to the session.

Framing confirmation presents titled members, repository/UW scope, replacement effects, identity changes and retirements, source accounting and merges, criterion-to-child coverage, foundations, relations and business context. Supplied text is visibly escaped rather than allowed to forge structural summary lines. The full captured proposal, exact digest and detail reference are separate under `D Détails`, not a raw payload in the default view.

The fixed action footer offers `C Confirmer`, `R Refuser` and `Esc Plus tard`. Tab or left/right selects an action; Enter activates it, initially `Plus tard`. Up/down and Page Up/Down scroll the content without moving the actions. The layout adapts to terminal resizing; when too small to present a decision safely, confirmation and refusal have no effect while Escape can still defer. Native buttons remain clickable so their live viewport guard can accept the first action after a height-only recovery. Reopening preserves freshness, revocation and one-use checks; neither closure nor chat grants authority.

The same dialog confirms abandon, reopen, proposal write or creation, material acceptance, cause adjudication and causal-dependency adjustment. Each summary asks a direct question, then names the target and the effects the current writer actually performs. Supplied text stays quoted. Captured JSON, digests and the detail reference stay under `D Détails`.

Read-only `/uw evidence` and `/uw verdicts` results use a compact successful record count, including zero; the full arrays remain in the consultable detail.

Generated feature and promotion bodies do not request issue closure; their neutral issue references are not approved bindings. No prose-driven auto-close job replaces calculated termination. A person can still write a keyword that GitHub acts on at the default branch; that native state remains an observation, not proof of UW completion.

### UW Spec and admission

The [glossary](GLOSSARY.md) distinguishes proposed, accepted and effective Specs. The effective Spec contains the UW's own criteria plus every qualified ancestor invariant and exclusion, with the complete accepted version vector. Ancestor criteria are not copied into the child's obligations. Missing, stale, conflicting or incompletely observed ancestry refuses; an editorial label cannot bypass the operator decision for a mechanically material ancestor change. Planning, implementation, review and criterion evidence bind that same effective Spec.

Calculated completion requires the uniquely active authenticated Mandate and its exact accepted OwnSpecRef for the UW and every inherited ancestor; an older pinned grant remains historical evidence, not a substitute for current authority. It checks each current native own Spec's canonical version and accepted tier, including standalone leaves and roots. A mechanically material body or tier discrepancy holds the affected UW, its inherited descendants and managed dependents; proceeding with that change requires the ordinary operator decision. Editorial-only body drift is not a new accepted version. Known or unknown Wayfinder labels cannot retain UW completion or release a managed dependency. This validates current inherited obligations, not a child-to-parent wait edge or a requirement that the parent finish first.

An accepted parent freezes each child's scope, canonical Spec version and tier, not presentation bytes. Its coverage map assigns every own criterion to accepted children and accounts for every engaged child. Missing assignments, unknown children or version drift hold progress. Historical parent review and completion retain those exact commitments.

Leaf admission checks the current parent commitment, inherited Spec and blockers before establishing the leaf mandate. Parent scheduling is suspended. Missing or held proof never counts as child completion, and native `CLOSED`/`COMPLETED` alone cannot release a managed dependent.

Completion is calculated bottom-up from one complete observation. A leaf needs its bound PR merge and delivery proof: a successful `review` check read by the merged PR head SHA, or admissible historical structured-review proof. A parent still requires completed engaged children, its own criterion proofs and directly reviewed integration containing the delivered child commits. Parent delivery is suspended; native issue closure is never a substitute for proof.

A parent's criterion citations must resolve to each covered child's actually selected delivery proofs; a shared ancestor citation is not the child's own integration or review proof. Before closing the bound UW, the installed closure's own final writer read obtains a concordant binding and whole common completion observation, including fresh native delivery facts. It evaluates that complete proof before projecting the native root; no later graph-only read can discard related facts. The same full reader confirms the effect. Observed proof loss before the state mutation refuses without a PATCH; proof loss after it remains partial and retains the actual close effect. Unreadable or lost-effect responses do not establish completion or trigger an automatic retry. This is not an atomic GitHub snapshot.

`adapters/github-native/uw-spec.ts` owns the body parser and renderer; `roxabi/uw-spec/` supplies its reads. The engine owns canonical content versions, durable C/I identities and admission. Framing and confirmed UW writes account for source obligations.

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
If a framing aggregate is held, delivery, landing and continuation transitions are refused, including after a concurrently published first Mandate; pause, abandon and stop remain available.

Before first acceptance, a framed member's title, Spec body, tier label and recorded edges are pinned: `/uw` proposal writes refuse it with `framing-result-pinned`, and a manual GitHub edit holds it as `framing-result-drift`, with no release in this version.

Relation-endpoint checks read an ordinary issue's complete native graph and own history without fetching unrelated descendant delivery sources. Framing-bound endpoints retain strict aggregate closure and pre-acceptance currentness; verified past acceptance does not restore a paused or inactive Mandate or bypass the Parent engagement guard.

The three installed framing procedures are pinned and byte-checked; a mismatch stops continuation. Context projection and typed forms are procedural controls, not proof of provider receipt or human reasoning. Real host and provider behavior requires separate qualification.
`/feature new` refuses an abandoned or revoked UW with a nonconformant body as `successor-spec-nonconformant`, with parser diagnostics and no write, checkout or bootstrap. omp-build has no in-place conversion for an inactive UW: `/uw write` is refused while its mandate is abandoned or revoked, and framing does not admit it. Start the work again as a new UW with `/feature <text>`. A body that already parses as conformant with confirmed identities follows the existing successor path; ordinary continuation cannot renew an inactive mandate. Nonconformant initial selections enter confirmed framing.

Native graph reading consumes every required parent/child/blocker/label page and closes the relevant graph across repositories. Incomplete, inaccessible or ambiguous portions are named, never treated as absent. Children stay in their parent's repository; blockers may cross repositories. Hierarchy, blocking and combined-wait cycles refuse.
Every native graph page must match the requested repository and issue number before its facts or connection items are attributed to that UW.

A UW is framed by a unique native tier, at least one valid criterion and no open question. Delivery requires its applicable accepted effective Spec and lifted blockers. A managed blocker lifts only when its completion is calculated from authenticated delivery; a native-only blocker requires readable `CLOSED` with reason `COMPLETED` and complete evidence that no managed authority applies. On a UW without a trusted mandate, a foreign or incomplete workflow claim leaves that absence unproven. Once a trusted mandate exists, foreign frames remain observable and do not by themselves hold its calculated completion or current engagement as an accepted child. Foreign control claims do not veto an otherwise authenticated cause-dependency control. Incomplete, conflicting or damaged expected-author records still hold. Unknown, incomplete, not-planned or abandoned states remain held and require an operator decision on the actual native dependency, not a success override. A previously complete delivery proof does not override a held native dependency state. Wayfinder maps and decision issues are non-UW, excluded from the work graph and without UW tier; reclassifying an already accepted child cannot silently remove that commitment.

Manual native closure never completes a managed UW without its authenticated delivery proof. The reader reports `native-closure-unproven`; the operator must reopen it or record abandonment. Confirmed reopening writes and reads back `OPEN` / `REOPENED`, but does not manufacture missing criterion, review, merge or parent-integration evidence.

Advancing transitions and final admission recheck blockers and authority. Pause, abandonment and proposal repair remain available. Pre-read and readback detect conflicts but are not atomic. A foreign copy cannot impersonate a selected authenticated record; a new append can still change the observed history.
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
| `/uw sister --request-file FILE` | Confirm creation of an adjudicated cause's sister. Refuses under an active parent. |
| `/uw promote-report --request-file FILE` | Confirm promotion of an exact durable report. Refuses under an active parent. |
| `/uw adjust-cause-dependency --request-file FILE` | Withdraw or replace a causal dependency. |

`propose`, `write` and `create` take strict proposal JSON containing the body draft, labels, relations and sizing factors; the proposed tier is computed as part of preparation, not by a separate tier verb. Writes and creation require the real context-bound UI on the exact proposal. Material acceptance requires an applicable own authority and an authenticated exact assessment; no argv token supplies confirmation.

`/feature` performs confirmed framing. Composed delivery uses `open-pr` for the authenticated PR binding and `finish` for `closeLinked` after calculated completion. There are no separate `/uw` frame, gaps, termination, findings, causes, manifest, snapshot, parent-coverage, link-pr or close verbs.

omp-build automated issue body, label, relation and state writes go through UW operations and their shared writer. Standalone issue-triage remains independent. Human GitHub edits are legitimate, but an edited proposal is not an accepted Spec and a manual close is not calculated completion.

GitHub publication follows the [public-safe content instructions](skills/feature/SKILL.md#public-safe-publication). Semantic review is procedural; existing-tool secret scanning is best-effort, not an automatic publication gate or proof of complete coverage. These source instructions do not establish installation or activation.

`evidence` and `verdicts` read applicable delivery declarations and authenticated criterion verdicts, including the approved bound PR's review history; they do not publish. `action` accepts a JSON object containing `request: UwActionRequest`: it resolves the durable inputs and creates a local read-only snapshot without a GitHub write. Adding `reviewed: ActionInputs` instead replays the stored inputs against current durable sources. The request's code coordinates and references must be readable and match their pinned identities. The installed-plugin pin comes from trusted host composition, never the request file or argv; a missing or mismatched pin refuses.

Historical review inputs bind the selected initial root to exact PR history or, for a parent final review, to UW history and the exact base-to-head range. Complete history, fingerprint and subject checks still apply.

| Cause command | Boundary |
|---|---|
| `/uw reports example/demo#42` | Reads durable reports on that UW and its native subtree, without discovering every PR or creating an issue. |
| `/uw adjudicate --request-file /absolute/path/adjudication.json` | Prepares a motivated decision on an exact pending disposition, then requests genuine confirmation. |
| `/uw sister --request-file /absolute/path/sister.json` | Confirm the exact framed sister before allocation and relation writes. |
| `/uw promote-report --request-file /absolute/path/promotion.json` | Confirm creation from the exact durable report and read back its receipt. |

Request files use the strict [cause request schemas](engine/cause-disposition-schema.ts). Adjudication names `pending`, `rejectedFindingIds`, `judgment`, `reason`, and `references`; supported necessity, urgency and size judgments require their cited observations. A retained-finding resolution rejects exactly its original finding with a null judgment; a rule-error resolution supplies no finding ids and a null judgment. Both preserve the original subject and diagnostics in a named final report, with a reason and cited observations, rather than inventing a root cause. Rejection affects only the exact authenticated findings, never criterion satisfaction, CI or an unrelated later observation. Sister requests name the exact `disposition`, sizing `factors`, `tierOverride`, and label changes. Promotion names the exact `report`, a complete ordinary `create` input, and its `reason`.

Both creation routes refuse active parents before any write while parent delivery is suspended. Parentless or inactive-parent requests still need fresh creation admission; an unproven parent state is not clearance. On an eligible request, the confirmed operation intent is read back before creation. Reconcile a partial or uncertain effect from GitHub facts before trying again.

A blocking sister remains an obligation until authoritative completion, even if its GitHub blocker edge is removed. Its creation receipt does not prove completion. Report promotion checks immutable lineage on the originating UW without reopening the historical review's PR.

An explicit `adjustCauseDependency` proposal can withdraw or replace that causal obligation. Genuine confirmation precedes the declared native blocker delta through the shared writer; only its fresh effect readback and authenticated control publication make the adjustment applicable. Declined confirmation writes nothing, and an unconfirmed effect stays partial. A historical withdrawal never overrides a blocker that is present again in the current native graph.

Historical pending causes retain the accepted Spec that produced them. Adjudication reconstructs that origin from the complete authenticated Spec chain; current native acceptance, the exact live pending head and genuine operator confirmation remain mandatory. Immutable successor replay cannot authorize a new operation.

Covered and new-policy delivery discovery searches each distinct relevant repository and mandate head branch across open, closed and merged PRs, reading every page without filtering by base. Branches locate candidates; canonical authenticated bindings establish association. A retargeted PR stays visible and is refused. Incomplete pages, ambiguous bindings or unreadable required history refuse rather than producing an apparently complete empty result.

For new-policy bindings, publication and selection require a non-null mandate branch and matching mandate, binding and native PR branch and base. Historical off-branch and branchless facts remain subject to their original rules; they are not erased or made landable by this policy.

The first succession of an uncovered legacy history retains both exhaustive repository-wide observations and examines every old mandate in the UW home, not just the selected lineage. An off-lineage, orphaned or competing mandate refuses coverage rather than being ignored or treated as covered. The transition can therefore remain expensive. A genuine successful new-policy successor control can bound a fully observed, rediscoverable old prefix; an incomplete prefix or an old mandate added after that boundary refuses explicitly. Ordinary reads do not silently launch a global fallback scan, and a version or cache alone does not prove historical absence.

Foreign claims do not veto UW **home-history coverage**. This does not relax the existing candidate PR binding guards: a foreign-only binding claim on a branch-matching candidate, including a fork PR or an unbound same-repository PR, can still refuse the delivery observation. A refused pause does not mean the own PR was disarmed. If necessary, an operator may independently verify the own PR and manually disable auto-merge and remove `reviewed` as containment only; this is not workflow authority or recovery.

Pause, abandon and control-disarm require complete ordinary authority and retain their existing PR ownership checks. An uncovered legacy history refuses instead of confirming containment; the one-time historical succession path remains subject to its existing terminal-antecedent and complete-observation preconditions. The `legacy-coverage-incomplete` diagnostic can also indicate missing, damaged, partial or ambiguous current-policy home history, or an unknown policy; it does not justify ignoring history or automatically migrating it.

Release policy: every new product version remains unknown to binding discovery until deliberately recognized in `engine/workflow-binding-policy.ts`. Versions 0.19.0 through 0.19.3, 0.20.0 through 0.20.1 and 0.21.0 through 0.21.17 retain the bounded semantics of 0.18.8 through 0.18.11; other versions remain unknown. Rebuild the distributed contracts after changing this policy. A version bump neither migrates records nor activates tooling.

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

Historical `epic-event` records remain readable: `goal-stop` is a UW stop; `goal-report` records a shared-state stop or report; `epic-review` and `post-merge` retain integration evidence. An `epic-drop` report is a stop; `epic-fix` is diagnostic only.

Parent pause and abandonment still contain armed descendant PRs. Containment checks applicable own and accepted child PRs against authenticated bindings; issue links and branches are discovery hints. Incomplete discovery cannot confirm disarm.

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
| `omp_build_prepare_checkout` | `registerTool`. Canonical checkout for one unambiguous issue reference. A pull-request number checks out that request's existing head instead of minting an issue branch. Returns `ready`, `move`, or `blocked` with the path. Host write approval. Does not publish authority, bootstrap, resume, move the session, or simulate `/feature`. |
| `omp_build_framing_submit` | Submits a read-only form to the active framing interview. Only the operator can confirm a staged proposal; this tool does not write, confirm, move or deliver. |

`registerCommand` is the user lane. `disable-model-invocation` omits a skill from the prompt listing but neither prevents explicit reads nor grants authority. Catalogue installation does not install the declared host SDK peers.

## Records

The engine (`engine/`) owns versioned records, references, conservation, counts and deterministic projection. Roxabi (`roxabi/`) prepares delivery authority and UW operations. GitHub adapters paginate comments, check native authorship and revisions, and confirm publication by readback. These checks do not judge review semantics.

For multi-page GitHub histories, each next page is followed by a comparison of the preceding page's native IDs and revision facts. A changed or unverifiable page returns `complete: false`, retains comments already read, and reports `github-pagination-changed`; read failures retain their existing diagnostics. Relative to GitHub's documented ascending-ID ordering and the undocumented assumptions that new IDs increase, deleted IDs never reappear, and responses are non-stale and monotonic, a complete read includes every comment present throughout the read. Stale or replayed responses can defeat the check. Edits within a preceding page's comparison window cause a hold; revisions outside those windows are not checked, and the result is not a snapshot.

A record frame whose native author is not the trusted login is `foreign`. It stays observable in the decoded history, but it never completes, collides with, blocks, or deduplicates a trusted operation; an identical foreign body does not suppress a publication. A review's time is the native creation time of its final part; editing the comment does not move it.

`encodeRecord` frames each canonical record with its projection. The header is `<!-- omp-build-record v=1 kind=… id=… operationId=… part=i/n data=<base64url> -->`. The payload is authoritative. The Markdown is presentation; no business reader takes a verdict, head, or input from it. A final `review` carries `candidateGitSHA` and `input` (64 lowercase hex SHA-256, or null). Projection lists the record, decision, candidate, input, findings, standards, and source provenance (contribution host plus originals). Legacy `<!-- omp-build:… -->` markers — including `code-review`, `review-head`, `review-input`, and `proof` — are `legacy-format`. They are refused, not parsed, resurrected, or reset.

Decoded operations require `authority` and distinct `claimedKinds`; those claims are evidence, not permission. Record projection follows the original dependencies. A foreign, missing, incomplete or ambiguous reference refuses.

Historical review contributions may retain submitted forms in `rawAttempts` and SDK-observed terminal material in `native.raw`. Neither is a complete process stream or a substitute for code linkage or review judgment. Historical action results bind their confirmed START, mandate and exact inputs; an observed commit or terminal output alone does not establish a retained result.

Historical correction records set `landing: false`. A review-bound request names the PR, exact review, scope, mandate and confirmed decision. See [historical cause records](skills/dev-review/root-causes.md) for member and proof fields.

### Historical review policy and cause dispositions

Historical reviews distinguish `baseline` and independently accepted `evidence-v1`. Neither policy clears a pending blocker, confirms a sister, or changes the UW that owns a report. Rejection is not criterion evidence.

Historical dispositions authenticate the exact accepted-Spec prefix against the complete authoritative chain. Later Spec succession does not invalidate immutable final reports or carry old rejections over to a different accepted Spec.

### Existing review and landing safeguards

The [trusted delivery CLI](#trusted-feature-delivery-cli) is `/feature`'s only merge path; it performs a head-pinned merge without arming auto-merge. Legacy head authorization, hosted CI and disarm safeguards remain separate. The composed flow's two correction rounds are counted per invocation, not by canonical final reviews per PR.

The review bound is two automated corrections per PR (#710), derived again on every
read from complete canonical `review` records whose native author is the automation
login (`gh api user`). The count and the latest review come from that history. A
refusal is not an empty history. Nothing writes accounting. A legacy marker is not a
review and does not reset the bound.

A spent native bound remains visible to historical readers. It is not the composed correction counter and is not a hosted merge gate.

#### Trusted Feature delivery CLI

Run from the canonical worktree using the installed skill directory reported by the host, not the candidate's copy:

```sh
bash "<skill dir>/trusted-bun.sh" "<skill dir>/feature-cli.ts" <sub> --repo <owner/repo> --issue <N> --mandate <recordId> [args]
```

Every effect rechecks the live, applicable leaf mandate. Accepted or native children, unknown leaf status, and inactive or mismatched authority all refuse. `push` and `open-pr` require the mandate base to be the repository's default branch.

On approval, `/dev-review` posts `review-verdict v1 head=<sha> approve evidence=<url>` for the Review Verdict workflow. A new head needs a fresh review and verdict.

| Subcommand | Checks and effect |
|---|---|
| `push --tip <sha> [--from <sha>] [--pr <N>]` | Verify the branch, ancestry from the base or `--from`, and the sole `origin` push URL immediately before writing. Omit `--from` only for an observed absent branch. Correction requires `--from` and the bound open `--pr` at that head. Push the exact commit with a lease and no tags; read back the remote tip and correction PR head. |
| `open-pr --tip <sha>` | Verify the published tip and nonempty branch delta. Create or reuse one matching open PR and confirm its binding, adopting an authenticated successor binding when applicable. Refuse ambiguous matches or replacement of a closed or merged PR. |
| `land --pr <N> --head <sha> --spec <digest>` | Verify the bound PR, recheck the live mandate and effective accepted Spec, and reread the PR's base and head. The digest comes from the host's admission snapshot; a mismatch returns `spec-changed` without merging. The active base rules must pin `review` to one App and must not require a merge queue. Attempt `gh pr merge <N> --repo <owner/repo> --merge --match-head-commit <sha>` once and read back the merge. GitHub enforces `review` + `ci` on that head; no auto-merge, bypass or `reviewed` label. |
| `finish --pr <N>` | Verify the bound leaf PR is merged and that its exact merged head has a successful `review` check from the App pinned by the base rules, or admissible historical structured-review proof. Use that proof in `closeLinked` to calculate completion and confirm closure. |

**Known limits**

- GitHub pins the merge head, not the base or Spec. The base or accepted Spec can still change after `land`'s final reads.
- The CLI checks that the admission Spec is still current, not which Spec the review covered. `/dev-review` writes the digest in its evidence header and `/feature` re-reviews when it differs.

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
evidence reference. It refuses a head other than the current PR head and treats
PRs with native omp-build history like other Kit PRs. It does not replay that
history or evaluate CI; the Kit gate rechecks CI before merge.
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

The surviving `workflow-gate.js` reads native PR state and, where configured, Kit authorization. Pause and abandon use its disarm checks: disable auto-merge and remove `reviewed` when present, withdraw applicable authorization, and confirm the result by readback. An unreadable or still-armed PR is not a confirmed disarm. This code does not arm a new merge.

Standalone `/ci-watch` observes the existing merge state using `workflow-readiness.js`: committed base `landing.mode`, otherwise `merge-on-green` if that workflow exists on the base, otherwise `native`. It does not advance Feature or restore an arm.

#### Historical structured review proof

For historical structured review proof, every behavioural criterion requires an admissible, code-bound test or observation. Missing or unverified criterion verdicts cannot approve the head, even with zero findings. The reader checks structure, references, versions and the verdict rule; it does not judge the truth of the observations.

GitHub viewer identity is fixed for one OMP process. `gh auth switch` requires a new session; the viewer memo includes `GH_HOST`, `GH_CONFIG_DIR`, `GH_TOKEN`, and `GITHUB_TOKEN` but does not observe an in-place account switch.

#### Repository auto-merge

This repository's separate `.github/workflows/auto-merge.yml` arms GitHub native
auto-merge with a merge commit when the `reviewed` label is added. The App token
arms on the event head via `--match-head-commit`. The `PR_Main` ruleset requires
both `ci` and App-issued `review` on that head before GitHub merges. The workflow
uses `pull_request_target`, checks out no code and does not read omp-build records.
Synchronize disarms and drops `reviewed` with the job token; failed arming also
uses job-token cleanup. Dependabot can arm only for semver-minor or semver-patch
updates whose every commit author is `dependabot[bot]`. This lane is separate from
Kit merge-on-green and from composed Feature delivery.

#### Shared tooling pin

`OMP_BUILD_TOOLING_SHA` remains the shared source pin for operator-host tooling
such as `/uw action`. It does not select code for Auto Merge. Read it with:

```sh
gh variable get OMP_BUILD_TOOLING_SHA --repo Roxabi/roxabi-plugins
```

When intentionally updating the shared host pin, use the full `main` SHA that
carries the installed distribution. A mismatched pin and installed package
refuse host operations that require the pin. To advance the pin and update a
shared-pin installation after authorization:

```sh
gh variable set OMP_BUILD_TOOLING_SHA --repo Roxabi/roxabi-plugins --body "$MAIN_SHA"
omp plugin marketplace update roxabi-marketplace
omp plugin upgrade omp-build@roxabi-marketplace
```

#### Isolated session tooling pin

When a separately installed distribution intentionally differs from the shared source pin, set the target GitHub repository's `OMP_BUILD_TOOLING_SHA` to the full lowercase 40-character source commit and run `/tooling-pin activate` in the root TUI. Review the source, installed version, package digest and target clone, then explicitly confirm. The candidate must be on the installed source repository's default-branch ancestry and match the installed package bytes. An older matching installation may qualify. A matching or unreadable shared pin, child session or headless invocation cannot activate it.

`/tooling-pin status` reports the current pin. Approval lives only in this extension instance and confirming root session, scoped to the current GitHub repository and clone, including linked worktrees. A same-session `/move` retains it; a session switch, branch or tree selection, shutdown or reload requires fresh confirmation. Clearing conversation context does not itself revoke activation if the session and agent identities remain unchanged; a changed identity makes it unusable. The root and clone checks still apply. Invalidation does not replace a pin already captured by a surviving admitted operation; its existing origin, stop and control guards still apply. Activation creates no UW or workflow authority and changes no shared pin or installation.

A product-version bump changes the effective workflow config digest. Complete or genuinely abandon active mandates before an incompatible activation. If the current reader cannot authenticate abandonment, retain the blocker and request an explicit owner recovery decision; a source fix or manual merge grants no cutover exception. After applicable activation prerequisites, a genuinely abandoned, conformant current-format UW can use `/feature new #N` for a fresh same-UW successor with current checks and a new config pin, not continuation of the old authority.

## Guards

The plugin arms its guard chain **in-process**, through `omp.extensions` → `omp/index.ts`. It intercepts `tool_call` and refuses, before the tool runs:

| Tool | Refusal |
|---|---|
| `bash` | bare `bun test` (`bun run test` passes) |
| `bash` | `git switch`/`checkout` off `staging\|main\|master` **in the principal worktree** — escape hatch `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1` |
| `write`, `edit` | content matching the hardcoded-secret / SQL-injection / command-injection table |

The scan **fails open** above `SECURITY_SCAN_MAX_BYTES` (256 KB): a payload larger than the ceiling is not scanned at all. Once `dev-core` is uninstalled there is no second layer behind this one.

Guards are **off** unless the project declares the host-neutral contract (`.dev/stack.yml` or `.dev/dev-core.yml`); without it the interceptor is a no-op and warns once per cwd.

The guards and authored review agents are maintained locally. omp-build does not resolve files through a sibling plugin at runtime.

> **Known caveat, this slice only.** While both this plugin and `dev-core` are installed, both interceptors see the same `tool_call` and reach the same verdict — the snapshots are byte-identical and read the same escape hatch. Expect the refusal, and the no-contract warning, to be reported **once per plugin**: each extension owns a private warned-cwd set, so neither dedupes the other.

## Worktree bootstrap

`skills/feature/worktree-bootstrap.sh` is the bootstrap contract. `runWorktreeBootstrap` in `roxabi/workflow-checkout.ts` runs it in the foreground after worktree identity is valid and before the Feature handoff: before successor publication on `/feature new`, on the first mandate, and on select, resume or new in an already valid worktree. It refuses the principal. `omp-build-bootstrapped` and `omp-build-bootstrap.lock` are environment cache, not business records. `/feature init`, bare checkout preparation and session or agent start do not run it. Do not run it as a second process.

- The script holds a lock in the git dir, so repeated explicit calls wait for a running invocation and then no-op.
- omp-build does not automatically copy or build a ccc or codegraph index and requires neither CLI. Project-configured `worktree.copy`, `worktree.seed` and setup still run normally.
- Worktree lists and setup scalars are read with Bun.YAML (Bun ≥1.2.21) before any transfer. Flow/block string lists agree and `[]` means no transfer. Invalid YAML or consumed list types fail with the stack filename, leave no completion marker and release the lock. A non-empty `worktree.setup` runs as a Bash snippet; absent, empty or whitespace-only setup falls back to the file declared by `commands.worktree_setup`, from the worktree root. A failed setup also stays retryable. `feature init` preserves a declared setup command instead of adding an empty override. Cleanup uses the same YAML parser for the principal's `worktree.base`, preserving environment > stack > default precedence and quoted/block scalars.

## Agents

The session selects from the agents available through OMP's `task` tool. `agent-sources/` holds the seven authored profiles shipped in `agents/` (see [Owned distribution](#owned-distribution)). Each profile's `tools:` lists allowed built-ins; that is not a credential sandbox.

| Agent | Model | Posture |
|---|---|---|
| `R-adversarial` | `@review, @slow` | Red-team and OWASP review. Sibling-drop applies only to specialists named in the actual `Spawned roster:`. |
| `R-advisor` | `@advisor` | Constructive second opinion; not the session WATCHDOG (`advisor.enabled`, `/advisor`, `WATCHDOG.yml`). |
| `R-architect` | `@review, @slow` | System design and cross-cutting consistency, including read-only axial review against the unique `axial: true` ADR. |
| `R-devops` | `@task` | Config, CI/CD, Docker and dependencies; read-only on a review brief. |
| `R-tester` | `@task` | Test generation, coverage and negative-test judgment; read-only on a review brief. |
| `R-security-auditor` | `@review, @slow` | OWASP inventory for changes affecting auth, secrets, crypto and permissions. |
| `elon` | `@advisor` | The Algorithm. Read-only tools. Inventory (NAMED/UNNAMED/BINDING) → delete (named add-back) → simplify → accelerate → automate last. Process only, not Musk roleplay. |

`review` is not a built-in OMP role: the operator maps it in `modelRoles.review`. omp 18.8.0 resolves `@review, @slow` as follows. An unmapped `@review` matches no model and OMP takes the next entry, `@slow`. An unset `slow` resolves to `modelRoles.default`, and to OMP's built-in slow candidates only when `default` is unset too. With neither `review` nor `slow` mapped, the judgment agents therefore run `modelRoles.default` when it is set, which can be the worker model, and OMP's built-in slow candidates when it is not. The list expands to more than one selector, so `retry.fallbackChains.review` is not attached to these agents: their runtime fallback is the rest of the list, the `@slow` model. A spawn that passes no `model` can still fall back to the parent session's model when the resolved model has no working credentials. To keep judgment off the worker tier, map `modelRoles.review`, and `modelRoles.slow` for a distinct fallback.

OMP reads profiles from `agents/` in the loaded package root. For `task` spawns, model selection follows the call override, `task.agentModelOverrides`, profile frontmatter, then the active parent. Operator overrides can mask the profile's role.

## Skills

| Skill | Lane |
|---|---|
| `feature` | `/feature` prepares a leaf delivery and supplies `SKILL.md` with the mandate and worktree context. |
| `dev-review` | Standalone `/dev-review` or composed Feature review · independent agents selected by the session, one findings comment and a head-bound verdict when approved. |
| `dev-fix` | Standalone `/dev-fix` or composed Feature correction · fix current findings and failing checks, push the exact tip, then review the new head. Composed mode uses the delivery CLI. |
| `promote` | `/promote` (registered command) · the optional tail |
| `cleanup` | `/cleanup` · read-only inventory, then explicitly selected guarded removal; optional manual `--force` requires local-data discard approval; branches preserved |
| `ci-watch` | `/ci-watch` (registered command) · watches checks, then the merge |

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
| Review and correction | `skills/dev-review/SKILL.md`, `skills/dev-fix/SKILL.md` |
| Leaf Feature admission and delivery | `omp/omp-feature-command.ts`, `roxabi/feature-live-mandate.ts`, `skills/feature/{SKILL.md,feature-cli.ts}` |
| UW linked closure | `roxabi/uw-linked-closure.ts` owns fresh binding/graph proof, native state mutation and readback; `uw-installed-operations.ts` composes its ports |
| GitHub history and publication | `adapters/github/`, `adapters/github-workflow/` |

The Feature handler hands scoped leaf delivery to the session. Its delivery CLI rechecks live authority for each effect. Historical cause reads validate the catalogue at its pinned source; the installed `skills/dev-review/review-classes.yml` is validated as a distribution asset.

History merge guards avoid serializing a retained native-decoded history against itself. Distinct objects still receive the complete conflict comparison; the shortcut retains no cache and skips no fresh observation, closure-growth refresh or selected-history verification.

### Test ownership

Record and engine scenarios share history and external-boundary fixtures without re-exporting the product under test. Keep consumer-visible expectations in scenarios, outside model inputs. Process-spawning scenarios use `*.integration.test.ts` and own resource cleanup.

Feature tests use the GitHub simulator and disposable Git repositories. Retained history fixtures seed native records and exercise the current readers.

The GitHub simulator's shared kernel owns lock, hydration, audit, command handling and atomic state replacement. It does not grant delivery authority or model an atomic GitHub transaction.

Commit and comparison metadata is batched from real Git within each request, retaining exact SHAs, trees, all parents and page order. Range observations and simulator transactions remain fresh; no metadata cache spans requests.

Integration fixtures use lightweight `gh` and pin clients to send commands to a dedicated simulator server per test file; fixtures pass their environment explicitly. The `gh` client uses a standalone executable for comment-barrier calls, calls made while the state lock is held, and hosts without `/proc`; a nested `gh` call inside a server request fails fast. The pin client also uses its standalone executable when `/proc` is unavailable or a gate or synchronization call must wait.

### Quality contract

Run `bun run quality:omp-build` for the same owned-source check used by the pre-commit hook and CI. Physical discovery feeds both the line counter and the pinned Biome command; warnings fail, and an empty lint set is not success.

Vitest runs unit first, then integration (`groupOrder: 1`). Unit inherits `min(8, max(1, availableParallelism() - 1))` workers; integration uses `min(8, max(1, floor(availableParallelism() / 4)))` independently. The unit timeout is 5s and the default integration timeout is 60s; scenario-specific fixture clocks are not product limits.

| Surface | Enforced limit |
|---|---|
| Runtime code, helpers, types, schemas, live configuration and exclusive omp-build tools | 300 physical lines |
| Genuine executable assertion scenarios, not arbitrary files named as tests | 600 physical lines |
| Every owned JavaScript-family function, including CommonJS and scenarios | Cognitive complexity 15 |
| Focused tests | Error |
| Runtime TypeScript promises | Floating and misused promises are errors; declaration, scenario and test-support roles are excluded |

Generated distribution files and retained inert data are distinguished by their actual ownership/provenance, not a blanket test-directory exception. Other plugins and shared root controls are outside these new caps. Parser and AST types are pinned at `8.0.8`, Biome at `2.6.2`; no effect runtime, database or workflow framework is introduced.

### Owned distribution

`agent-sources/*.md` holds seven authored agents. The producer copies them into `agents/` byte for byte. Tests and support stay outside the generated surface.

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

Installed UW and framing consumers use the compiled facade. They must not re-import the Zod-owning source schemas or their transitive adapters.

The clean-import guard also requires a temporary tree with no `node_modules` ancestor. If the default tree is contaminated, a process-local `TMPDIR` pointing to a genuinely clean tree provides environment isolation, not a packaging correction: it changes where owned temporary files are written, never the guard. Remove that override when the default tree is clean; do not delete unrelated dependencies or disable isolation.
