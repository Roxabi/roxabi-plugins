---
title: "ADR-021: A release is an explicit act — trunk stops tagging on merge"
description: >
  roxabi-plugins stops cutting a release on every merge. `release.model: trunk`
  keeps meaning branch flow only; the automatic tagger (auto-release.sh, its
  generator, N11) is removed. Tags are annotated, hand-pushed, and verified by a
  repo-local release.yml. price.sh and finalize.ts stay — the staging-train fleet
  uses them. Resolves #500 by removing the deriver from the path, not by
  amending D18.
status: accepted
normative: true
date: 2026-09-21
---

> Resolves Roxabi/roxabi-plugins#500.
>
> Narrows **#371 / Model B**: the trunk *branch* model survives; the trunk *tagger*
> does not. Leaves the spec-S2 deriver (D1–D18) in force for staging-train.

## Context

Issue #500 reports that every merge to `main` cuts a release, because
`price.sh:123` defaults every conventional type to a patch bump and only an
*empty* payload reaches the green no-op in `auto-release.sh:91`. PR #498 was
documentation only and cut `roxabi-plugins/v5.0.1`.

The report is accurate, and the bump map is the wrong place to fix it. Five
measurements taken 2026-09-21 move the decision:

**1. The noise is granularity, not classification.** Of 87 releases, **19** carry
only `docs`/`chore`/`ci`/`style`/`test`/`build`, and the median payload is **1
commit**. A non-bumping type set removes the 19 and leaves ~68 single-commit
releases. Every other repo in both fleets releases in batches:

| repo | mechanism | releases | median payload | non-functional-only |
|---|---|---|---|---|
| semctx (`hoklims`) | annotated tag pushed by hand | 13 | 16 | 0 |
| spark | `/R-promote` (staging-train) | 13 | 6 | 0 |
| metalyde | `/R-promote` (staging-train) | 7 | 14 | 0 |
| silex-plugins | manifest version + CI gate | 9 | 3 | 0 |
| **roxabi-plugins** | **auto-release on every merge** | **87** | **1** | **19** |

**2. The type alone does not carry the signal.** Of those 19, five touched files
under `plugins/` — `v4.0.5` is a `docs:` commit rewriting
`issue-triage/skills/issue-triage/SKILL.md`, i.e. the product body; `v2.9.3` is a
`ci:` commit touching five shipped files. A type-only filter suppresses releases
that did change the shipped surface.

**3. The tag is not the delivery channel.** No plugin declares a `version` —
neither in `plugins/*/.claude-plugin/plugin.json` (12 manifests, all absent) nor
in the marketplace entries. By the resolution order recorded in `AGENTS.md`
(`plugin.json.version` > marketplace `version` > git commit SHA), the whole repo
ships **SHA-based**: a consumer receives a skill edit because it is on `main`,
not because a tag was cut. `main` *is* the channel; the tag is narration. This
is what makes measurement 2 non-blocking — the five consumer-visible commits
reach consumers with or without a tag.

**4. The tags have one referent, and it is frozen.**
`scripts/provision-release-gate.sh:43` pins the reusable release-consistency
workflow at `roxabi-plugins/v4.1.0`. An org-wide code search finds **zero** repos
carrying the caller stub: the gate was never provisioned. The default pin has
stayed at `v4.1.0` while 46 further tags were cut automatically — the cadence is
consumed by nobody, while the *format* and *immutability* of a tag are load-bearing
for the pin the day it is provisioned.

**5. The documentation already describes the decision the code does not
implement.** `promote/SKILL.md:383` claims "a merge that adds no version-bumping
conventional commit derives `== BASE` and exits green without tagging (D18). Only
a bumping payload cuts a release, so most merges are no-ops." No non-bumping type
exists, so the sentence is vacuous and "most merges are no-ops" is false — 78% of
merges cut a release. `release-model-docs.test.ts:28-30` pins only `/every merge/i`
and the literal `D18`, so it never saw the drift.

A sixth fact constrains any fix that touches the deriver: `price.sh` is the sole
deriver for **both** models. On trunk, `derived == base` short-circuits green
(`auto-release.sh:91`); on staging-train the same equality reaches
`finalize.ts:119` and returns **refuse**. Adding a non-bumping type set therefore
turns a documentation-only `/R-promote` into a hard red on spark, metalyde,
factory and intel — a fleet regression paid for a roxabi-plugins-only symptom.

## Options Considered

### Option A: Reaffirm D18 — every type bumps

- **Pros:** zero code change; version numbers are free; the release list stays a
  complete log of every merge.
- **Cons:** keeps 87 releases where 19 mean nothing and the median is one commit.
  A reader cannot tell which release changed behaviour, which is the only
  question a release list exists to answer. Requires rewriting `SKILL.md:383`
  anyway, since the doc currently promises the opposite.

