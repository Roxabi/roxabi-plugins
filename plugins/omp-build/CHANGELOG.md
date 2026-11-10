# Changelog

## 0.18.3

- Ask a direct question for each typed confirmation, with the target and the effects the current writer performs. Technical JSON, digests and the detail reference stay under `D Détails`. Supplied text stays quoted so it cannot forge an action line.
- Escape or `Plus tard` keeps the exact proposal pending. `ctrl+alt+u` reopens it in the same live session and location and does not approve. Confirmation still starts on `Plus tard`; only `Confirmer` authorizes effects.
- Show preparation or reading before ports and long remote reads. Clear or replace that status at the result, revocation or stop.
- Bind late messages and UW result files to the original command generation and session/location. Report post-hold failures without losing them during own cleanup, while suppressing replaced outcomes; preserve the exact framing handoff and existing watch-status ownership.
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
