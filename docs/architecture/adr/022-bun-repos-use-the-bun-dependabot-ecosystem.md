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

The `bun` ecosystem has **version updates but no security updates**, and
GitHub's dependency graph does not parse `bun.lock` — it appears zero times in
the supported-ecosystems table. Deleting `package-lock.json` therefore removed
the graph's precise transitive input. This is a real reduction and is accepted
deliberately, on this evidence:

- The repo has **zero runtime dependencies** and eight dev dependencies, and is
  `private: true`. Nothing here ships to a user.
- Dependabot **alerts** still fire: the dependency graph parses `package.json`
  as a manifest, so detection survives at range precision. Only the automated
  security-fix PR is lost.
- The capability produced **two** security PRs in the repo's history, while
  `bun audit` reports **28 open advisories today** — all transitive dev tooling
  (`vitest → vite → esbuild/nanoid/postcss`, `commitlint → ajv → fast-uri`,
  `commitlint → cosmiconfig → js-yaml`) — *with* the npm ecosystem and security
  updates enabled. The capability was not keeping this tree clean.
- The weekly version updater groups minor and patch across all patterns, so
  fixes for these arrive anyway once the direct parent releases, which is the
  only route a transitive dev advisory was ever going to take.

**Revisit this ADR if the repo gains a runtime dependency, is published, or
stops being private.** Those are the conditions under which the lost capability
starts mattering, and at that point a graph-supported lockfile is worth more
than bun-native lock maintenance.

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