### Option B: Port release-please's filter into `price.sh`

`filterCommits` drops `chore`/`docs`/`style`/`refactor`/`test`/`build`/`ci`
unless the commit carries a `BREAKING CHANGE` note, then the existing map runs on
the survivors. Our `price.sh:117-134` is already that second stage verbatim, and
the breaking-footer escape at `:126` already implements the exception.

- **Pros:** ~5 lines; the industry default; already the de facto behaviour of the
  three release-please repos; closes every acceptance criterion in #500.
- **Cons:** ~68 single-commit releases remain — it treats the symptom. Requires
  splitting *empty* from *non-releasable* in `finalize.ts` or the staging-train
  fleet regresses to a hard refuse. Keeps 528 lines of deriver plus 1 202 lines
  of tests and an 18-decision spec alive to serve an artifact with no consumer.

### Option C: Manifest canon (silex-plugins)

Version lives in a manifest, bumped by the author in the PR; CI refuses a PR
whose version has no matching `## [X.Y.Z]` CHANGELOG section; a push to `main`
tags iff that version has no tag yet (`release-plugin.sh`, 85 lines).

- **Pros:** "nothing to release" becomes structural — no bump, tag already exists,
  silent no-op. The version is an intention, so concurrent PRs collide loudly on
  one line instead of racing a derived number. The CHANGELOG *is* the release
  notes.
- **Cons:** buys a versioned channel we do not have. While `main` is the delivery
  channel, the manifest number means nothing to a consumer, so the bump discipline
  and the CHANGELOG gate are ceremony around an unused value. Measured failure
  mode: silex-forge has the manifest canon without the release job and has drifted
  to `marketplace.json` 1.19.2 against a newest tag of `v1.8.1`.

### Option D: Tag-triggered, hand-pushed (semctx) — chosen

`on: push: tags:`. The release act is `git tag -a`. Nothing is derived, so there
is no map, no filter, no empty-payload path and no reachability floor. semctx's
`verify` job reduces the entire control surface to five assertions: the tag
matches the declared version, the tag object is annotated, it points at the
release SHA, that SHA is an ancestor of `main`, and reviewed notes exist.

- **Pros:** #500 stops being a question — there is no bump map on the path. Net
  deletion of the largest unconsumed machinery in the repo. Serves the one real
  referent (the release-gate pin) better than automation does: a deliberate tag is
  a better pin target than the 87th. Honest about the measured state — `main` is
  the channel, so the tag is documentation and is created when documentation is
  wanted.
- **Cons:** a release now requires someone to remember. Nothing enforces that a
  meaningful change gets a tag, where the current system guaranteed a tag existed
  for every merge (at the cost of 19 meaningless ones). Removing the generated
  workflow means removing the `/R-dev-checkup` N11 guard that kept it honest, so
  drift in the replacement workflow is caught by nothing but review.

## Decision

Adopt **Option D**, scoped narrowly.

1. **`release.model: trunk` keeps exactly one meaning: branch flow.** No staging
   branch, `feature → main`, `triggerBranches() → [main]`, `/R-promote` refuses
   `--finalize`, the release-consistency gate early-greens, N10 still refuses a
   stray `release-please.yml`. The key conflated branch flow with a release
   trigger; this ADR keeps the first and removes the second.

2. **The automatic tagger is removed.** `auto-release.sh`, its three suites,
   `generateAutoReleaseYml`, the N18 emission in `writeWorkflows`/`pushWorkflows`,
   the #375 trunk resolvability guard, the N11 drift check, and the committed
   `.github/workflows/auto-release.yml` all go. A trunk repo no longer generates
   any release workflow.

3. **Tags are annotated and pushed by hand,** keeping the
   `<component>/vX.Y.Z` format and immutability that
   `scripts/provision-release-gate.sh` pins against:
   `git tag -a roxabi-plugins/vX.Y.Z -m "…" && git push origin roxabi-plugins/vX.Y.Z`.

4. **`.github/workflows/release.yml` is repo-local, hand-written and
   verify-only.** On `push: tags: roxabi-plugins/v*`: the tag object is annotated,
   `rev-list -n1 $TAG == $GITHUB_SHA`, `merge-base --is-ancestor $GITHUB_SHA
   origin/main`, then `gh release create --verify-tag --generate-notes`. It is not
   generated by `/R-ci-setup` and not gated by `/R-dev-checkup` — a generator and a
   drift check for a single 25-line file in a single repo is the machinery this ADR
   is removing.

5. **`price.sh` and `lib/finalize.ts` are untouched.** They are the staging-train
   deriver for spark, metalyde, factory and intel, reached through `/R-promote`.
   D1–D18 stay in force there. roxabi-plugins simply stops calling them: the bump
   map is not amended, it is removed from the path. **#500 is resolved by
   subtraction.**

