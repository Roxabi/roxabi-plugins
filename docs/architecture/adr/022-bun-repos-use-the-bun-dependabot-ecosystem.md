---
title: "ADR-022: A bun repo uses the bun Dependabot ecosystem, and pays for it"
description: >
  A repo that installs with bun declares `package-ecosystem: bun`, not `npm`.
  The npm updater never writes `bun.lock`, so it bumped manifests and left the
  lockfile behind, and a bare `bun install` then re-resolved the floating range
  on every CI run. The price is explicit: the bun ecosystem has no Dependabot
  security updates and GitHub's dependency graph does not parse `bun.lock`.
  Resolves #518.
status: accepted
normative: true
date: 2026-09-22
---

> Resolves Roxabi/roxabi-plugins#518.
>
> Applies to every repo the workflow generator scaffolds with `stack: bun`.
>
> **Amended 2026-09-30 by #645** — the open follow-up in § Accepted cost is
> resolved: this repo has no platform-side detection. GitHub's dependency graph
> lists no manifest for it at all — not `package.json`, not even the workflow
> files (cli/cli, as a control, lists 19) — so neither npm nor GitHub Actions
> dependencies get alerts, and `bun.lock` is not established as the cause
> (#648). `bun audit` now runs weekly here (`.github/workflows/dependency-audit.yml`,
> `scripts/dependency-audit.ts`) and files a `security` issue; it covers npm
> packages only. This covers **this repo only**. Generated bun repos get no
> `bun audit` until #646; whether they get platform detection was not
> established here — a same-org bun repo, roxabi-circle, lists 28 graph manifests
> and has an alert attributed to `package.json`.

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
  off**. Corroborated by the alert ledger as of 2026-09-22: `fixed: 0`,
  `dismissed: 0` — no alert had ever been auto-remediated here. (The 11
  residual alerts were dismissed by hand on 2026-09-30, see the outcome below.)
- The repo has **zero runtime dependencies** and eight dev dependencies, and is
  `private: true`. Nothing here ships to a user.
- The weekly version updater groups minor and patch updates across all patterns,
  but it does not guarantee a refresh of an in-range transitive. #812's initial
  commit `d807ede7`, before its rebase onto #824, bumped `vitest` from 5.0.2 to
  5.0.3 and retained `postcss` 8.5.23 and `source-map-js` 1.2.1 in `bun.lock`;
  the patched `source-map-js` 1.2.2 was already in `postcss`'s `^1.2.1` range.
  The rebased version that merged (vitest 5.0.4) carried 1.2.2, from #824's
  lock. This does not establish that the bun updater never updates
  transitives, only that an in-range patched transitive can remain locked and
  needs the audit path below.

Two claims from the first version are **withdrawn**:

