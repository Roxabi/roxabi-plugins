# omp-build

OMP-only delivery plugin. The installed `/feature` command drives a bounded graph: frame, issue, worktree, implement, native review and correction, land. A session `/goal` does not authorize that graph.

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

The UW contract cutover is delivered manually under [#901](https://github.com/Roxabi/roxabi-plugins/issues/901): #905 → #906 → #907 → #908 receive independent review and manual merges before the separate real [#910](https://github.com/Roxabi/roxabi-plugins/issues/910) qualification. This release alone does not qualify `/feature`; manual review and green CI do not manufacture native workflow authority.

### Controls

`parseFeatureCommand` is the word list. A known transition does not ask again. There is no per-PR merge approval.

| Command | Boundary |
|---|---|
| `/feature <reference>` | Publishes the first valid mandate, or reuses an applicable one. |
| `/feature resume <reference>` | Resumes an ordinary confirmed pause. A review-bound or safety stop is not a pause. |
| `/feature pause <reference>` | Inhibits local continuation and publishes the control. Confirmed only after observed disarm. |
| `/feature abandon <reference>` | Revokes the selected mandate, including when that mandate has its own confirmed pause. No automatic renewal. |
| `/feature new <reference>` | Successor over an intact abandoned or revoked mandate. `publishSuccessorMandate` names the antecedent and publishes `select-successor`. `preserveSuccessorBinding` rebinds the same open PR when its binding names the antecedent or is absent. A missing antecedent or a foreign binding does not mint. Not renewal of `/feature <reference>`. `new init` is this control, not init. |
| `/feature material-decision <reference>` | Opens the genuine operator-confirmation route for the exact authenticated material or unknown assessment. An `accept`/`reject` argv suffix is not authority and is refused. `/uw accept-material` uses the same acceptance chain. |
| `/feature init` | Preview of the invoking checkout. Not a subject, not framing, not a mandate, not a native task. |

Initial free text and eligible unframed issues enter assisted framing before checkout. The human presses `ctrl+alt+u` to open the staged proposal, not to approve it. `Confirmer` alone authorizes it; `Refuser` discards it, while Escape or `Plus tard` closes without a decision and leaves that exact proposal available to the same shortcut in the same live session and location. After a completed framing, when a move is needed, the human runs `/move <path>`, observes its success and presses `ctrl+alt+u` from the fresh destination to attest it. The same UW continues without retyping the command; checkout preparation is not relocation or a Mandate. The model's read-only `omp_build_framing_submit` tool cannot confirm or attest. Existing resume and successor controls retain their checkout guards. There is no `/wt`. `/dev-review` and `/fix` do not grant landing.

The confirmation starts on `Plus tard`. Tab/Left/Right selects an action, Enter activates it; C confirms, R refuses and Escape defers. Up/Down/PageUp/PageDown scroll the summary; D toggles the captured JSON, digest and detail reference. Supplied values are quoted with visible line-break and bidirectional-control escapes, without changing the prepared payload. Wrapped continuation rows retain a `| ` marker even when their origin has scrolled away.

Select, resume and new retain the `session-cwd` checkout guard and may stop with `principal-dispatch-refused`; move the session with `/move <path>` as directed.

During intake and framing the read-only gate covers the root extension instance and refuses new task spawns; it does not gate subagents or background jobs started earlier. Hiding a generic confirmation during `/feature` intake is not classification: that gate remains until the decision allows classification or the command is replaced/revoked. The held proposal remains available through `ctrl+alt+u`. USER-attributed entries are not authenticated against other extensions; final approval still requires human confirmation. First words `new`, `pause`, `abandon`, `resume`, `material-decision` and `init` are parsed as controls, not framed as free text.

Detected mid-turn user interruption, session switch, and shutdown await the durable pause for a pausable owner. Confirmation is the read-back `pause-confirmed` control, not the local interrupt. A finished or confirmed-abandoned owner is released and is not paused again. An unconfirmed pause is not a resumable pause.

Interactive `/feature` and `/uw` confirmation capabilities are bound to their root command: ordinary idle settlement preserves an open confirmation; root abort, session switch, shutdown, or command replacement invalidates it. Escape or `Plus tard` keeps that exact proposal pending. `ctrl+alt+u` reopens it in the same live session and location and does not approve it. A command that was not deferred this way still requires explicit re-entry. A visible preparation or reading state appears when a valid command starts, before ports and long remote reads. It distinguishes preparation, pending confirmation and the continuation after confirmation, and is cleared or replaced at the result, revocation or stop. Neither the shortcut, the default action, nor closing the dialog approves. omp-build 0.18.3 is a manual source delivery: it is not an activation, tooling pin, installed-cache upgrade or permission to continue a suspended witness.

Late command messages and UW result files remain bound to the original session, live cwd and exact owner generation. Errors after a hidden proposal is reopened are reported without mistaking the command's own cleanup for replacement; a newer command suppresses the old outcome. An admitted framing handoff adopts only that exact lease's reporting guard. CI-watch status continues to use its existing watch-owned cleanup.

Ordinary SDK `session_stop` means turn settlement, not workflow pause: a host-owned CI watch continues. When only that watch is running, idle Esc/RPC abort does not guarantee pause or disarm; use `/feature pause` or `/feature abandon`. This is the explicit-stop contract, not an idle-abort hook. Mid-turn interruption uses the SDK's session-stamped `UserInterrupt` flag on an aborted assistant message. That SDK primitive is bundled at build time into the existing contracts bundle; there is no runtime SDK dependency, copied error-label fallback, or second supervisor. Ordinary progress uses the status surface and does not grant continuation authority.

Spec assessment receives the exact accepted and proposed canonical snapshots together with their original raw bytes, tier and accepted-child commitments. Its original classification stays in the action result. Additions/removals of criteria, invariants or exclusions, and tier/accepted-child changes are mechanically material; a stable-ID rewording still receives semantic editorial/material/unknown judgment. Material or unknown acceptance requires a real operator decision bound to that exact assessment and proposal. Declining publishes no acceptance and grants no continuation or landing authority.

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

GitHub comments hold the records: `mandate`, `spec-identity`, `operator-control`, `action-receipt`, `workflow-binding`, `review-interruption`, `review-replacement-grant`, `review`, `correction`, and `epic-event`. Mandates carry `format: 'omp-build-mandate/4'`; Spec assessments use `omp-build-spec-assessment/3`; action-receipt payloads require `format: 'omp-build-action-receipt/2'`; reviews carrying input require `inputFormat: 'omp-build:review-input/4'`. Missing/older incompatible formats, obsolete payload fields and the removed `kind: 'proof'` refuse explicitly. No active migration, automatic renewal, cross-format recovery or historical-completion exemption is provided. An interrupted initial pull-request review is terminalized by `review-interruption`; one linked replacement inventory may consume a one-use `review-replacement-grant` afterward.

Trusted complete workflow records — `spec-identity`, mandate, `operator-control`, `action-receipt`, and `workflow-binding` — require readable UTC native creation/revision facts on every part, with `updatedAt === createdAt`. Missing or unreadable facts refuse as `record-unreadable`; a revised part refuses as `record-edited`. Foreign observations remain readable but never become authoritative. Foreign copies cannot veto authenticated candidates by reusing their identifiers; missing, conflicting or damaged expected-author records still refuse.
Correction checkpoints and review recovery authenticate their own records; foreign claims remain observable without vetoing authenticated evidence, while incomplete or conflicting expected-author evidence still refuses.

Cause state is durable on its original UW: `cause-disposition`, exact-confirmed `cause-operation`, sister-only `debt-receipt`, and `report-promotion`. A newly published review explicitly references its complete dispositions through `causeDispositionRefs`; omitting that field cannot select historical semantics at a live admission gate. Historical verdicts remain diagnostic records, not fresh approvals. Admission authenticates the referenced decision, action inputs, accepted Spec and cited observations before a successor can release a hold.

Cause resolution uses the complete authenticated causal history and the catalogue pinned by each producing action, not the currently installed catalogue. The host supplies an immutable table derived from exact pinned bytes, retaining per-pin failures; missing, conflicting or invalid evidence refuses rather than inventing a class. The full causal context resolves references but does not enlarge the selected mandate, parent or execution authority.
Cause-wait projection discovers cause histories from expected-author claims, including incomplete or invalid claims; a foreign-only cause claim does not trigger that projection. Independent review and causal validation still apply to their own authenticated evidence and context.

External citation loading authenticates external scopes without promoting the raw primary observation to external authority. Incomplete or interrupted primary history remains available for diagnostics, but still refuses review approval; an unreadable, edited or forged external source remains invalid.

Publication treats supplied external histories as scope seeds and refreshes the required evidence at each pre-write and post-readback boundary; an idempotent publication is validated against current evidence too. A failure before the first native history read reports no observed history (`null`), not a fabricated empty history. Report promotion can authenticate retained archival evidence without granting current delivery admission. Parent insertion uses a bounded fresh parent-engagement read, not an expanded causal closure.

Removed integration configuration is not read during adoption, worktree start, review-input capture, or landing.

The only project override of the shipped workflow definition is `review.additional_requirements` in the committed `.dev/stack.yml` at `refs/remotes/origin/<base>:.dev/stack.yml`. Existing `landing`, `release`, and `commands` configuration remains in force. `parseWorkflowOverride` accepts a list of non-empty strings. Absent `review`, or a null list, means none. `review.graph` and `review.workflow` are refused. There is no `.omp-build/workflow.json`. The mandate records that list as `effective.additionalRequirements`. An uncommitted working-tree edit is not that snapshot. The list does not replace the shipped graph, a review bound, or landing admission.

A confirmed checkpoint is a published record read back, plus the Git facts that bind it. An OMP goal, transcript, or local session file is not authority. Local environment files are not authority either: dependency installs, indexes, and the per-git-dir bootstrap marker `omp-build-bootstrapped` plus lock `omp-build-bootstrap.lock`. They can be rebuilt. A cold machine does not copy the marker, those caches, or a transcript. Cannot resume: unpublished commits, a result never published, an action whose effect is uncertain, a pause request without observed disarm, a local-only worktree change. Moving machines needs the same operator identity, this plugin, GitHub auth, and the project tools, then `/feature <reference>` in the intended worktree. The environment is rebuilt there, not copied. Comment edit or deletion remains an accepted risk. There is no new anti-tamper store.

The landing binding on every base is the confirmed `workflow-binding` on that PR. A closing keyword, issue body, or branch name is not landing authority.

Issue state is a scope fact, not execution authority. A closed Spec remains readable when reconstructing its bound mandate. Closing an issue neither pauses or revokes that mandate nor approves landing; a closed PR still cannot authorize another review or correction.

#### Interrupted native review

Recovery is three explicit write-approved host actions, each with `{ "pr": <number> }` in the PR's worktree:

| Tool | Confirmed effect |
|---|---|
| `omp_build_terminalize_interrupted_review` | Publishes a neutral interruption for the unfinished initial PR inventory after reconstructing its historical mandate, binding and input. No verdict or review tasks. |
| `omp_build_grant_review_replacement` | Captures fresh review inputs against the verified current binding and grants one replacement. No review tasks. |
| `omp_build_replace_interrupted_review` | Recaptures those inputs, confirms the exact linked inventory by remote readback, then activates and announces its native review batch. |

Historical inputs need not equal the fresh grant's inputs. Replacement inputs, head and binding must equal the grant's freshly verified values. Roots and publication identities are derived from the recorded chain, not supplied by the caller. A confirmed linked inventory consumes the grant once; a transport acknowledgement alone does not. Incomplete, conflicting or unauthenticated evidence refuses progression rather than minting another attempt.

The interruption, grant and unfinished replacement all leave ordinary review/correction progression stopped. A genuine completed replacement verdict re-enters normal review/correction accounting with all historical bounds and stops retained. An interrupted replacement needs a new human checkpoint; these tools do not grant a third recovery, a new review bound, a mandate succession or landing permission. An uncertain publication must be reconciled against native history before retrying; restarting the host does not refill the allowance.

### Criterion delivery and action inputs

Plans cite known `criterionIds` on every step; the union must cover every accepted criterion. Multiple steps can serve one criterion, and one step can serve several. Drafts and amendments cannot hide orphan criteria behind clear specialist judgments.

Each implementation receipt accounts for every criterion at the applicable code version, with evidence or an explicit unverified reason. A missing receipt is not an empty successful declaration. Review returns versioned criterion targets and cites the evidence actually examined; synthesis references authenticated source verdicts rather than inventing satisfied rows.

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

#### Required context and explicit expansion

A producer can return the strict `missing-context` form with the requested source, reason and affected targets. This applies to Spec assessment, planning and plan review, implementation and CI attribution, and review/correction stages. A requested locator is not an observed reference or publication authority. The authenticated negative stays bound to the original action and sealed inputs; it never satisfies a criterion, approves a review or becomes a formal Report.

Prepare the replacement explicitly with `/uw action /absolute/path/action.json`. Its `expandedContext` cites the authenticated negative's `/payload` and genuinely additional pinned references. Preparation preserves the supplied context, required stage sources, accepted authority, code, subject and purpose, and creates a distinct manifest fingerprint and sealed snapshot. A missing required source remains blocking; unreadable, edited, wrong-digest or ambiguous lineage refuses. Repeated negatives must form a unique authenticated chain, not competing successors.

Preparation does not dispatch the new action, renew a mandate, reset review/correction limits or authorize recovery of an effectful correction. A previously resolved or cross-purpose negative can remain authenticated input data without becoming new resume authority. Session changes revoke pending native publication as well as continuation; pausing continuation alone does not revoke an already admitted publication.

#### Communication and publication authority

Ordinary progress uses the existing OMP footer/status surface. Visible main-conversation messages are operator decisions, actionable blockers and final results, with selectively readable detail references. Hidden continuation controls still enter model context/history; they contain the guarded procedure/index wire, not full instructions, results or UW history. Detailed native results are retained before their root-facing previews are replaced with references.

Framing confirmation presents titled members, repository/UW scope, replacement effects, identity changes and retirements, source accounting and merges, criterion-to-child coverage, foundations, relations and business context. Supplied text is visibly escaped rather than allowed to forge structural summary lines. The full captured proposal, exact digest and detail reference are separate under `D Détails`, not a raw payload in the default view.

The fixed action footer offers `C Confirmer`, `R Refuser` and `Esc Plus tard`. Tab or left/right selects an action; Enter activates it, initially `Plus tard`. Up/down and Page Up/Down scroll the content without moving the actions. The layout adapts to terminal resizing; when too small to present a decision safely, confirmation and refusal have no effect while Escape can still defer. Native buttons remain clickable so their live viewport guard can accept the first action after a height-only recovery. Reopening preserves freshness, revocation and one-use checks; neither closure nor chat grants authority.

The same dialog confirms abandon, reopen, proposal write or creation, material acceptance, cause adjudication and causal-dependency adjustment. Each summary asks a direct question, then names the target and the effects the current writer actually performs. Supplied text stays quoted. Captured JSON, digests and the detail reference stay under `D Détails`.

Read-only `/uw evidence` and `/uw verdicts` results use a compact successful record count, including zero; the full arrays remain in the consultable detail.

Agents return forms; the orchestrator submits them to engine verification and publishes confirmed records. Role permissions do not authorize GitHub writes. Where the SDK cannot remove per-child environment, `gh` configuration, Git helpers or SSH credentials, the declared `procedural-fallback` is weaker than technical isolation. Worktree isolation and omitted publication tools are not a credential sandbox.

Reserved omp-build child roles require a correlated, sealed action. SDK child-factory rebinding shares private execution observations, not parent/child event-bus identity. A child must match one active, admitted root call and its SDK-observed slot, child/session identities and session file, with explicitly non-detached execution. These observations grant no authority beyond the registered action and verified inputs. The guard verifies the pinned profile bytes and uses their canonical prompt and tool allowlist; it does not attest which agent-definition file the SDK selected. Before the child starts, it clamps tools to the pinned names actually available as unique built-ins plus the required built-in `yield`, and verifies the exact enabled set and provenance. Unavailable pinned tools are omitted, not replaced by ambient extension or MCP tools. SDK initialization, accepted context, authorized model, schema and guarded yield remain checked before root-result acceptance.

The first provider request requires the exact bound task in an SDK agent-attributed user message. Later turns retain that task anchor and the same live binding, canonical prompt, model and tools; SDK agent-attributed user or developer controls may continue the execution, while human-attributed, unattributed or unknown message roles refuse. Attribution relies on the trusted SDK and privileged extensions, not a public hook that authenticates the origin of each prompt.

An unbound, stale or invalid reserved child aborts during prompt preparation and cannot use tools, including yield. Unrelated child roles are not restricted by this protocol. Missing or invalid guard evidence refuses completion. The SDK, installed privileged extensions and configured model routing are trusted host composition: these checks prevent data-only project/user profile shadows from changing the prescribed session contract, not arbitrary privileged extension code from replacing it. They do not attest final provider-wire bytes or provide hostile-host-process isolation. Without child-factory rebinding, root refusal is not proof that earlier child side effects were prevented.

Generated feature and promotion bodies do not request issue closure; their neutral issue references are not approved bindings. No prose-driven auto-close job replaces calculated termination. A person can still write a keyword that GitHub acts on at the default branch; that native state remains an observation, not proof of UW completion.

### UW Spec and admission

The [glossary](GLOSSARY.md) distinguishes proposed, accepted and effective Specs. The effective Spec contains the UW's own criteria plus every qualified ancestor invariant and exclusion, with the complete accepted version vector. Ancestor criteria are not copied into the child's obligations. Missing, stale, conflicting or incompletely observed ancestry refuses; an editorial label cannot bypass the operator decision for a mechanically material ancestor change. Planning, implementation, review and criterion evidence bind that same effective Spec.

Calculated completion requires the uniquely active authenticated Mandate and its exact accepted OwnSpecRef for the UW and every inherited ancestor; an older pinned grant remains historical evidence, not a substitute for current authority. It checks each current native own Spec's canonical version and accepted tier, including standalone leaves and roots. A mechanically material body or tier discrepancy holds the affected UW, its inherited descendants and managed dependents; proceeding with that change requires the ordinary operator decision. Editorial-only body drift is not a new accepted version. Known or unknown Wayfinder labels cannot retain UW completion or release a managed dependency. This validates current inherited obligations, not a child-to-parent wait edge or a requirement that the parent finish first.

An accepted parent freezes each child's scope, canonical Spec version and tier, not its presentation bytes. Presentation-only edits preserve that commitment in calculated completion, initial child readiness and nested Parent worktree anchoring when the canonical version and tier stay unchanged. Bound Leaf review/correction and direct Parent final-review preparation use that same canonical currentness without rewriting accepted authority. Immutable operation/confirmation snapshots and captured current review inputs remain exact, as do current checkout/code pins. Its explicit coverage map assigns every own criterion to accepted children and covers every engaged child; missing assignments, unknown children and version drift hold progress. The coverage editor starts with empty assignments and binds the displayed parent, inherited references and child commitments when the operator confirms. A changed basis requires a fresh decision.

Scheduling a framed, allocated, Parent-committed child before its first own Mandate is separate from calculated completion. A complete fresh observation, current commitment and inherited version vector, an open Native child and clear blockers can make that initial path ready. Continuation still establishes the ordinary own Mandate. Missing or held proof never counts as child completion, and Native `CLOSED`/`COMPLETED` alone cannot release a dependent UW.

Completion is calculated bottom-up from one complete observation. A leaf needs its actual bound PR merge and admissible proofs for every criterion. A parent also needs all engaged children complete, its own criterion proofs, and a directly reviewed integration head/range containing the delivered child commits; child approval alone is not parent completion. A nested parent must satisfy that full contract before it can count as a completed child. Native issue closure is an observation, never a substitute for this delivery proof.

A parent's criterion citations must resolve to each covered child's actually selected delivery proofs; a shared ancestor citation is not the child's own integration or review proof. Before closing the bound UW, the installed closure's own final writer read obtains a concordant binding and whole common completion observation, including fresh native delivery facts. It evaluates that complete proof before projecting the native root; no later graph-only read can discard related facts. The same full reader confirms the effect. Observed proof loss before the state mutation refuses without a PATCH; proof loss after it remains partial and retains the actual close effect. Unreadable or lost-effect responses do not establish completion or trigger an automatic retry. This is not an atomic GitHub snapshot.

After confirming its own Fix UW withdrawal appends, continuation collects a
bounded, fresh whole UW observation. Exact append receipts must match while
native-scope and retained delivery-dossier fences stay unchanged. Graph,
histories and catalogues are projected together; unrelated drift holds
continuation without erasing a confirmed withdrawal. This is not a GitHub-wide
atomic snapshot.

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

Host-only routes are not `/uw` verbs: `/feature` performs confirmed framing; the parent coverage UI confirms initial coverage (later changes use material acceptance); the PR workflow publishes the authenticated workflow binding; and `closeLinked` closes a bound UW after calculated completion. There are no separate `/uw` frame, gaps, termination, findings, causes, manifest, snapshot, parent-coverage, link-pr or close verbs.

omp-build automated issue body, label, relation and state writes go through UW operations and their shared writer. Standalone issue-triage remains independent. Human GitHub edits are legitimate, but an edited proposal is not an accepted Spec and a manual close is not calculated completion.

`evidence` and `verdicts` read applicable delivery declarations and authenticated criterion verdicts, including the approved bound PR's review history; they do not publish. `action` accepts a JSON object containing `request: UwActionRequest`: it resolves the durable inputs and creates a local read-only snapshot without a GitHub write. Adding `reviewed: ActionInputs` instead replays the stored inputs against current durable sources. The request's code coordinates and references must be readable and match their pinned identities. The installed-plugin pin comes from trusted host composition, never the request file or argv; a missing or mismatched pin refuses.

Review continuation binds the selected initial root to the current authenticated action subject, not an unresolved request placeholder. A PR review uses its exact PR history; a parent final-range review uses its UW history with no invented PR. Both retain complete-history, fingerprint, head and subject checks; the parent also retains the exact base-to-head range. Review Spec inputs come from canonical grammar and authorized records, not priced YAML fences or draft frontmatter.

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

Delivery discovery enumerates all open, closed and merged PRs in the UW's repository, then selects their canonical approved bindings; mentions and branch names are not association authority. Each observation reads complete REST comment histories for the UW, candidate PRs and required mandate homes, reusing observations only within that call. This exhaustive discovery can be expensive and is separate from action/replay reads of their supplied subjects and cited sources. An unresolved binding claim or unreadable required history refuses the read rather than returning an apparently complete empty result.

A candidate is excluded before reading its mandate homes only when a nonempty set of complete, accounted and validated PR binding claims all name homes outside the observed UW. This proves that none can match the UW's accepted delivery mandate; it does not trust an old mandate or assume that a mandate's home always equals its `ownSpec.uw`. Relevant, mixed or uncertain claims retain full binding-chain and format validation. Excluded delivery candidates do not enter retained histories through a shared-cache sweep. Independently required causal references still use the strict reader and can legitimately refuse the observation.

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

A Parent UW runs from its confirmed mandate, not from a session goal. `skills/feature/epic-driver.ts` reads that mandate. The installed command calls `next`, `stop`, `review`, `hook`, `report`, and `control-disarm`. There is no `objective` command and no goal file.

Parent/leaf execution follows the **current authenticated accepted child set**, not the mandate's historical `feature`/`epic` field. Native additions, removals or changed child versions/tiers remain proposals until the existing assessment and exact material-confirmation chain accepts them. Pending drift enters that control path before either delivery lifecycle; missing replay is a refusal, not an empty child set.

The hierarchy shares the [Parent UW worktree](GLOSSARY.md), anchored by its outermost authenticated Parent; nested Parents retain separate branch-null Mandates, not separate branches or PRs. Before Parent integration, the checkout must be clean and detached at the freshly fetched published base. After child merges, integration and direct review may honestly pin an empty `M..M` range: no synthetic Parent commit is needed, but the Parent's own criteria, coverage and child proofs still require independent review.

Publication is proved before the integration START is sealed. RESULT and historical replay must retain that exact captured HEAD: publishing a descendant after START cannot substitute it. A non-empty `M..U` range is not rejected solely for differing base/head when `U` was already the captured published candidate.

Only calculated completion of the whole nested Parent permits continuation into its exact accepted ancestor Mandate in that worktree. A Leaf merge alone does not permit that handoff, and continuation never implicitly unpauses a stopped ancestor.

The public driver composes explicit mandate-parent histories recursively through the same GitHub history adapter before selecting authority. It builds a complete authenticated inventory of the root UW's own PRs and the accepted child set, including children removed from native relations or reclassified as wayfinders. It discovers issue PR references—including cross-references on closed issues—and authenticated child-mandate branches independently. Discovery requires complete issue and branch connections; incomplete pages or unreadable history refuse rather than prove absence. Before any normal `stop` or `next` PR mutation batch, every candidate must pass canonical binding and exact mandate-ownership preflight. Uncertainty leaves containment unconfirmed and does not authorize disarming an unrelated PR. Fresh final-review authorization requires current parent delivery admission; containment and drop do not grant permission to advance delivery.

Scheduling uses the same native inventory for `OPEN`, `CLOSED` and `MERGED` PRs on authenticated owned branches; mutation targets are explicitly `OPEN` only. Relevant terminal PRs must pass canonical binding and exact current-parent ownership checks. An unrelated historical cross-reference is not current delivery evidence and cannot override a valid current branch. Classifying an OPEN PR's gate from its first 30 labels requires explicitly complete page information; a truncated or unreadable label inventory refuses before new PR effects, stop publication or activation.

The driver's eager history and review lists and the UW's composed histories read in adjacent pairs, with at most two history requests in flight. They preserve every requested scope and each history's complete pagination, drain the whole list even after a failure, and join all reads before reporting the first failure in input order. Composed histories retain the successful input prefix on refusal. Publication and mutation retain their existing transport and pre-effect checks; this scheduling change grants no new authority or credential isolation.

Native graph observation overlaps the first pages of at most two already-queued scopes. Both first pages settle before pagination begins; node completion, newly discovered adjacency and diagnostics retain traversal order. Independent connection pagination retains its existing maximum of three native requests in flight. No scope, page, repository lookup or final pre-effect read is skipped or cached.

Scheduling terminality and dependency completion are separate. A closed `NOT_PLANNED` child is not restarted, but does not relieve its dependents; a merged PR alone does not relieve them either. A natively completed child with a still-resumable `OPEN` PR remains in the existing resume/disarm flow. A permanent stop does not reactivate that PR; stopped-PR containment is reconciled before selecting the next step. A merge confirmed during disarm uses the existing bounded reread before final review, whether or not auto-merge was armed, rather than declaring completion from stale PR facts. Only the authenticated PR coordinate survives that reread: merge metadata and ownership are read again, never taken from a cached MERGED result.

Every normal `/4` mandate persists an eight-character coordination run at first creation, including a leaf. Leaf ↔ parent transitions and explicit successors retain that run, mandate lineage and actual permission limits; no promotion, replacement mandate or fresh run is inferred from a link edit. Correction-only authority keeps its separate restrictions. An originally parent-shaped mandate becoming a leaf does not acquire permission bits it lacked.

Pause/abandonment containment covers the UW's own bound PR and its currently approved child PRs, including a former leaf PR that remains open. For a known normal mandate, issue links and matching branches are discovery hints only: each own-PR candidate must bind canonically to that exact selected mandate, for both current leaf and parent roles. Named inactive authority is replayed for disarm only, never reactivated; incomplete replay or PR discovery cannot confirm containment.
Foreign child mandate claims remain observable but cannot veto containment discovery when a complete accounted child mandate belongs to the selected parent. Without that owned authority they cannot establish its absence; expected-author damage and incomplete discovery still refuse.

Unresolved explicit PR containment verifies a repository-qualified reference against the current canonical repository before PR lookup or mutation: `other/service#42` never selects local PR42. Explicit same-repository pause/abandonment containment remains available when ordinary workflow admission is unavailable; it grants no mandate or delivery authority.

An Arrêt d'UW is an `epic-event` whose `event` is the historical wire name `goal-stop`. Independent children continue. A shared-state stop is an `epic-event` whose `event` is `goal-report`. The hook runs once at the current base commit; another commit is `hook-stale`. The report heading remains the historical `## Epic run`. Merged is not complete before the hook and report are observed. Delivery matching, re-disarm, and which stops retry live in the `epic-driver-*` modules. A run id does not reset a spent review bound.

A blocking current parent final review selects the drop step with stop `final-review-blocking`; the run ends with an `epic-drop` report, which does not carry the causes. This is a stop, not automatic correction. Read the persisted per-cause records with `/uw read`; they stay the authority. A review binds its exact initial cause assessment, and any pending, `fix-original` or blocking-sister cause in it keeps that review's verdict blocking. Holds are separate: a pending cause holds review binding until `/uw adjudicate`; a blocking sister holds it until `/uw sister` creates the sister, then stays a wait until the sister completes or `/uw adjust-cause-dependency` releases it. Lifting a hold does not clear the bound blocking verdict, and a final `fix-original` cause has no `/uw` disposition verb. The parent completes only after a fresh final review of a changed range, for example after corrected work in a new child UW. Historical `epic-fix` events remain decodable for diagnostics only.

Feature init imports the emitted `migrate-labels.ts` and `init.ts`, and binds the checkout with `defaultInitDeps(repository, checkout)`. It does not relabel existing issues; standalone issue-triage retains its own init behavior. The resolver is `triage-runtime.ts`; a missing emit stays `issue-triage-unavailable` or `IssueTriageMissing`. `skill://issue-triage` remains the separate optional advisory skill, not the action runtime. The generated `dist/issue-triage/` slice ships with omp-build.

## Commands and tools

| Entry | Lane |
|---|---|
| `/feature` | `omp/index.ts` → `registerCommand('feature')` → `runInstalledFeatureCommand`. Not a skill dump. User lane. |
| `/uw` | Native operator command for proposed/accepted reads, exact proposals, confirmed writes/creation and material acceptance. No agent tool or argv confirmation grant. |
| `/promote` | `registerCommand('promote')`. Dumps `skills/promote/SKILL.md`. User lane. |
| `/cleanup` | `registerCommand('cleanup')`. Dumps `skills/cleanup/SKILL.md`. User lane. |
| `/ci-watch` | `registerCommand('ci-watch')`. Dumps `skills/ci-watch/SKILL.md`. User lane. |
| `/dev-review` | `registerCommand('dev-review')`. Dispatches the host-authorized native review. Not a skill dump. |
| `/fix` | `registerCommand('fix')`. Dispatches the host-authorized native correction. Not a skill dump. |
| `omp_build_start_review` | `registerTool`. Same review dispatch, model lane. Not execution authority. |
| `omp_build_prepare_checkout` | `registerTool`. Canonical checkout for one unambiguous issue reference. A pull-request number checks out that request's existing head instead of minting an issue branch. Returns `ready`, `move`, or `blocked` with the path. Host write approval. Does not publish authority, bootstrap, resume, move the session, or simulate `/feature`. |
| `omp_build_execute_native_batch` | Restricted owned execution tool. Accepts only `{ batchId }` for an announced, sealed batch; it does not authorize or publish work. |

`registerCommand` is the user lane the model cannot call. `omp_build_start_review` is the model-lane review entry; the restricted execution tool runs only the host's admitted batch. Correction starts through `/fix` or the Feature review-bound handoff. A review call still resolves one existing target, re-reads the bound, head, and proofs, and authorizes before inventory and dispatch. Unknown, stale, ambiguous, or already-closed PR targets stop review/correction dispatch. A skill body's `disable-model-invocation` is **not** a second gate: omp normalises it to `hide`, which omits the skill from the prompt listing while `skill://<name>` and `/skill:<name>` still reach it. `@skill` in a task asks the host to load a skill body; it does not create a command or tool lane.

Native delivery uses real SDK child sessions through the owned execution tool, not interception of a built-in Task result. Executor outcomes and errors are retained under `local://` before compact content and details expose a reference; settlement follows retention. These observations conserve what the SDK presents, not a complete raw process stream, and do not themselves grant publication authority.

The owned execution tool declares the SDK's `essential` load mode for direct top-level dispatch in the standard CLI. This does not enable a tool the user disabled or change an existing tool presentation; the lease still requires the owned tool to be active before announcing a batch.

During an owned dispatch turn, a root- and batch-scoped lease temporarily removes the built-in `task` tool while retaining the other enabled tools. The owned tool must already be enabled. Restoration is limited to the same root identity and an unchanged observed tool presentation; if that presentation drifts, omp-build leaves it untouched and stops the owned continuation. This is not a compare-and-swap or an ABA/zero-race guarantee.
Both native root capture and the tool-mask lease bind journal, file and cwd to the live session and command context. A fresh capture after `/move` may observe an older registry `sessionFile` locator; it captures that metadata separately instead of treating it as the live file. Subsequent registry-ref, session, journal, live-file, cwd or provider drift still invalidates the capture; registry locator drift also refuses. Both paths retain the captured model-registry and cost-gate identities; ordinary changes within the same cost gate do not replace that identity. No SDK registry metadata is rewritten, and this does not permit a move during an active lease or relax tool-presentation restoration.

The declared minimum public SDK API level is OMP CLI 18.13.3; type compatibility with that locked SDK is checked separately from runtime UI behavior. The root-capture and tool-mask paths were smoke-tested before and after a real `/move` on unmodified official OMP CLI 18.14.0, without starting a model turn or native workflow. The common confirmation UI has runtime proof only on official OMP CLI 18.18.5, as detailed below; no equivalent 18.13.3 UI run is claimed. Standard CLI credential and model-pool composition is assumed. A custom embedding can present compatible APIs while using opaque credential or pool provenance; that provenance cannot be automatically detected or attested here. Offline and adapter evidence is not real native acceptance: a separate native acceptance run is still required.

The earlier framing confirmation path was exercised on unmodified official OMP CLI 18.18.3 at 80×18, 40×12 and 40×8, including defer/reopen, explicit choices, scrolling and resizing. Diagnostic parent coverage, foundations and escaped supplied text were also observed. External native writes were denied in those probes: they qualify that UI/controller path, not the later generic confirmation surface, native delivery or hosted landing.

The common confirmation path was additionally exercised in native mode on unmodified official OMP CLI 18.18.5 at 101×14 and 39×11: preparation status, deferred reopening of the same proposal, explicit counter-only choices, scrolling with pinned actions, resizing and actual session-switch revocation. Shortcut input used exact Kitty Control+Alt+U bytes through Tern's text transport because its `key Ctrl` alias emitted Super+Alt instead; no physical-keypress attestation is claimed. Fictional proposals and denied external writes qualify the UI/controller path only, not Mandate publication or hosted landing.

## Records

The engine (`engine/`) owns versioned records, reference checks, conservation, counting, derived groups and verdicts, and deterministic projection. It does not judge semantics, call GitHub, or authorize a merge. Roxabi (`roxabi/`) owns the product actions: preparation, native continuation, and publication of inventories before dispatch. It keeps no local durable business store. The GitHub adapters (`adapters/github/**`, `adapters/github-workflow/**`) paginate comments, check native author and revision facts, publish, and read back. They do not classify a finding or authorize landing.

For multi-page GitHub histories, each next page is followed by a comparison of the preceding page's native IDs and revision facts. A changed or unverifiable page returns `complete: false`, retains comments already read, and reports `github-pagination-changed`; read failures retain their existing diagnostics. Relative to GitHub's documented ascending-ID ordering and the undocumented assumptions that new IDs increase, deleted IDs never reappear, and responses are non-stale and monotonic, a complete read includes every comment present throughout the read. Stale or replayed responses can defeat the check. Edits within a preceding page's comparison window cause a hold; revisions outside those windows are not checked, and the result is not a snapshot.

A record frame whose native author is not the trusted login is `foreign`. It stays observable in the decoded history, but it never completes, collides with, blocks, or deduplicates a trusted operation; an identical foreign body does not suppress a publication. A review's time is the native creation time of its final part; editing the comment does not move it.

`encodeRecord` frames each canonical record with its projection. The header is `<!-- omp-build-record v=1 kind=… id=… operationId=… part=i/n data=<base64url> -->`. The payload is authoritative. The Markdown is presentation; no business reader takes a verdict, head, or input from it. A final `review` carries `candidateGitSHA` and `input` (64 lowercase hex SHA-256, or null). Projection lists the record, decision, candidate, input, findings, standards, and source provenance (contribution host plus originals). Legacy `<!-- omp-build:… -->` markers — including `code-review`, `review-head`, `review-input`, and `proof` — are `legacy-format`. They are refused, not parsed, resurrected, or reset.

Projection takes an explicit host `RecordProjectionConfig`, or null. The host supplies `{ taxonomy, acceptedPolicy }`; the candidate does not derive the taxonomy or accept its own evidence policy. Only a final `review` renders a verdict, and that projection refuses null or unknown configuration. Explicit null permits only neutral evidence, decision, and stop publication. Publishers bind that host configuration once. Decoded operations need `authority` and distinct `claimedKinds`; those claims are evidence, not permission, and missing metadata refuses. Projection follows the record's required dependencies from the original history. A foreign, missing, incomplete, or ambiguous reference refuses; it is not repaired, and an opaque record outside that closure does not acquire review authority.

Authoritative review contributions retain captured submissions in `rawAttempts` and SDK-observed terminal material in `native.raw`. The owned execution result conserves outcomes and errors in the referenced local artifact while exposing a compact response; it does not assert an unobserved complete SDK stream. Human contribution text may cite the canonical record or operation rather than dumping retained material. These observations do not replace review judgment or publication authority.

An action result refers to its confirmed start and exact scoped mandate; it does not mint a replacement start at publication. Completion belongs to that action's exact inputs: an old Spec assessment, plan or implementation does not complete a different current action. Unresolved starts and rejected effects remain blocking even when a native PR exists or its current checks are green. The original native result remains visible when host admission rejects its effects; a schema-valid `implemented` claim is not proof that its commits were admitted or reached the remote branch.

Implementation receipts retain SDK-observed terminal material in `native.raw` and observed Bash captures in `native.bashCalls`. For non-test observations, `native.observation` retains the matched yield submission, action ID, child ID and submission index; it authenticates the producer's observation, not its truth or an unobserved command. Native publication distinguishes canonical receipt retention from effect admission. Stopped observations use the same publisher before terminal settlement, without continuation or approval. Expected but unobserved child slots never mint result receipts: their original starts remain uncertain.

The receipt contract does not claim complete SDK-stream retention: it does not retain every intermediate submission or partial text. The offline lifetime witnesses also do not establish actual SDK shutdown ordering or task cancellation.

Before implementation or correction effects and their pushes, the host checks the current remote mandate and controls again and honors the local interruption fence. A terminal result can still be preserved after a pause without authorizing another effect. GitHub reads and Git writes are not atomic: this is not a cross-provider lock, and it cannot guarantee exclusion of a control published after the final authority read.

Implementation command claims contain only `toolCallId`, `command` and `exitCode`; a claim is not an observation. Criterion evidence is admitted against matching completed host captures, with genuinely observed output, working directory and code linkage. Combined output remains combined unless separate streams were actually observed. A model's printed output, asserted SHA or selected tool ID alone cannot establish that linkage; an unobserved linkage stays explicitly unverified.

Native `/dev-review` runs spec → panel → recall → synthesis and publishes the confirmed records. Native `/fix` uses `R-review-fix-intake` and `R-review-fix-synthesis` for a standalone request; a review-bound request instead consumes the already-confirmed decision unchanged, without new intake or synthesis. Correction uses `R-review-fix-apply` and `R-review-fix-falsify`. It does not edit inline in the orchestrator turn and does not revive the absent `R-fixer`. Correction records set `landing: false`.

Correction mandates use the same strict own-UW contract. A bound PR reuses its real accepted UW snapshot, tier and durable identity references, with correction permission but no landing permission. A PR without an authenticated UW binding refuses `fix-own-uw-required` before publication or dispatch; neither its prose nor a correction-scope string becomes an invented `C1`.

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

Feature-owned PR and parent reviews check local continuation before authorization, after authorization before publishing
the inventory, and before native activation. Standalone `/dev-review` and `omp_build_start_review` remain independent
of Feature inhibition. Native Feature ownership is registered before asynchronous work and is not recreated by a stop
callback; passive diagnostics remain visible under inhibition.

An already-engaged GitHub publication is not rolled back. An interrupted inventory can remain explicitly pending:
it is not an approval, does not silently restart, and does not reset the review bound. These guards do not provide
an atomic GitHub transaction or a compare-and-set guarantee.

Review → fix record contract: [root causes and member references](skills/dev-review/root-causes.md).

### Review policy and cause dispositions

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
- **Nested coverage:** seven terminal-delivery reentry cases; both parent
  completion and child-to-parent ownership interruption; both remote-pause
  interleavings during CI attribution and correction synthesis. Original
  results remain evidence even when current authority refuses further effects.
- **Ordinary checks:** build, typecheck, Biome (183 files), isolated imports
  without dependency installation, and the full suite (87 files, 2,054 tests).
  The full suite ran without concurrent native qualification jobs.
- **Limits:** scripted local model provider, fake GitHub transport and local bare Git only. No paid-model efficacy, hosted GitHub adoption, global installation or merge activation is established; T4 and T5 require their separate authorizations.

### C1 portable preparations and coordinator witnesses (candidate 0.11.1)

The C1 cohort passed 43 tests in four focused files with an inherited global Git
configuration that requires an unavailable signing program. The admission and
correction fixtures isolate Git configuration, inherited hooks and shell startup;
every allocated repository or remote is owned before setup can fail. A real
failing Git setup also left no allocated sandbox behind.

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

A separate runtime smoke used the locked OMP 18.12.6 agent parser and both source
and distributed strict schemas. Typecheck and Biome on the eight changed TypeScript
files passed. These are not a full suite result, a C2 deterministic-generation/parity
proof, a C4 lifecycle qualification, model-obedience evidence, hosted GitHub
validation, installation, or merge activation.

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

#### Kit merge-on-green head authorization

The Kit merge-on-green gate uses authenticated `kit-head-authorization:v1` PR
comments, not the `reviewed` label, as authority. A grant binds the immutable
repository and PR identities, PR number, reviewed head and base ref. Before
admission the producer captures the latest authenticated receipt; before posting
it rechecks the scope and predecessor, and reports an arm only after read-back
confirms the exact grant is active. A newer withdrawal denies all lanes. A new
reviewed grant requires fresh admission; a label, old receipt or stale head is
not a substitute. Dependabot grants additionally bind the evaluated base SHA.

Configure trusted repository Actions variables `HEAD_AUTH_REPOSITORY_ID` (numeric
repository ID), `HEAD_AUTH_OPERATOR_IDS` (JSON array of numeric trusted human IDs),
`HEAD_AUTH_APP_ID` (numeric CI App ID), and `HEAD_AUTH_BOT_USER_ID` (numeric bot
user ID). The plugin reads these through the repository Actions variables API, not
the local process environment. All four are required for manual and merge-on-green
authorization. When all are absent, only native auto-merge is permitted; partial
configuration or an unreadable API response, including 403, fails closed.
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

Stop, review-start and protected-push barriers withdraw authority and confirm the
withdrawal before continuing. A failed or ambiguous write, incomplete read or
later grant is not a confirmed disarm. Labels remain hints, including for wakeups;
their absence does not hide an active grant. Native GitHub auto-merge mode keeps
its existing protected-auto behavior.

The stream is append-only by publisher contract, not immutable GitHub storage:
trusted deletion or editing can erase history. Trusted operators, default-branch
writers/dispatchers and App managers remain in the trust boundary. GitHub reads
and merge are not atomic; a change after the final read remains a residual risk.
Returning to the identical head without an accepted withdrawal can match again;
authority for one head never authorizes another.


**The armed gate (#713).** In native auto-merge mode, an OPEN PR is armed — `reviewed`
label or auto-merge enabled — only when the latest review record approves the current
head, the bound is not spent, and no review of that head is running. The four workflow
exits share `enforceArmedGate` (#729), separating actual `reviewing` from
forced-unarmed policy. Its `disarmGate` primitive clears known arms and validates
read-back; Kit merge-on-green additionally requires the withdrawal receipt above.
In native mode `disarmed: true` requires an attempted clear and confirming read-back;
an already clear or non-OPEN gate is a no-op. Every `nextReviewStep` action passes the policy:
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

**What the tests prove.** `armed-gate.integration.test.js` has a clean-baseline sweep that covers one throw-before-effect at each call of the clean baseline (the base read excluded), selected observable head moves after calls that succeeded, and a throw plus a move paired after the gate is acquired. It excludes, and leaves to table rows alone, applies-then-throws and faults inside a disarm that an injected fault first triggers; it makes no claim about future calls. The #731 seeded compound suite is separate from that sweep. The base-read failure is covered by its own real-Bun scenario in `land.integration.test.js`: a discovered, armed, strict landing whose base read fails, with a real local origin. It does not detect both base files vanishing, which defaults to native. The oracle has four negative self-tests (`approve(OLD)` over an armed head, a forged `stays armed — auto-merge` report, a spent-bound armed PR, a text-only "the gate was disarmed" claim). The unreadable-pin row carries `known: '#731'`, an inert provenance marker for a fixed regression: it grants no exemption and nothing reads it. None of this is a proof that every fault ordering is covered.

- `nextReviewStep(cwd, pr, { ciFailed?, reviewing? })` returns `land`, `fix`, `stop`, or `review` from the fresh canonical summary. A fix is allowed while the PR has at most two final reviews. A review after the second that does not approve spends the bound for good; a later green check does not lift it. A CI failure on the head approved by the third review also stops the PR and is published as a canonical `stop`.

- `landPr(cwd, pr)` refreshes records and PR coordinates before every arming write. The selected review must approve and bind the current `headRefOid`; native auto-merge uses `--match-head-commit`. A moved head, spent bound, unreadable review, or failed admission clears the arms instead of retaining an earlier approval.

#### Landing admission

| Condition | Admission requirement |
|---|---|
| Current review and bound | The latest review approves the current head and the review bound is unspent. |
| CI | Red or unreadable CI refuses. Pending CI may be armed; the merge itself waits until the required checks pass. |
| Normative inputs | The accepted configuration and effective Spec with its full version vector, current eligible delivery data, code head/base and pinned repository/plugin/context references reconstruct the approved `/4` manifest digest without the local dossier. PR prose and the review's own outputs are excluded. |
| UW admission | The fresh complete native graph, parsed own proposal, confirmed identity history, accepted ancestor/child versions, tier, coverage and calculated blocker states satisfy the shared UW admission rules at this invocation. |
| Authentic outputs | The expected automation author published every record that establishes the selected review's verdict and findings: its review, inventories, decision, synthesis and finding contributions, and their bound inputs; it also published the workflow binding and mandate chain. Every selected part has readable native `createdAt` and `updatedAt` values, and no part was edited. |

Mandates must use `omp-build-mandate/4`; Spec assessments require `omp-build-spec-assessment/3`, action receipts require `omp-build-action-receipt/2`, and reviews carrying input require `omp-build:review-input/4`. Missing or incompatible formats and obsolete payload fields refuse explicitly. There is no migration, automatic renewal or cross-format recovery path. An active `omp-build-mandate/4` mandate, published by 0.17.x, embeds the removed grouped-fix graph action and is refused as `unsupported` (`unsupported-graph`): continuation, pause, abandon, its accepted Spec and its children stop on it. Pause or abandon such a mandate under 0.17.x before upgrading; a paused one can still be abandoned, and an abandoned or revoked one stays eligible for `/feature new`. Older mandate formats were already refused as `incompatible-format` before selection, whatever their pause or abandon state; that work restarts as a new UW through `/feature <text>`. A workflow history holding a native normalization receipt is refused as `unconfirmed` (an incomplete operation) before any mandate is selected: that UW cannot be paused, abandoned or succeeded, so start a new UW with `/feature <text>`.

An adopted open PR moves directly from `ready` to `review`. The graph has no intermediate admission step.

Behavioral evidence is required by criterion at every tier. A satisfied criterion cites an admissible, code-bound test or observation; content reading alone cannot establish behavioral satisfaction. Bug restoration needs a failing-before/passing-after test or an admissible observed restored behavior. Missing, unverified, proofless or absent criterion verdicts mechanically request changes even with zero findings. Reviewers judge truth and applicability; the engine checks structure, references, versions and the resulting rule. Correction falsification remains a separate obligation; neither green CI nor a digest replaces this review.

`landPr` runs shared admission before writing an arm. For Kit merge-on-green, the gate independently checks the active head authorization and performs a fresh observation before merging; labels alone are not sufficient. This does not make GitHub reads and merge atomic.

When an admitted PR merges during landing observation, the base ref has advanced to the merge commit. Review-input revalidation uses the captured pre-merge base only when the native merge commit's two parents match that base and the admitted head; other input and authority checks remain fresh. A different or unreadable merge ancestry does not grant this exception.

Freshness is per transition and per admission invocation, not a time-to-live. A newly observed blocker stops the next transition rather than interrupting the current action. Final hosted admission reconstructs current manifested inputs, then rereads required blockers, applicability and PR coordinates at its last admission seam. This is not an atomic transaction with later GitHub mutations.

The hosted reader needs readable metadata, issue/PR comments and histories, Git/Contents objects and CI checks/statuses for every required repository, including the pinned plugin repository and inter-repository dependencies or evidence. The existing App-token declaration for this repository does not establish access to another private repository. A missing installation right, incomplete page/part or unreadable required source refuses with the missing repository/reference named; local success or a local dossier is not a fallback. Arming/writing permissions are separate from these read requirements.

A canonical record can span multiple PR comments (`part=i/n`); readers accept only a complete record. The header carries the payload and the Markdown is projection. Native authorship and native timestamps establish what the gate read, not a signature or a lasting pin. GitHub reads, review publication, and arming are separate operations, so a change after the last read can remain undetected while an observer retains an arm.

Record authorship under `OMP_BUILD_AUTOMATION_LOGIN` provides no author/reviewer separation while that login is also the PR author's identity. Reviews run in the local OMP session. `/feature` landing runs shared admission before arming. In native mode it uses the operator's `gh` login for `reviewed` and native auto-merge; Kit merge-on-green instead requires the scoped receipt described above. Deliberate forgery by a trusted operator remains within the trust boundary.

The same trusted author is used for review records, workflow mandates, and bindings. Any future author separation must preserve durable CI-stop records and keep review reads separate from workflow-authority reads.

GitHub viewer identity is fixed for one OMP process. `gh auth switch` requires a new session; the viewer memo includes `GH_HOST`, `GH_CONFIG_DIR`, `GH_TOKEN`, and `GITHUB_TOKEN` but does not observe an in-place account switch.

The bound guards against agent mistakes, not against an agent that bypasses it:
records by other accounts are ignored, and the bound does not detect edits or
deletions of the account's comments; landing admission separately refuses an
edited selected review, mandate or binding record. Every posted review counts, with or without a fix
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
`merge-on-green.yml`, else native. It returns the absolute `/ci-watch` command.
In native mode, `landPr` uses the operator's `gh` login for both native auto-merge
and the `reviewed` label after shared admission. An OPEN `BEHIND` observation stops further
arming and watching: `landPr` returns `behind` after clearing known OPEN arms,
including a pin written earlier in that call. A failed clear throws naming the
remainder; a merge during the clear returns `merged`. The watch exits 7, and its
mapper uses the same behind contract (`applyCiWatchExit` in
`skills/feature/workflow-watch.js`). Both name `gh pr update-branch <pr>`;
omp-build never updates the branch itself. `applyCiWatchExit` preserves watch
statuses while enforcing gate authorization; `disarmReviewedBeforePush` in
`skills/feature/landing-foundation.js` confirms clearing before invoking the push
once, and reuses that receipt if the callback fails. Standalone review and fix do
not label a PR. No duplicate spec files or `validated` gate.

The trusted auto-merge checkout (`.github/workflows/auto-merge.yml`) reads canonical records only from tooling pinned by repository variable `OMP_BUILD_TOOLING_SHA` (40 lowercase hex). It derives the expected author from `--automation-login` for records, the landing mandate and its binding/parent chain, and the selected review. The gate never calls `gh api user`, which installation tokens cannot use. A missing or non-hex pin refuses. There is no fallback to the candidate checkout, workflow SHA, moving branch, candidate code, or a dependency install; the pin's committed `dist/contracts.js` is the reader.

The workflow uses `pull_request_target` so GitHub selects its arming logic from the base repository's default branch, not the PR merge ref. The candidate is an isolated, credential-free data checkout. Bun runs only from the pinned tooling directory, with ambient Bun/Node preloads cleared; candidate scripts, configuration, and dependencies are never executed. A trigger change takes effect only after it reaches the default branch; a local shell smoke does not prove hosted trigger selection.

Every failed or skipped labeled-path admission has a final job-token cleanup, including App-token mint failure. It independently attempts native auto-merge disable and `reviewed` removal, then reads both back; failed writes or a remaining arm are errors. Cleanup never depends on the App token used by the reader. Dependabot is eligible only for semver-minor or semver-patch updates whose every commit author is `dependabot[bot]`.

Admission requires a mandate's `productVersion` to equal the version of the pinned tooling; otherwise it refuses with `config-drift`. The repository variable is the only record of the current pin:

```sh
gh variable get OMP_BUILD_TOOLING_SHA --repo Roxabi/roxabi-plugins
```

#### Tooling-pin update

After every merged omp-build version bump, set the variable to the full `main` SHA that carries that distribution, then update and restart the installed plugin. Until the pin moves, the hosted gate reads with the previous version and refuses mandates published by the new one.

A product-version bump changes the effective workflow config digest. Complete or genuinely abandon active mandates before an incompatible activation. If the current reader cannot authenticate abandonment, retain the blocker and request an explicit owner recovery decision; a source fix or manual merge grants no cutover exception. After applicable activation prerequisites, a genuinely abandoned, conformant current-format UW can use `/feature new #N` for a fresh same-UW successor with current checks and a new config pin, not continuation of the old authority.

```sh
gh variable set OMP_BUILD_TOOLING_SHA --repo Roxabi/roxabi-plugins --body "$MAIN_SHA"
omp plugin marketplace update roxabi-marketplace
omp plugin upgrade omp-build@roxabi-marketplace
```

### Hosted activation prerequisites

- **W1 — event policy:** configured in policy `8844` to allow `pull_request_target` and `push` for `.github/workflows/auto-merge.yml`.
- **W2 — secret visibility (deferred, #892):** `ROXABI_CI_APP_PRIVATE_KEY` is an organization secret visible to all repositories, so a workflow on any branch of this repository can mint the `roxabi-ci` token. Deferred on 2026-10-25 under the single-operator decision. Only the operator or their agent pushes branches here, and forks and Dependabot receive no organization secrets. This workflow does not declare `environment:`. #892 lists the triggers to reopen and the change.
- **W3 — App token permissions:** the `roxabi-ci` installation grants checks read, contents write, issues write, pull requests write, statuses read and workflows write (observed 2026-10-25). The minted token is scoped to this repository, as before, and narrowed to checks read, contents write, issues read, pull requests write, statuses read and workflows write. Contents write performs the native auto-merge; workflows write lets it merge a PR that changes `.github/workflows/`. An explicit parent scope in another repository stays unreadable and refuses.

The separately authorized T5 capability check passed in [run 40180871966](https://github.com/Roxabi/roxabi-plugins/actions/runs/40180871966). The gate reads with the App token (`GH_TOKEN: ${{ steps.app.outputs.token }}` in `.github/workflows/auto-merge.yml`), not the job `GITHUB_TOKEN`; job `issues: write` does not apply to that App token ([workflow permissions](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions) cover the job token only). With the App token narrowed by W3, the run exercised reading issue bodies and comments, including the explicit parent scope [#720](https://github.com/Roxabi/roxabi-plugins/issues/720), PR coordinates and rollup, and the trusted gate's selected-base Git fetch through its process-local credential helper. The real reader ran and refused a PR without a record with `reviewed-head-mismatch`; the token then armed native auto-merge. The credential helper does not persist credentials. This historical capability run is not admission evidence for another PR and does not prove access to private repositories. Local transport smoke coverage likewise does not prove that access.

This is not a new tamper control.

## Guards

The plugin arms its guard chain **in-process**, through `omp.extensions` → `omp/index.ts`. It intercepts `tool_call` and refuses, before the tool runs:

| Tool | Refusal |
|---|---|
| `bash` | bare `bun test` (`bun run test` passes) |
| `bash` | `git switch`/`checkout` off `staging\|main\|master` **in the principal worktree** — escape hatch `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1` |
| `write`, `edit` | content matching the hardcoded-secret / SQL-injection / command-injection table |

The scan **fails open** above `SECURITY_SCAN_MAX_BYTES` (256 KB): a payload larger than the ceiling is not scanned at all. Once `dev-core` is uninstalled there is no second layer behind this one.

Guards are **off** unless the project declares the host-neutral contract (`.dev/stack.yml` or `.dev/dev-core.yml`); without it the interceptor is a no-op and warns once per cwd.

`omp/guards.ts`, `hooks/`, `agent-sources/R-*` (except `R-advisor`) and `skills/shared/` are a **frozen snapshot** (ADR-020): omp-build resolves nothing through a sibling plugin at runtime, so it stays installable on its own. The snapshot is not resynced. The `model:` lines on the five review agents are a deliberate local divergence from that snapshot, not a resync.

`skills/shared/` holds `lib.sh` (base-branch / worktree helpers, sourced as `. "$SCRIPT_DIR/../shared/lib.sh"`) and its `artifact-classify.ts` closure. No `references/` directory travels: the one reference a snapshotted agent cited is inlined into `R-architect` itself, because a `${CLAUDE_PLUGIN_ROOT}` token only expands in SKILL.md bodies — never in an agent body, and never at all in this plugin. `skills/dev-review/SKILL.md` Phase 1 and `skills/cleanup/analyze-branches.sh` are `lib.sh`'s in-plugin callers (`detect_base_branch`).

> **Known caveat, this slice only.** While both this plugin and `dev-core` are installed, both interceptors see the same `tool_call` and reach the same verdict — the snapshots are byte-identical and read the same escape hatch. Expect the refusal, and the no-contract warning, to be reported **once per plugin**: each extension owns a private warned-cwd set, so neither dedupes the other.

## Worktree bootstrap

`skills/feature/worktree-bootstrap.sh` is the script contract. `runWorktreeBootstrap` in `roxabi/workflow-checkout.ts` runs it in the foreground after worktree identity is valid and before dispatch: on `/feature new` before the successor publish, on the first mandate, and on select, resume, or new in an already valid worktree. It refuses the principal. The marker `omp-build-bootstrapped` and lock `omp-build-bootstrap.lock` are environment cache, not business records. `/feature init`, `prepareFeatureCheckout`, `session_start`, and `agent_start` do not run it. Do not shell it out as a second process.

- The script holds a lock in the git dir, so repeated explicit calls wait for a running invocation and then no-op.
- ccc's `settings.yml` lands before `worktree.setup`, so ccc never indexes an ancestor directory while an install runs.
- Worktree lists and setup scalars are read with Bun.YAML (Bun ≥1.2.21) before any transfer or indexing. Flow/block string lists agree and `[]` means no transfer. Invalid YAML or consumed list types fail with the stack filename, leave no completion marker and release the lock. A non-empty `worktree.setup` runs as a Bash snippet; absent, empty or whitespace-only setup falls back to the file declared by `commands.worktree_setup`, from the worktree root. A failed setup also stays retryable. `feature init` preserves a declared setup command instead of adding an empty override. Cleanup uses the same YAML parser for the principal's `worktree.base`, preserving environment > stack > default precedence and quoted/block scalars.

## Agents

`agent-sources/` contains the frozen authored agents: two OMP-native (`R-advisor`, `elon` — `model: "@advisor"`, typed `output:` schema) and five `dev-core` review snapshots (ADR-020 decision 7). `agents/` is generated output: seven copied authored agents plus 18 generated native profiles; do not edit it. The five review snapshots declare `@review, @slow` for the judgment agents `R-adversarial`, `R-architect` and `R-security-auditor`, and `@task` for `R-devops` and `R-tester`. When an unmapped role still hands the choice to the parent is stated below the table. Every authored agent carries an explicit `tools:` pin: the snapshots arrived with their posture stated in prose only, and a read-only floor whose read-only-ness is unenforced is not a control.

Agent-profile `tools` pins the child's built-in capabilities. Native workflow batches are dispatched through the restricted owned execution tool, not the built-in Task tool; this is not a credential sandbox.

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

The parent-model fallback described here applies to ordinary built-in spawns. An owned workflow batch requires a resolved authorized model and rejects an unresolved or changed route before dispatch.

For ordinary operator-directed spawns outside an owned workflow batch: `task` `{ agent: "R-adversarial" | "R-advisor" | "R-architect" | "R-devops" | "R-tester" | "R-security-auditor" | "elon", ... }`. Owned workflow batches use the execution tool described above. Profiles are read from `agents/` of whichever package root is in the extension lane — the `link` symlink, or the marketplace install's `node_modules` symlink once it is listed in `extensions:`. `R-advisor` is a spawnable task agent, **not** the session WATCHDOG (`advisor.enabled`).

`R-frontend-dev`, `R-backend-dev`, `R-fixer`, `R-doc-writer` and `R-product-lead` are deliberately absent (ADR-020 decision 7): their concerns fall to the `R-adversarial` floor through the sibling-drop rule.
Correction does not revive `R-fixer`. `/fix` dispatches the native profiles `R-review-fix-intake`, `R-review-fix-synthesis`, `R-review-fix-apply`, and `R-review-fix-falsify`; the Feature review-bound handoff starts the same correction path.

For built-in task spawns without a `model`: explicit call model, then `task.agentModelOverrides`, then this frontmatter, then the active parent. An operator override for an agent masks the manifest role until it is removed. A role alias in an override expands through `modelRoles`, `@default` included, and OMP uses the override only when that expansion yields at least one model; otherwise it skips the override and reads the frontmatter. `R-devops: "@default"` therefore pins the configured `modelRoles.default`, not the parent's live model, and has no effect while `default` is unset. In omp 18.8.0 the parent's active model is taken by a per-call `model` entry `@default`, a single-entry frontmatter `@default`, and a single-entry frontmatter `@task` while `modelRoles.task` is unset: `R-devops` and `R-tester` run the parent's model until the operator maps `task`. The two-entry `@review, @slow` never takes that path; only the credential fallback above reaches the parent. This describes generic built-in task spawns, not the owned native workflow dispatch.

## Skills

| Skill | Lane |
|---|---|
| `feature` | Installed `/feature` command. `SKILL.md` is the reference, not a dumped lifecycle. |
| `dev-review` | `/dev-review` and `omp_build_start_review` · native spec → panel → recall → synthesis |
| `fix` | `/fix` · native correction profiles; the Feature review-bound handoff starts the same path; not an inline walk |
| `promote` | `/promote` (registered command) · the optional tail |
| `cleanup` | `/cleanup` (registered command) · the optional tail |
| `ci-watch` | `/ci-watch` (registered command) · watches checks, then the merge |

`dev-review` and `fix` dispatch native pipelines, not an inline Markdown walk. Findings identify a local accepted criterion/invariant or explicitly declare outside-Spec work; outside-Spec findings may still block. Each cause receives an evidence-backed [cause disposition](GLOSSARY.md): fix in the original UW, propose a sister that blocks the original, propose a sister after the original, or retain a report on the original UW without creating an issue. Missing or contested blocking evidence stays blocking for motivated operator adjudication; it never triggers a blind fix or automatic report. Exclusions cover only explicitly excluded additional work, not introduced regression, security defects or invariant violations. A sister is created only after genuine confirmation of its exact framed proposal, under the same parent and through the existing UW writer. Active or indeterminate parent delivery holds the addition; accepted coverage belongs to the parent capability. No grouped nonblocking issue is created.

They read their own bundled files through `skill://dev-review/<file>`. `lib.sh` is the exception: it sits one level up, in a non-skill directory, and `skill://` rejects `..`, so `dev-review` Phase 1 traverses from `$SKILL_DIR` instead. **Nothing in this plugin exports `SKILL_DIR`** — only the registered commands print a skill directory (`omp/index.ts`) — so that fence asserts the variable (`${SKILL_DIR:?…}`) and stops when it is unset, rather than sourcing `/../shared/lib.sh` and detecting a base branch against nothing. `cleanup/analyze-branches.sh` has no such problem: it is a script, so it resolves `../shared/lib.sh` from its own `BASH_SOURCE`.

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

The root declaration bridge retains published types; it is not a mirror of every new domain alias. New UW types are exported by their canonical owners and imported type-only. The #897 model cutover replaces the former root types `AcceptedSpec` and `AcceptedSpecRef` with `AcceptedOwnSpec` and `AcceptedSpecStep`, without compatibility aliases.

| Product boundary | Canonical source owners |
|---|---|
| Review, correction and standalone fix | `roxabi/review-contract.ts`, `review-dispatch.ts`, `correction-plan-*.ts`, `fix-entry-{lifecycle,ci}.ts` |
| Feature coordination | `roxabi/feature-contract.ts`, `workflow.ts`, `feature-result.ts`, `feature-watch.ts` |
| UW linked closure | `roxabi/uw-linked-closure.ts` owns fresh binding/graph proof, native state mutation and readback; `uw-installed-operations.ts` composes its ports |
| GitHub history and publication | `adapters/github/`, `adapters/github-workflow/` |
| Native OMP capture, settlement and lifetime | `omp/review-runtime/`, `omp/omp-controller.ts`, `omp/omp-feature-session.ts` |

The Feature contract has four operations: continuation, native-result publication, watch-exit consumption, and session pause. Native completion and watch exits use their own operations rather than unused fields on continuation input. This internal contract cleanup does not reset review bounds or grant landing authority. CLI and trusted CI still apply the common admission contract through their concrete entry points.
The review class catalogue has one source: `skills/dev-review/review-classes.yml`. The aggregate plugin validator checks that this complete asset is readable UTF-8, valid YAML and non-empty, and validates its declared subsumption-pair notes. Native panel and recall tasks receive the canonical catalogue itself. This preserves guidance delivery, not proof that a model obeys subsumption rules; final labels remain model judgments, not classifications repaired by the engine.

History merge guards avoid serializing a retained native-decoded history against itself. Distinct objects still receive the complete conflict comparison; the shortcut retains no cache and skips no fresh observation, closure-growth refresh or selected-history verification.

### Test ownership

Generic record mechanics live in `testing/record-*.ts`; generic workflow records and actions live in `testing/workflow-fixtures.ts` and `testing/workflow-actions.ts`. Product scenarios select the shipped Roxabi graph explicitly through `testing/roxabi-presets.ts`; it is not a hidden default in the generic workflow builders.
Engine behavior families live in `engine/__tests__/` and `testing/workflow-decision-cases/`. Their shared support arranges inputs and external boundaries, without re-exporting the product under test. `testing/extension-api-stub.ts` and `testing/review-runtime-support.ts` are shared cross-boundary support. Expected consumer-visible outcomes stay in the scenarios, outside model inputs. Process-spawning scenarios retain the `*.integration.test.ts` suffix and owned resource cleanup.

Feature domain simulators and subprocess harnesses live in `skills/feature/testing/{gh-simulator,epic-driver,goal}/`; Git sandbox repositories live in `testing/sandbox/`; cross-boundary SDK and recovery drivers are named explicitly in `testing/feature-*.ts` and `testing/native-review-driver.ts`. They arrange external state and invoke the real canonical product owners, rather than implementing alternate admission.

Review-race fixtures finish initial review preparation before arming the Git barrier; only decision settlement overlaps that barrier. The third canonical review case has a 30-second marker bound, a 60-second subprocess bound and a 120-second test budget. The pause race retains the 10-second marker, 30-second subprocess and default integration bounds; the shell release bound remains 20 seconds for both.

The executable GitHub simulator, the goal-only direct driver/workflow entries, and Goal's injected UW callbacks share one kernel: lock, hydration, audit, command handling, and atomic state replacement. Goal's injected callbacks use a scoped in-process invocation; explicit Goal CLI probes and the separate driver/workflow processes retain their executable paths. Default driver, workflow, overlap, and drain coverage keep that subprocess CLI. It persists compact JSON without changing the decoded state or complete ordered call audit. Contended acquisition sleeps for 1 ms between attempts so short state transactions do not impose a 20 ms polling pause. The existing 10-second failed-acquisition deadline and cleanup remain unchanged. This increases polling frequency under sustained contention; it does not guarantee FIFO ownership or model an atomic GitHub transaction.

Commit and comparison metadata is batched from real Git within each request, retaining exact SHAs, trees, all parents and page order. Range observations and simulator transactions remain fresh; no metadata cache spans requests.

The compiled fake `gh` used by integration fixtures disables automatic loading of ambient Bun configuration and `.env` files; fixtures pass their environment explicitly. It remains an external CLI process.

### Quality contract

Run `bun run quality:omp-build` for the same owned-source check used by the pre-commit hook and CI. Physical discovery feeds both the line counter and the pinned Biome command; warnings fail, and an empty lint set is not success.

Vitest runs the inline projects in ordered groups: unit first, then integration with `groupOrder: 1`. Unit inherits `min(8, max(1, availableParallelism() - 1))` workers; integration explicitly uses `max(1, floor(availableParallelism() / 4))` workers. These are separate project limits, not one shared default-group cap. The unit budget is 5s and the default integration budget is 60s. Two long review lifecycle cases and the third canonical review race have 120s test budgets; the continuous Goal case has 180s. These are case-specific, finite integration harness clocks, not Native bounds or performance guarantees. A [full hosted diagnostic](https://github.com/Roxabi/roxabi-plugins/actions/runs/42352240126) observed finite semantic completion beyond several previous clocks; it does not establish the cause of the [original timeouts](https://github.com/Roxabi/roxabi-plugins/actions/runs/42340744132).

| Surface | Enforced limit |
|---|---|
| Runtime code, helpers, types, schemas, live configuration and exclusive omp-build tools | 300 physical lines |
| Genuine executable assertion scenarios, not arbitrary files named as tests | 600 physical lines |
| Every owned JavaScript-family function, including CommonJS and scenarios | Cognitive complexity 15 |
| Focused tests | Error |
| Runtime TypeScript promises | Floating and misused promises are errors; declaration, scenario and test-support roles are excluded |

Generated distribution files and retained inert data are distinguished by their actual ownership/provenance, not a blanket test-directory exception. Other plugins and shared root controls are outside these new caps. Parser and AST types are pinned at `8.0.8`, Biome at `2.6.2`; no effect runtime, database or workflow framework is introduced.

### Owned distribution

`agent-sources/*.md` holds the seven authored generic agents. The producer copies all seven into `agents/` byte for byte and derives 18 native profiles there from `roxabi/native-*-profiles.ts` and the existing strict schemas. Tests and support stay outside the generated surface, in their owning engine, product, adapter and testing trees.

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

Git reads used by verification have a finite 64 MiB buffer to accommodate generated contracts larger than the process default; exceeding it remains a failure.

The verifier also imports the declared extension from an isolated copy of B's plugin subtree through the genuine graph loader of B's lockfile-pinned, physical development SDK, requiring a default extension factory. It then loads the delayed feature modules through their actual module loader and checks the four returned workflow functions without invoking them. This is cold module-load proof, not `/feature` execution or qualification. Automatic dependency installation remains disabled; ambient `node_modules` ancestors and plugin symlinks remain refusals. The designated host-owned SDK module surface is not a plugin npm dependency or an arbitrary ambient dependency. This development-SDK import does not prove the installed production host's version or behavior; those require a separate actual-host observation.

Verification compares complete inventories and raw bytes: candidate = A = B, with candidate and untouched B distribution also bound to HEAD. Comments are not stripped. Modified, missing, untracked/ignored, orphaned or path-dependent outputs are refusals, not approvals. Negative probes exercise the actual verifier CLI and producer only in owned temporary copies; cleanup covers success and failure. CI runs the same verifier before consumer checks; its existing draft-PR skip is unchanged and is not a CI validation.

This is a distribution proof, not evidence of model judgment, hosted landing, installation or activation. It changes neither review records nor execution authority, bindings, bounds or approvals.

Catalogue installation copies the plugin subtree; it does not install npm dependencies. Runtime consumers therefore use the shipped common bundle, which includes Zod; the root development dependency is needed to build it, not to run an installed plugin. No separate npm or issue-triage plugin installation is required.

Parent coverage prompts, canonical graph checkout and Parent integration-pin authentication use that same compiled facade. Those runtime paths must not re-import the Zod-owning source schemas or their transitive adapters; the canonical source implementations remain the producer's inputs.

The clean-import guard also requires a temporary tree with no `node_modules` ancestor. If the default tree is contaminated, a process-local `TMPDIR` pointing to a genuinely clean tree provides environment isolation, not a packaging correction: it changes where owned temporary files are written, never the guard. Remove that override when the default tree is clean; do not delete unrelated dependencies or disable isolation.