6. **`SKILL.md`'s trunk section is rewritten, not patched.** The four trunk
   bullets describe a tagger that no longer exists. The merge-commit requirement
   (D3) goes with it — nothing derives from `M^1..M` any more. The `--finalize`
   refusal under trunk stays, with its rationale restated: `/R-promote` is the
   staging-train tagger, and a trunk repo has no promotion to finalize.
   `release-model-docs.test.ts` loses its `D18`/`every merge` sentinels rather than
   being re-pinned to new wording — a test that pins prose it does not defend is
   deleted, per the repo's own test bar.

7. **The fleet roster records the split.** `~/projects/docs/release-convention.md`
   gains a third row: trunk-manual (roxabi-plugins), distinct from trunk-auto
   (silex-plugins, whose `ci.yml` `release` job stays) and staging-train.

## Consequences

### Positive

- ~1 000 lines deleted against ~25 added, and an 18-decision spec surface loses
  its only trunk consumer.
- The release list becomes readable: a tag exists because someone decided a state
  was worth naming.
- The staging-train fleet is untouched, so the `derived == base` → refuse
  asymmetry never has to be reconciled.
- The release-gate pin gains a better target: a deliberate tag rather than the
  next automatic one.

### Negative

- Nothing guarantees a release gets cut. A behaviour change can sit on `main`
  untagged indefinitely; the only signal is a human noticing. This is the
  guarantee the automation bought, and it is being given up knowingly.
- `release.yml` is ungoverned: no generator, no N11 byte gate. A hand-edit that
  breaks it surfaces at the next tag push, not at `/R-dev-checkup`.
- `release.model` becomes a two-valued key where one value now carries less than
  it did. A reader of `stack.yml` must consult this ADR to know that `trunk` no
  longer implies a tagger.

### Neutral

- The CHANGELOG stays a single unversioned pile (`docs/release-convention.md`
  §Changelog); `--generate-notes` still produces the release body, and its window
  widening across untagged merges is benign — those PRs fold into the next
  release's notes rather than being dropped.
- Existing tags `roxabi-plugins/v0.1.0 … v5.0.2` are preserved as-is. The
  sequence continues from `v5.0.2` by hand.

### Named residuals

- **Commit hygiene becomes the only classifier.** With no bump map on the path,
  whether a change is consumer-visible is answered by the person choosing the
  version at tag time. The five `docs:`/`ci:` commits that rewrote shipped files
  (measurement 2) were mislabelled; that is a commit-message problem, and this ADR
  does not add a control for it.
- **If a versioned channel ever appears** — declared `version` in the plugin
  manifests plus a `stable` branch, as semctx separates `main` from its channels —
  Option C's witness gate becomes worth its ceremony and should be revisited. This
  ADR does not open that door.

## Refuse list

- Do not add a non-bumping type set to `price.sh`. The staging-train fleet reaches
  `finalize.ts:119` on the same equality and would refuse, not no-op.
- Do not add a third `release.model` value for the tag trigger. One repo, one
  25-line workflow, no mode.
- Do not generate `release.yml` from `/R-ci-setup` or byte-gate it in
  `/R-dev-checkup`.
- Do not move or delete an existing tag; `provision-release-gate.sh` pins one.
- Do not re-pin `release-model-docs.test.ts` to the new prose — delete the
  sentinels for the bullets that no longer exist.
- Do not reintroduce a merge-commit requirement for releases; nothing derives from
  `M^1..M` under trunk any more.

## References

- Issue #500 · surfaced by #488 · context in #498 (the documentation-only PR that
  cut `v5.0.1`)
- ADR-010 (pipeline chain contract) · #371 (Model B, trunk) · #375 (trunk script
  resolvability) · #376 (staging→main migration)
- `plugins/dev-core/skills/promote/price.sh:117-134` (the bump map, kept for
  staging-train) · `lib/finalize.ts:119-125` (the refuse this ADR avoids
  triggering)
- `scripts/provision-release-gate.sh` (`resolve_pin`, the one real tag referent —
  the newest `roxabi-plugins/v*` tag, resolved at provision time rather than
  hardcoded, since trunk cuts a new one on every merge; #385 item 5)
- `~/projects/docs/release-convention.md` (fleet roster)
- Prior art: `googleapis/release-please` `src/util/filter-commits.ts`
  (`DEFAULT_CHANGELOG_SECTIONS`) · `hoklims/semctx` `.github/workflows/release.yml`
  (`verify` job) + `docs/publishing.md` ("`main` is not a channel") ·
  `go-silex/silex-plugins` `scripts/release-plugin.sh`