- *"The capability produced two security PRs in the repo's history."* False.
  Both PRs (#409, #483) are ordinary `github-actions` version bumps of
  `trufflesecurity/trufflehog`. The match came from the word "security" inside
  the **vendor name**. The true count of Dependabot security PRs is **zero**.
- *"Dependabot alerts still fire: the dependency graph parses `package.json` as
  a manifest, so detection survives at range precision."* Unverified, and not
  supported by what was observable on 2026-09-22: all 11 then-open alerts
  carried `manifest_path: package-lock.json` — the deleted file — and none had
  been updated since the deletion. `GET /dependency-graph/sbom` returned 404.

So the honest residual, as written on 2026-09-22, was not "detection degraded
but working". It was **detection unproven**: the visible alerts were residue from
a file that no longer existed, and whether GitHub would re-derive them from
`package.json` after a re-scan had not been observed. **Resolved 2026-09-30
(#645):** observed — there is no platform-side detection; see the outcome below.

`bun audit` remains available. It reported 28 advisories on this tree when this
ADR was written (1 low after #644), all transitive dev tooling
(`vitest → vite → esbuild/nanoid/postcss`, `commitlint → ajv → fast-uri`,
`commitlint → cosmiconfig → js-yaml`). It is the detection path that does not
depend on GitHub parsing a lockfile it does not support.

**Transitive advisory remediation.**

When the scheduled audit reports a finding, first inspect `IGNORED` in
`scripts/dependency-audit.ts`. Keep only advisories still accepted at their
current severity; a re-rated or stale entry is action required, not an
`--ignore` candidate. The audit report's `Fix:` line prints
`bun audit fix --ignore=<bun id>…`, one `--ignore` per accepted advisory that
can be spared by its numeric advisory id; the same command with `--latest` is
the one that crosses majors. bun's rule is that `--ignore=<v>` spares an
advisory when its id text equals `v` **or its URL contains `v`**, for every
advisory of every package, in `bun audit` and `bun audit fix` alike
(`keep_vulnerability` and `parse_vulnerability` in
`src/runtime/cli/audit_command.rs`, read at tags `bun-v1.4.0` and
`bun-v1.4.3`; a string id is kept verbatim, a number becomes its `u64`
text). The script computes the command against that rule: it prints a flag
only for a positive safe-integer id that spares no advisory it does not accept,
and never a GHSA flag, which would spare every package sharing the GHSA and any
URL holding it. An accepted advisory that gets no flag (no such id, or its id
would also spare a finding) is listed beside the `Fix:` line with the reason;
for it, check the command's effect with `bun audit fix --dry-run` and restore
that package's entry in `bun.lock` by hand if it moves. Copy the command in a
worktree rather than running a bare `bun audit fix`. Inspect the manifest and
lock delta; when the manifest is unchanged, open a lock-only PR if appropriate.
Dispatch `dependency-audit.yml` on that branch and retain its report/run as the
remediation evidence. #788 was the scheduled finding; #824 updated the locked
`source-map-js` with `bun audit fix` while preserving the accepted esbuild
advisory. It did not copy the report's command: the report #788 carried printed a
bare `bun audit fix`, which would also have retired that accepted advisory, and
#824's author composed `--ignore=GHSA-g7r4-m6w7-qqqr` by hand. The report's
id-based command is the correction of that gap.

**Open follow-up (resolved 2026-09-30, #645):** the alert set was to be re-read
once GitHub had re-scanned `main`. If the 11 stale alerts disappeared without
being replaced by `package.json`-attributed ones, this repo had no platform-side
detection and `bun audit` was to be wired into CI on a schedule.

Outcome, observed 2026-09-30: after eight days the 11 alerts still carried
`manifest_path: package-lock.json`, none had been updated since 2026-09-13, and
no alert attributed to `package.json` or `bun.lock` appeared. The condition
above assumed the graph re-scans; it did not. `dependencyGraphManifests` returns
**0** for this repo — the workflow files included, which the graph parses in any
repo (cli/cli: 19) — with vulnerability alerts enabled and
`GET /dependency-graph/sbom` at 404. The graph is therefore not processing this
repo at all: "`bun.lock` is unsupported" does not explain an empty inventory,
GitHub Actions dependencies are undetected too, and returning to a lockfile the
graph parses is not a proven remedy (#648). The 11 were dismissed as
`inaccurate` once #644 moved every flagged package past its vulnerable range.
`bun audit` now runs weekly in this repo and files a `security` issue on a
finding, a stale ignore or an unaudited package; it covers npm packages only.
Generated bun repos are not covered: #646.

The audit's policy, settled on #645 and to be carried by #646:

- **Every severity counts.** `--audit-level=moderate` was rejected: it would hide
  every future low permanently to cover one temporary gap.
- **Accepted advisories are explicit.** `IGNORED` in `scripts/dependency-audit.ts`
  records each entry's reason, severity and removal condition. An entry whose
  advisory has left the tree, or whose severity changed, is reported, not kept.
- **Scheduled, never a PR check.** A new advisory against an unchanged lockfile
  must not turn unrelated PRs red.
- **Only a lock that matches the manifest is audited.** `bun audit` reads
  `bun.lock` alone, so a dependency missing from it would never be audited. The
  run first checks, without installing or running scripts, that `bun.lock`
  matches `package.json` (`bun install --frozen-lockfile --lockfile-only
  --ignore-scripts`); a mismatch is routed as an audit that cannot be trusted.
- **Action required files or updates one `security` issue and fails the run**:
  a finding, a stale ignore, or a package bun could not audit. Partial coverage
  counts as action required on purpose — read as clean, it is a false clean. An
  audit that cannot be trusted (a lock that disagrees with `package.json`, or no
  parseable result consistent with bun's exit code), or that did not finish,
  never files a security issue; it files one non-security "audit failed" issue,
  and so does a run whose security issue could not be written. The next run that
  delivers its result (clean, or filed) closes it; a failing run stays red. Still
  silent: a scheduled run GitHub drops or disables, a run whose last step cannot
  write to GitHub, and a registry that answers `{}` for packages it never audited.
  The exit codes are in `scripts/dependency-audit.ts`.
- The issues are public, like the repo. That is acceptable while every dependency
  is dev-only; revisit together with the runtime-dependency trigger below.

**Revisit this ADR if the repo gains a runtime dependency, or its package.json
loses `private: true` (is published to npm).** "Private" here means the npm
package, not the GitHub repo, which is public. Those are the conditions under
which platform-side detection starts mattering; whether a graph-supported
lockfile would then restore it depends on #648.

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
