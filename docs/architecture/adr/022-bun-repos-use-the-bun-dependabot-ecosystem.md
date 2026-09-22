---
title: "ADR-022: A bun repo uses the bun Dependabot ecosystem, and pays for it"
description: >
  A repo that installs with bun declares `package-ecosystem: bun`, not `npm`.
  The npm updater never writes `bun.lock`, so it bumped manifests and left the
  lockfile behind, and a bare `bun install` then re-resolved the floating range
  on every CI run. The price is explicit: the bun ecosystem has no Dependabot
  security updates and GitHub's dependency graph does not parse `bun.lock`.
  Resolves #518.
---

## Status

Accepted — 2026-09-22. Resolves Roxabi/roxabi-plugins#518.

Applies to every repo the workflow generator scaffolds with `stack: bun`.

## Context

`.github/dependabot.yml` declared `package-ecosystem: npm` while the repo
installed with bun. The npm updater reads and writes `package-lock.json`; it
never touches `bun.lock`. Every Dependabot bump therefore moved `package.json`
and left the lockfile behind. On `main` the drift had been open since
2026-07-29:

| | `package.json` asked | `bun.lock` recorded |
|---|---|---|
| `@biomejs/biome` | `^2.5.5` | `^2.5.3` |
| `typescript` | `^7.0.2` | `^6.0.3` |

CI ran a bare `bun install`. That command accepts a stale lockfile and silently
re-resolves, so two runs of the same commit could install different toolchains.
On PR #517 this produced biome 2.5.5 and 2.5.6, which disagree on
`noUselessStringRaw` — opposite lint verdicts on byte-identical code. The
symptom looked like a flaky linter; the cause was a lockfile no updater owned.

`package-lock.json` was read by nothing in the repository. Only Dependabot
wrote it.

## Decision

**A bun stack maps to the `bun` ecosystem.** `dependabotEcosystemFromStack`
maps bun → `bun`, node → `npm`, python → `pip`. Dependabot supports the text
`bun.lock` from bun 1.1.39 and accepts both `default-days` and `semver-*-days`
cooldown keys, so existing cooldown blocks carry over unchanged.

**Every generated `bun install` is `bun install --frozen-lockfile`.** This
removes an asymmetry rather than inventing a rule: python already used
`uv sync --frozen`, node already used `npm ci`. bun was the only stack whose CI
floated.

**Every generated install is preceded by a lockfile presence gate**
(`git ls-files --error-unmatch bun.lock`). `--frozen-lockfile` forbids *changes*
to a lockfile; it does not require one to exist. With no lockfile it installs a
fresh floating resolution and still exits 0 — verified on bun 1.4.0, where a
lock-less run resolved `vitest@4.1.11` against a committed pin of `4.1.10`.
Without the gate the gate was a no-op in exactly the repos that needed it most:
freshly scaffolded ones, which have no committed lock yet.

## Consequences

### Accepted cost

> **Corrected after merge.** The first version of this section priced the cost
> using three supporting facts. Two were wrong and one was unverified. The
> decision stands — it is in fact better supported than first written, because
> the capability said to be lost was already switched off — but the reasoning
> below is the measured one, not the assumed one.

The `bun` ecosystem has **version updates but no security updates**, and
GitHub's dependency graph does not parse `bun.lock` — it appears zero times in
the supported-ecosystems table. Deleting `package-lock.json` removed the graph's
precise transitive input.

What that actually costs this repo, measured:

- `dependabot_security_updates` is **`disabled`** at the repository level, and
  was already disabled before this change. The bun ecosystem's missing security
  updates therefore surrender a capability the repo had **already switched
  off**. Corroborated by the alert ledger: `fixed: 0`, `dismissed: 0` — no
  alert has ever been auto-remediated here.
- The repo has **zero runtime dependencies** and eight dev dependencies, and is
  `private: true`. Nothing here ships to a user.
- The weekly version updater groups minor and patch across all patterns, so a
  fix for a transitive dev advisory arrives once its direct parent releases,
  which is the only route such an advisory was ever going to take.

Two claims from the first version are **withdrawn**:

- *"The capability produced two security PRs in the repo's history."* False.
  Both PRs (#409, #483) are ordinary `github-actions` version bumps of
  `trufflesecurity/trufflehog`. The match came from the word "security" inside
  the **vendor name**. The true count of Dependabot security PRs is **zero**.
- *"Dependabot alerts still fire: the dependency graph parses `package.json` as
  a manifest, so detection survives at range precision."* Unverified, and not
  supported by what is observable. All 11 open alerts carry
  `manifest_path: package-lock.json` — the deleted file — and none has been
  updated since the deletion. `GET /dependency-graph/sbom` returns 404.

So the honest residual is not "detection degraded but working". It is
**detection is currently unproven**: the visible alerts are residue from a file
that no longer exists, and whether GitHub re-derives them from `package.json`
after a re-scan has not been observed.

`bun audit` remains available and reports 28 advisories on this tree, all
transitive dev tooling (`vitest → vite → esbuild/nanoid/postcss`,
`commitlint → ajv → fast-uri`, `commitlint → cosmiconfig → js-yaml`). It is the
detection path that does not depend on GitHub parsing a lockfile it does not
support.

**Open follow-up:** re-read the alert set once GitHub has re-scanned `main`. If
the 11 stale alerts disappear without being replaced by `package.json`-attributed
ones, this repo has no platform-side detection and `bun audit` should be wired
into CI on a schedule.

**Revisit this ADR if the repo gains a runtime dependency, is published, or
stops being private.** Those are the conditions under which platform-side
detection starts mattering, and at that point a graph-supported lockfile is
worth more than bun-native lock maintenance.

### Operational

- A Dependabot PR that bumps a manifest without the lock now fails CI loudly
  instead of drifting silently. That is the intended behaviour, and it is how
  the class of bug in #518 becomes visible at all.
- The bun updater is known to skip `bun.lock` in **workspace** layouts
  (dependabot-core #11602, #14223, both still reported as of 2026). This repo
  declares no `workspaces` and its lock carries only the root entry, so it is
  the single-root case fixed by dependabot-core #12021. A downstream bun
  workspace repo adopting this ADR should verify the first Dependabot PR
  actually updates its lock.
- `.github/dependabot.yml` carries a comment stating the trade, at the line a
  future maintainer would edit to undo it.
