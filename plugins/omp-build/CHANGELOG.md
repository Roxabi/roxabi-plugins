# Changelog

## 0.21.20 (unreleased)

- Retire `/uw action` before request, file or pin reads and remove local dossiers, generic action-input replay and captured-work inventory production (#1046 C4). Keep `/uw evidence`, `/uw verdicts`, and historical assessment, review, correction and cause reads.
- Require the tooling pin to match the installed `package.json` and prescribed procedure files exactly for `/feature` framing. A prior-release pin refuses new framing even when procedure bytes match; releases do not move the pin automatically. Composed implementation, review and correction still use the Accepted Spec and live PR evidence without the tooling pin (#1046 C5).

## 0.21.19 (unreleased)

- `/feature pause` stops only the running session and makes no remote writes. Continue with `/feature <reference>` under the same live mandate; remove the separate `resume` and `resolve-interruption` commands. Historical pauses, interruptions, rejected results and predecessor assessments remain readable without gating composed delivery (#1046 C2).
- `/feature abandon` publishes and reads back exact mandate revocation without depending on the Accepted Spec or PR disarm. Revoked authority cannot push or land, and abandonment leaves no session hold on a later mandate (#1046 C3).

## 0.21.18 (unreleased)

- Keep existing Feature mandates valid across omp-build upgrades, including resume, push and composed landing (#1046 C1). Remove the release allowlist and the retired landing admission path; preserve exact delivery locks and historical binding reads.

## 0.21.17 (unreleased)

- Move hosted merge gating out of omp-build (#1046 C7): the `reviewed` label only arms GitHub native auto-merge on a PR into `main` after a live base, head and check read; GitHub merges once the ruleset requires `ci` and App-issued `review` on the head. An already-mergeable PR is refused with the pinned merge command. Keep the Dependabot lane and fix its commit-author check: a jq syntax error (`"dependabot[bot"]`) refused every Dependabot PR since `e9ff6166`.
- Issue manual Kit grants on the current reviewed head regardless of native omp-build history. Kit still rechecks CI before merging.
- Recognize 0.21.17 under the existing bounded PR-binding policy.

## 0.21.16 (unreleased)

- Show `Ctrl+Alt+U` when a framing proposal is ready and display the `/move` command and attestation steps when publication is complete but delivery is waiting for the worktree.
- Lead framing confirmation with publication effects and final criteria; keep identity history, normalization, and the exact proposal in `Détails`.
- Recognize 0.21.16 under the existing bounded PR-binding policy.

## 0.21.15 (unreleased)

- Remove the native batch runtime (#1037): `omp/review-runtime/`, the `omp_build_execute_native_batch` tool, the 18 generated `R-review-*`/`R-workflow-*` profiles and their generator, the UW native launches, and the transport tracking left inert by 0.21.14. The session chooses its agents; `agents/` ships the 7 authored ones. Model tools left: `omp_build_framing_submit`, `omp_build_prepare_checkout`.
- `/uw sister` and `/uw promote-report` still create a UW with no parent or under an inactive parent; under an active parent they refuse before any write while parent delivery is suspended (slice 6 of #1031).
- `/feature resolve-interruption` refuses: native non-dispatch can no longer be proven. For an eligible paused mandate it names `/feature abandon`, then `/feature new`.
- Historical review, fix, assessment and interruption records stay readable; parent pause/abandon containment stays.
- Recognize 0.21.15 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.14 (unreleased)

- Remove the native correction and review entry points that `/feature`'s composition replaced (#1037): the `/fix` command, the `omp_build_start_review` tool and the recovery tools `omp_build_terminalize_interrupted_review`, `omp_build_grant_review_replacement`, `omp_build_replace_interrupted_review`, `omp_build_recover_interrupted_fix`. Corrections go through `/dev-fix`, reviews through `/dev-review`. The code only they reached is deleted; historical review and fix records stay readable. The native review runtime, `omp_build_execute_native_batch` and the generated profiles go in the next step.
- Recognize 0.21.14 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.13 (unreleased)

- `/feature` composes the skills instead of running the native graph (#1037). The command keeps issue resolution, framing, the operator controls, mandate selection and the worktree; it then loads `skills/feature/SKILL.md` with a `## Feature context` block (repository, issue, mandate, branch, base, worktree, bound PR) and an `## Accepted Spec` section carrying a `spec` digest. The agent plans, implements with the agents it chooses, follows `/dev-review` and `/dev-fix` (two correction rounds per run), and resumes from Git and GitHub facts: no plan or implementation receipts, no engine-launched child. Delivery serves the default branch only.
- `skills/feature/feature-cli.ts` holds the engine locks the instructions call, each after re-reading the live mandate and the leaf status: `push` (exact tip, lease on the expected remote head, no tags, explicit GitHub push URL), `open-pr` (one PR, confirmed `workflow-binding`; several open candidates or only a closed PR refuse), `land --spec` (one `gh pr merge --match-head-commit`, only when the base's rules pin `review` to one App, no merge queue, and the accepted Spec digest is still current), `finish` (closes the UW). Composed `/dev-fix` pushes through `push`; composed `/dev-review` writes the Spec digest in its evidence header.
- UW completion accepts a merged bound leaf whose merged head has a successful `review` check from the App the base rules pin; historical structured-review proof stays readable.
- `/feature` on a parent issue stops: parent delivery is suspended until slice 6 of #1031. The native feature graph code it no longer reaches is deleted.
- `/dev-review` also finds the issue from the `UW #N` line.
- Recognize 0.21.13 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.12 (unreleased)

- Add `/dev-fix`, the instructions that replace `/fix`. The command loads `skills/dev-fix/SKILL.md`: on an open PR into the default branch whose latest complete review comment by a writer (`## Review — head <sha> base <branch>` … `Verdict: …`) covers the current head and base, implementer agents fix its findings and the failing checks on the PR branch, behavior fixes come with a falsified test, the exact tip is pushed through `origin`, re-verified as the PR's repository just before, with a lease on the reviewed head (`--force-with-lease=refs/heads/<branch>:<head> origin <tip>^{commit}:refs/heads/<branch>`, no tags), after re-reading the PR state, base and unedited review, and a `## Fixes — head <tip>` comment maps each finding; the next step is `/dev-review`. Without an open PR or a current review it stops. Run standalone, it is authorized by the operator who runs it. `/dev-review` writes that review header and `Verdict:` line and names `/dev-fix` as its request-changes step.
- `/fix` stays the native correction command, marked retiring: it goes with the native runtime when `/feature` moves (#1037). `skills/fix/` (its unused reference body and the falsification guide that the native falsify profile does not read) is deleted.
- Recognize 0.21.12 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.11 (unreleased)

- `/dev-review` becomes instructions instead of a native dispatch. The command loads `skills/dev-review/SKILL.md`: bind an open PR that targets the default branch, its head and base, fetched from the PR's own repository; review in a detached worktree at that head; spawn read-only reviewer agents (`R-adversarial` always, `R-architect`, `R-security-auditor`, `R-tester` or `R-devops` by diff) and approve only when every one completed and no blocking finding remains; re-check head and base, post one findings comment and, when the head is approved, the `review-verdict v1 head=<sha> approve evidence=<url>` line that the `PR_Main` ruleset requires as `review`. Without an open PR it stops. The native review stays behind `omp_build_start_review` and the `/feature` review step until they move (#1037); the test driver starts it through that tool.
- Recognize 0.21.11 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.10 (unreleased)

- Push the verified implementation tip and show git's stderr when that push is rejected. `/feature` checked that `HEAD` was the verified tip, then pushed `HEAD:refs/heads/<branch>`, so a checkout moved in between could publish another commit; it now pushes `<tip>^{commit}:refs/heads/<branch>`, which a local branch named like the SHA cannot shadow. A rejected push stopped with `feature-stopped: implementation-push-failed` and dropped git's message; the notification now ends with `· git push: <stderr>`, `no stderr` when empty, also when retaining the RESULT refuses or throws (then after the retention failure, as `implementation-push-failed · git push: <stderr>`). The stderr is whole: git can echo a credential (a credential-bearing push URL, curl tracing), which the session's agent would see anyway when running git itself. The RESULT record keeps the reason code only.
- Recognize 0.21.10 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.9 (unreleased)

- Prune obsolete omp-build agent and distribution outputs after a successful in-place build. Fresh output builds remain isolated and verification remains read-only.
- Recognize 0.21.9 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.8 (unreleased)

- Keep a native child running when its own background job finishes. OMP moves a long `bash` call to a background job and delivers its result to the child as an `async-result` message attributed to the agent. The executed-child guard admitted only user or developer continuations, so it aborted the child's next turn (`Interrupted by user`). Every later prompt was then dropped (`yield reminder dropped before provider dispatch after 4 attempts`), and the implementation RESULT was unadmitted. Native children now run with bash auto-background disabled, so a long command returns its own exit code, which is what command evidence needs. A text-only `async-result` attributed to the agent, from an explicitly asynchronous call, is admitted as a continuation after the first provider turn; its command still cannot ground evidence. Other custom messages, human attribution and image-bearing results stay refused.
- Recognize 0.21.8 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.7 (unreleased)

- Let a successor mandate plan when its predecessor's plan or plan-review attempt was interrupted. The plan gate counted every unresolved attempt of the issue, so after `/feature abandon` and `/feature new` the abandoned mandate's interrupted pair stopped the new one with `plan attempt was interrupted and awaits an operator resolution`, which `/feature resolve-interruption` cannot clear for an abandoned mandate. The plan, implement, context and CI attribution gates now ignore another mandate's interrupted attempts, whose host stop proves no admitted effect, and the plan start-without-result check accepts another mandate's START when its RESULT authenticates the pair. An orphan START of any mandate, or one whose RESULT does not authenticate it, still leaves the decision uncertain.
- Recognize 0.21.7 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.6 (unreleased)

- Let native batches pass the task mask on OMP CLI 19.1.0. That release renamed the mounted `xd://` tools to tool commands (`getMountedXdevToolNames` became `getMountedToolCommandNames`), so every native batch stopped before dispatch with `root.getMountedXdevToolNames is not a function`; the native task mask now reads either name. This does not qualify the rest of a native batch on 19.1.0.
- Confirm `/feature abandon` disarm from the issue's own linked PRs. The discovery searched `linked:issue:N`, which GitHub reads as "linked to any issue", so every unmerged PR of the repository failed ownership and no abandonment confirmed a clean disarm; since 0.21.5 that kept the local abandon hold and stopped the following `/feature new`. Discovery now reads the issue's closing PR references in this repository; PRs on a further page keep the disarm unconfirmed while those already listed are still disarmed.
- Recognize 0.21.6 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.5 (unreleased)

- Restart a UW cleanly after explicit abandonment and `/feature new`. A rejected implementation or integration result that forms an authenticated START/RESULT pair now blocks only the mandate that produced it, so the new mandate plans instead of stopping on `implement result was not admitted`. A confirmed abandonment with clean PR disarm releases the local `/feature abandon` hold, and `/feature new` releases the session's continuation hold, so `/feature new` in the same OMP session neither stops on `Abandon was inhibited locally but not confirmed` nor leaves its first START unlaunched with `continuation-inhibited`; deferred, refused, partial or disarm-failed abandonments keep the hold.
- Recognize 0.21.5 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.4 (unreleased)

- Keep OMP model fallback in native workflow children. The executed-child guard no longer cancels a child whose model differs from the role's model, so a provider failure falls back through the configured `retry.fallbackChains` instead of costing the action. The role still selects the model route; a spawn hook may restate it but no longer replace it, fallback entries included. Session, root, profile, tools, context, system prompt and yield checks are unchanged; with `externalThinking` enabled, a fallback that adds the `think` tool still stops the child.
- Recognize 0.21.4 under the bounded PR-binding policy while preserving earlier supported versions.

## 0.21.3 (unreleased)

- Scope authenticated `missing-context` action holds to the mandate that produced them. After explicit abandonment and `/feature new`, an old mandate's negative no longer blocks planning, plan review, implementation or CI attribution; a current-mandate negative still blocks as before. Interruption, orphan and lineage rules are unchanged. Another mandate's negative must still be an authenticated pair, otherwise the action stays uncertain. Spec-assessment negatives are not covered: they still prevent pause/abandon of their mandate and block authentication of that mandate's earlier work.
- Recognize 0.21.3 under the bounded PR-binding policy while preserving earlier supported versions. This source change does not migrate mandates, activate tooling or authorize recovery.

## 0.21.2 (unreleased)

- Drop code-index tools from the feature workflow: `/feature init` no longer proposes ccc or codegraph, and worktree bootstrap no longer runs `codegraph init` or requires its CLI. Bootstrap is transfer, setup and marker only; a project that opted in to codegraph indexes its worktrees itself.
- Recognize 0.21.2 under the bounded PR-binding policy while preserving 0.21.0 and 0.21.1. This source change does not migrate mandates, activate tooling or authorize recovery.

## 0.21.1 (unreleased)

- Stop preparing cocoindex-code (`ccc`) in worktree bootstrap: no CLI requirement, store copy or `ccc index`/`reset`. A principal holding a stale `.cocoindex_code/` no longer fails bootstrap on a host without `ccc`; codegraph indexing is unchanged.
- Recognize 0.21.1 under the bounded PR-binding policy while preserving 0.21.0. This source change does not migrate mandates, activate tooling or authorize recovery.

## 0.21.0 (unreleased)

- Add bounded interrupted-correction recovery for authenticated originating owners that sealed admission, joined known trusted host work and witnessed no native/startup or correction-plan entry. Predecision publication can close neutrally before a new ordinary attempt; an unstarted existing-review decision can continue the same request and decision only with genuinely unspent execution coordinates.
- Hold entered, spent, ambiguous or unproven attempts for separate reconciliation; do not infer cessation of arbitrary helpers or automatically reconcile local effects. Positive host qualification is Linux-only and remains separate from this source change.
- Merge a late streamed yield observation into its uniquely matching executed yield only when the tool-call ID and complete arguments agree; unmatched or differing observations do not acquire execution authority.
- Keep edited or invalid incomplete fragments blocking, refuse neutral closure under paused mandates, and hold Fix preparation, confirmation and no-entry settlement when known foreign native batches are active.
- Restore bundled contract runtime imports for clean installation, preserve normal Parent observation identity and retain GitHub read diagnostics.
- Defer ordinary and Epic review-to-Fix delivery until the predecessor's execution and settlement join; external stops fence and join detached publication, selection and delivery callbacks while preserving their failures.
- Join the exact owned Fix driver, host release and native work before explicit pause; preserve stop, pause and notification failures, and hold pre-owner ingress without a completion handle.
- Carry the originating Feature ownership guard through Fix/CI completion and continuation; command replacement cannot revive an old continuation after pause/resume.
- Recognize exactly 0.21.0 under the existing bounded PR-binding contract; unknown versions remain unknown. This source change does not activate tooling, move pins, upgrade installed caches, migrate records or qualify native delivery.

## 0.20.1 (unreleased)

- Prepare and validate CI correction inputs before publishing the canonical root. Authenticate intake against that root and bind synthesis to its complete findings set; CI attribution stays authenticated stage data, not dispatch authority or a decision finding.
- Resolve `/fix #issue` only through the exact current mandate and uniquely bound open PR; remove PR-less correction targets and retain typed, no-write refusals.
- Refuse credential-bearing effective push URLs and absent or mismatched remote branch tips before publishing correction roots. Preserve exact repository and push-origin identity checks.
- Preserve the ordinary correction's own live request and publication ownership checks without widening the existing standalone decision-backed closure gate.
- Recognize 0.20.1 under the bounded PR-binding policy while preserving 0.20.0. This source change does not migrate mandates, activate tooling or authorize recovery.

## 0.20.0 (unreleased)

- Add an opt-in manual `inventory --force` / single-path `remove --force` mode. It requires a fresh mode-bound token, exact path selection and `--ack-discard-local-data` before abandoning tracked/staged edits, untracked files or ignored data. Incomplete usage inspection still needs its separate acknowledgement; safe mode remains unchanged.
- Inspect the entire force candidate without following symlinks or reading payloads, retaining nested Git repositories, mounts, special files, uncertain paths, active usage and every existing structural/Git guard. Bind force selection to exact status, index and observed worktree metadata, including changes inside ignored directories. Preserve branch/tag refs and retained commits; no automatic escalation, pre-deletion or raw deletion.
- Keep administrative `modules/` repositories even after a submodule checkout or gitlink disappears: Git's forced removal skips its normal submodule guard. Disable fsmonitor/untracked-cache status shortcuts and refresh observable usage after the full tree walk before force removal.
- Recognize exactly 0.20.0 under the existing bounded PR-binding writer contract; future versions remain unknown. This source change does not publish or activate tooling, move pins, migrate records or authorize deletion of any existing worktree.

## 0.19.2 (unreleased)

- Resolve tracker repository defaults only when needed, so feature init can preview and apply the selected checkout's tracker from an installed script outside that checkout. Recognize 0.19.2 under the existing bounded PR-binding policy; unknown versions remain unknown. This does not migrate records or activate tooling.

## 0.19.1

- Treat a finite set of already-ignored dependency, cache and build-output artifacts as conditional cleanup candidates. Keep tracked changes, nonignored untracked files and unknown local data protected.
- Require explicit exact-path selection and `--ack-ignored-artifacts` for the entire listed artifacts; bind fresh inventory tokens to the exact visible ignored manifest. Incomplete usage observations still require a separate `--ack-unknown-usage` acknowledgement. Artifact names and metadata do not prove regenerability.
- Walk artifact metadata without reading payloads or following internal symlinks. Preserve nested Git repositories, mountpoints, special files and uncertain filesystem states; remove approved worktrees with ordinary `git worktree remove` only and preserve every branch.
- Present short, explicit path batches without preselected deletion choices.
- Recognize exactly 0.19.1 under the bounded PR-binding policy with the same writer contract as 0.19.0; future versions remain unknown. This source update alone neither migrates mandates, moves tooling pins, upgrades installed caches, authorizes cleanup nor qualifies native delivery.

## 0.19.0 (unreleased)

- Let the workflow engine decide CI continuation and business stops from fresh observations. Check runtime/configuration compatibility before offering resume; preserve read failures instead of inventing business verdicts.
- Restrict confirmed interruption resolution to exact STARTs positively prevented from activation or fenced closed before native admission in the current process. Closure requires confirmed terminal RESULT retention; pending, failed or uncertain publication, missing evidence and admitted dispatch stay blocked. Recheck the selected paused authority on final readback rather than announcing a pause contradicted by newer controls.
- Keep prior preparation and root-turn effects intact and let ordinary admission perform fresh code checks; resolution proves no native child dispatch, not absence of all effects. It does not reconcile effects, adopt implementation commits or assert successful execution. Malformed legacy history remains blocking, including beside a synthetic abandon.
- Preserve confirmed remote branch/tip facts, including already-remote authority refusals, without claiming a new push, RESULT retention, admission or resume. Preserve publication and notification failures through the actual native settlement boundary, with their original causes.
- Preserve recoverable landing holds, their next decision and pausable ownership. Project the UW, action and executors in the owning session; distinguish queued, running, stopping, uncertain, paused, held and done. Keep abandonment refusal and partial-disarm diagnostics.
- Fence native activation and announcement to the initiating command origin, including when asynchronous preparation outlives a session replacement.
- Recognize 0.19.0 under the bounded PR-binding policy; future versions remain unknown. This source change neither migrates existing mandates nor activates tooling, changes a pin/cache, authorizes a suspended witness or qualifies native delivery.

## 0.18.11

- Recenter `/cleanup` on read-only multi-repository worktree inventory and explicitly selected worktree removal. Preserve every branch; remove coupled remote deletion, label sweeps and CI cancellation.
- Enforce fresh path/HEAD identity, local-data, Git-operation, lock and observable process-usage checks in the bundled executor. Keep active, dirty and nonempty orphan paths; incomplete usage observations require a separate exact-path human acknowledgement. Remove empty shells with `rmdir` only; reject blanket `--yes`.
- Replace the misleading merge-proof analyzer with worktree-level safety checks and outcome-based Git integration coverage.
- Recognize 0.18.11 under the existing bounded PR-binding policy; unknown policy versions still refuse.
- Update source only. No cleanup, installed-runtime upgrade, tooling activation or pin change is authorized by this release.

## 0.18.9

- Restore role-scoped code exploration in the action worktree for planning, plan review, implementation, review and correction. Source, tests, technical documentation and CI/build/test configuration need not be preselected in the snapshot.
- Keep authoritative UW data and pinned normative references snapshot-only. Preserve dossier-only roles, existing tool permissions, snapshot integrity and publication authority; do not claim filesystem or credential isolation.
- Require a clean observed worktree before preparing a plan draft, amendment or specialist plan review, including nonignored untracked files. Dirty or unreadable state refuses before action preparation; no cleanup or continuous filesystem guarantee is implied.
- Recognize 0.18.9 under the existing bounded PR-binding policy; unknown policy versions still refuse.
- Update the source product version only. This release does not activate tooling, move its pin, upgrade an installed cache or authorize a suspended witness.

## 0.18.8

- Require new-policy PR bindings to match the mandate and native branch and base at publication and selection, while retaining historical off-branch and branchless facts under their original rules.
- Discover covered delivery candidates by every relevant mandate branch across all PR states and pages, without filtering by base; canonical bindings remain the association authority.
- Preserve both exhaustive observations for the first uncovered legacy succession. Bound a fully observed, rediscoverable old prefix only through an authenticated new-policy successor control; incomplete, competing or post-boundary legacy history refuses.
- Ignore foreign claims when determining UW home-history coverage; candidate PR binding guards remain strict and can still refuse foreign-only claims.
- Update the source product version only. This release does not activate tooling, move its pin, upgrade an installed cache or authorize a suspended witness.

## 0.18.7

- Revalidate workflow history comment pages with GitHub (`If-None-Match`). An unchanged page answers `304`, which the primary rate limit does not charge: repeated closure reads in one host process cost quota only for the histories that changed. Every read still asks GitHub; the in-memory, compressed, byte-capped copy is returned on that `304` alone and never replaces a failed request.
- Name the failed reads when a causal context is refused for an unavailable observation at `/feature` selection, continuation, succession or CI correction. `fix-own-uw-unsettled` and the codes after it are unchanged; the observation's own diagnostics follow them in the operator stop. Start publication and PR binding still report the code alone.
- Read latency is unchanged: histories are still read sequentially.
- Update the source product version only. This release does not activate tooling, move its pin, upgrade an installed cache or authorize a suspended witness.

## 0.18.5

- Authenticate the own abandoned mandate tip and its complete successor chain before explicit succession. Authenticated successor controls keep earlier revoked predecessors superseded without inventing separate abandon records. Historical accepted framing is an input to succession, not renewed delivery authority.
- Preserve complete child commitments and ordered inherited references. A Parent with a managed child cannot silently replace the child's fixed parent mandate; nested succession retains the active ancestor's ordinary guards.
- Prepare and consume Parent coverage confirmation against the authenticated historical acceptance, including the normal principal-to-worktree handoff.
- Collect explicit own-UW PR facts before publication, retain those commitments across bootstrap, preserve the same compatible request and pin its native facts and authenticated binding proof across later writes. A later refusal can leave a published successor or selection control; publication is not transactional.
- Update the source product version only. This release does not activate tooling, move its pin, upgrade an installed cache or authorize a suspended witness.

## 0.18.4

- Acknowledge valid commands through the public UI before ports and long remote reads. Explain every confirmation shortcut and keep phase status outside model/user progress messages.
- Distinguish preparation, queued/open/held confirmation and a started action. Retain honest started-after-stop feedback until settlement without vetoing a live successor framing owner; a predecessor's delayed stop cannot cancel its successor's confirmation.
- Report current preparation and post-hold failures once through the existing canonical formatter, and never equate a confirmed choice with successful publication.
- Keep root command reports and command-result files within their captured full session/location and actual artifact sink. Operator-feedback notification/status failures cannot interrupt its cleanup or alter the command result; controller-owned journals and other framing projections retain their existing behavior.
- Compile the integration fixture's physical-checkout tooling reader once per run instead of cold-starting its TypeScript CLI for every read. Keep the same live Git reads and pin semantics without increasing test timeouts.
- The product-version bump changes the effective workflow config digest. This source delivery grants no activation, tooling pin, installed-runtime upgrade or terminalization exception.

## 0.18.3

- Ask a direct question for each typed confirmation, with the target and the effects the current writer performs. Technical JSON, digests and the detail reference stay under `D Détails`. Supplied text stays quoted so it cannot forge an action line.
- Escape or `Plus tard` keeps the exact proposal pending. `ctrl+alt+u` reopens it in the same live session and location and does not approve. Confirmation still starts on `Plus tard`; only `Confirmer` authorizes effects.
- Show preparation or reading before ports and long remote reads. Clear or replace that status at the result, revocation or stop.
- Bind late command outcomes and UW result files to the original command and session/location. Report post-hold failures without losing them during own cleanup, while suppressing replaced in-flight outcomes.
- Preserve background watch, review and fix notifications after command settlement, including an intervening read-only UW or idle settled-turn abort. Their own owners and original session/location still apply; framing keeps its exact lease. No execution authority is added.
- Keep native actions docked while the human question and long details scroll. Preserve a readable body at narrow widths. Native clicks check the live viewport, remain inactive below the safe height, and work on the first attempt after height-only recovery without a stale disabled state.
- The product-version bump changes the effective workflow config digest. This source delivery grants no activation, pin, installed-runtime upgrade or terminalization exception.

## 0.18.2

- Exclude a delivery candidate only when its nonempty, authenticated PR binding claims all name mandate homes outside the observed UW. Unrelated historical mandates no longer prevent observing a current delivery; relevant and ambiguous claims retain full validation.
- Keep excluded delivery candidates out of retained authority histories and shared-cache sweeps. Independently required causal references still use the strict reader.
- The product-version bump changes the effective workflow config digest. Existing mandates are not implicitly compatible, and this correction grants no activation or terminalization exception.

## 0.18.1

- Keep a deferred framing proposal available to `ctrl+alt+u` in the same live session and location. Explicit refusal discards it; only explicit confirmation authorizes effects. Preserve freshness, revocation and one-use guards.
- Present readable consent facts, including source accounting, coverage, foundations and replacement effects, with separate technical details and fixed keyboard actions. Escape supplied text and disable decisions when the viewport is too small.
- Propagate deferral without claiming approval or a missing UW; commands outside retained framing require explicit re-entry.

## 0.18.0

- Drop a run whose current parent final review is blocking (`final-review-blocking`, reported as `epic-drop`) instead of creating a grouped fix issue. The verdict comes from the review's bound initial cause assessment: `/uw adjudicate` and `/uw sister` lift binding holds but do not clear it, and a `fix-original` cause has no `/uw` verb. Only a fresh final review of a changed range completes the parent.
- Refuse `/feature new` on an abandoned or revoked UW whose body is nonconformant (`successor-spec-nonconformant`); there is no in-place conversion, so start a new UW with `/feature <text>`. Remove the native normalization action and profile.
- Use canonical Spec grammar and authorized records for review inputs, without legacy priced fences or draft frontmatter.
- Keep `/feature init` from relabeling existing issues.
- An active `omp-build-mandate/4` mandate, published by 0.17.x, embeds the removed grouped-fix graph action and is refused as `unsupported` (`unsupported-graph`): continuation, pause, abandon, its accepted Spec and its children stop on it. Pause or abandon such a mandate under 0.17.x before upgrading; a paused one can still be abandoned, and an abandoned or revoked one stays eligible for `/feature new`. Older mandate formats were already refused as `incompatible-format` before selection, whatever their pause or abandon state; that work restarts as a new UW through `/feature <text>`. A workflow history holding a native normalization receipt is refused as `unconfirmed` (an incomplete operation) before any mandate is selected: that UW cannot be paused, abandoned or succeeded, so start a new UW with `/feature <text>`.
- Document all `/uw` verbs, host-only operations, issue-write ownership and the limits of manual edits.

## 0.17.2

- Frame free-text requests and eligible existing issues through one accounted aggregate confirmation. Incomplete aggregates remain held; framing is not Spec acceptance or a Mandate.
- A held framing aggregate refuses delivery, landing and continuation transitions, including after a concurrently published first Mandate; pause, abandon and stop remain available. The hosted gate adopts this only after the tooling pin advances.
- Prepare the canonical checkout without relocating the session. When needed, a human observes `/move` success and continues the same UW from the destination without retyping.
- Pin and verify the three installed framing procedures. Typed forms and context projection do not establish provider receipt or human reasoning.
- Refuse incomplete GitHub comment histories when a preceding page changes during pagination, retaining observed comments and a named diagnostic.
- Keep ordinary relation-endpoint checks independent of unrelated historical delivery sources, while preserving framed-member currentness and authenticated past acceptance.
- A Parent's first Mandate consumes its confirmed coverage: the same `/feature` call continues to the next step instead of stopping with `parent-coverage-intent-changed` and asking for the coverage again.

## 0.17.0

- Use scoped, authenticated reviewed-head authorization for Kit merge-on-green instead of treating the `reviewed` label as authority. Withdrawals fence stop, review-start and protected-push paths; native auto-merge retains its existing protected-auto mode.
- Include the MIT-licensed Kit head-authorization core and its provenance with the plugin distribution. Configure the repository, operator, CI App and bot identities before using the Kit gate; see the [landing safeguards](README.md#existing-review-and-landing-safeguards).
- Run the head-authorization CLI and watcher Bun subprocesses with installed trusted Bun and compiler configuration and automatic `.env` loading disabled, even when the target repository is the working directory.
