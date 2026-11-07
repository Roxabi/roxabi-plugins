# Changelog

## 0.18.0

- Drop a run whose current parent final review is blocking (`final-review-blocking`, reported as `epic-drop`) instead of creating a grouped fix issue. Pending and sister causes are resolved with `/uw adjudicate` and `/uw sister`; a `fix-original` cause needs corrected work and a fresh final review.
- Refuse `/feature new` on an abandoned or revoked UW whose body is nonconformant (`successor-spec-nonconformant`); there is no in-place conversion, so start a new UW with `/feature <text>`. Remove the native normalization action and profile.
- Use canonical Spec grammar and authorized records for review inputs, without legacy priced fences or draft frontmatter.
- Keep `/feature init` from relabeling existing issues.
- An active mandate published before 0.18.0 embeds the removed grouped-fix graph action and is refused as `unsupported` (`unsupported-graph`): continuation, pause, abandon, its accepted Spec and its children stop on it. Pause or abandon every active mandate before upgrading; a paused one can still be abandoned, and an abandoned or revoked one stays eligible for `/feature new`. A workflow history holding a native normalization receipt is refused as `unconfirmed` (an incomplete operation).
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
