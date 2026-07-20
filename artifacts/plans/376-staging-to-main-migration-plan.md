# Plan — #376 migrate default branch `staging` → `main` (Model B trunk pilot)

**Issue:** #376 · **Size:** F-full · **Priority:** P1-high · **κ:** 7

Flip `roxabi-plugins` to trunk mode: `main` becomes the default branch, `staging` is deleted. Proof-of-life for Model B (#371, landed on staging as #373) — `auto-release.yml` triggers on `push: main`, so no release has ever actually fired.

Single-repo pilot. The fleet stays on staging.

**Recon:** 123-agent read-only sweep across 6 modalities (GH Actions, plugin runtime logic, skills/docs, GH platform state, org SSoT, local git). 59 surfaces confirmed, 56 refuted adversarially, 11 gaps from a completeness critic.

---

## Pre-flight

### Divergence — merge required, fast-forward impossible

```
origin/main    f2c82a72
origin/staging f7bd5043      merge-base 8a3c7eba

git rev-list --left-right --count origin/main...origin/staging  ->  4 / 183
git merge-base --is-ancestor origin/main origin/staging          ->  false (both directions)
```

`git push origin staging:main` is rejected non-fast-forward, and `allow_force_pushes=false` on main closes the force path.

Real conflicts, confirmed via `git merge-tree --write-tree origin/main origin/staging`:

| file | kind | resolution |
|---|---|---|
| `.release-please-manifest.json` | modify/delete (main → `0.4.0`, staging deleted) | **`git rm`** — git leaves main's version in the tree by default |
| `CHANGELOG.md` | content (staging `## Unreleased` vs main `## [0.4.0]`) | keep both, order `Unreleased` → `[0.4.0]` → `[0.3.0]` |
| `package-lock.json` | content (main `0.3.0→0.4.0`; staging devDep bumps) | **regenerate** via `bun install` — also clears a stale `"license": "MIT"` contradicting `package.json` `AGPL-3.0` |

`release-please.yml` and `release-please-config.json` delete cleanly.

### Tags — the reachability floor is single-threaded and fragile

- `roxabi-plugins/v0.4.0` = `7e0966e`, ancestor of **`origin/main` only**
- `roxabi-plugins/v0.3.0` = `c6ed5b1`, ancestor of **neither**
- `git tag -l 'roxabi-plugins/v*' --merged origin/staging` → **empty**
- `price.sh roxabi-plugins origin/main origin/staging` → **`0.5.0`** (rc=0)
- `price.sh --base-only roxabi-plugins origin/staging` → **rc=10** (starved)

**Main's history must be preserved.** Any reset/rename/force of main to staging's tip starves `select_base()` → `auto-release.sh:62` sets `DERIVED=0.1.0`, and since `roxabi-plugins/v0.1.0` does not exist there is **no tag collision to stop it**. It publishes a green, regressive v0.1.0 and the floor never recovers — every future bump derives off it. The D3 two-parent guard does *not* catch this: staging's tip is itself a merge commit.

### Open PRs

Exactly one repo-wide: **#349** (`base=staging`, `head=docs/release-model-unification`, mergeState `BEHIND`, both checks green, content on neither branch). Deleting its base auto-closes it — GitHub only auto-retargets on *head* deletion.

### Platform state

- `default_branch = "staging"` (REST + GraphQL + `ls-remote --symref` agree)
- Ruleset **13715174 "PR_Main"** — `include: ["~DEFAULT_BRANCH"]`, rules `[deletion, non_fast_forward, pull_request]`, `allowed_merge_methods: ["merge"]`, `required_review_thread_resolution: true`, bypass `RepositoryRole 5 / always`. **No status-check rule.** Auto-follows the default flip; no edit needed for retargeting.
- Classic protection is **name-pinned and asymmetric**: `staging` has `required_status_checks {strict:true, contexts:["ci"]}` + `allow_deletions:false`; `main` has **no `required_status_checks` key at all**. Classic protection does *not* follow `~DEFAULT_BRANCH`.
- Check-run context is literally **`ci`** (job id at `ci.yml:12`, no `name:` override) — verified empirically on staging HEAD.
- Clean / no action: no tag ruleset, no environments, no Pages, no webhooks, no deploy keys, no CODEOWNERS, `dependabot.yml` has no `target-branch`. Org creds `ROXABI_CI_APP_ID` / `ROXABI_CI_APP_PRIVATE_KEY` are visibility `all` — resolve on main unchanged.

### Expect a release to fire

The sync merge is a push to main → `auto-release.yml` cuts **`roxabi-plugins/v0.5.0`** + a public GitHub Release with 183 commits of generated notes. This is the proof-of-life, but it is irreversible and unannounced — sequence it deliberately.

### Merge shape is load-bearing

`auto-release.sh:47-51` REFUSEs any merge-to-main with `PARENT_COUNT != 2`. Squash / rebase / fast-forward / direct push → `exit 1` on the first Model-B run. A PR merge under the ruleset (`allowed_merge_methods: ["merge"]`) satisfies this.

---

## Ordered steps

1. **Retarget or land PR #349** — `gh pr edit 349 --base main`. Must precede everything: staging is still its base, and once staging is deleted GitHub auto-closes it. Re-sync after retarget (state is `BEHIND`). *Alternative: merge or close it now.*

2. **Provision the `ci` gate on main** — add a `required_status_checks` rule to ruleset 13715174 (preferred — it then follows `~DEFAULT_BRANCH` and survives future swaps), or as a fallback set classic protection on `main` to `{strict:true, contexts:["ci"]}`.
   Context string is **`ci`** lowercase — provisioning `CI` yields a check that never reports and **permanently deadlocks main**.
   Must come *before* the merge and the delete: `ci.yml:6` already triggers on PRs to main so the gate cannot deadlock, and after this point main is the release-publishing branch. Today main has zero required checks while `auto-merge.yml:3` explicitly delegates its safety to "GitHub natively waits for all required status checks" — leaving the gap open means a `reviewed`-labelled PR auto-merges with red CI and immediately publishes a tagged Release.

3. **Open the sync PR `staging` → `main`** — `gh pr create --base main --head staging`. Do **not** fast-forward, reset, rename, or force. Resolve the three conflicts per the table above.
   Verify before merging: `git ls-tree <merge-head> .github/workflows/` contains `auto-release.yml` and **not** `release-please.yml`; `.claude/stack.yml` is present.

4. **Merge the sync PR with a merge commit.** ⚠️ **IRREVERSIBLE.** This is the push to main that fires `auto-release.yml`, tags `roxabi-plugins/v0.5.0`, and publishes a public GitHub Release. Two-parent shape required (D3 guard). Review the generated notes. Confirms in one shot: release-please gone from main, Model B live, floor intact at 0.4.0 → 0.5.0.

5. **Verify the release** — `git tag -l 'roxabi-plugins/v*' --merged origin/main` shows `v0.4.0` **and** `v0.5.0`. If it shows `v0.1.0`, **stop**: main's history was destroyed. `gh api .../contents/.github/workflows/release-please.yml?ref=main` must 404.

6. **Flip the default branch to `main`** — repo setting `default_branch`. Must come *after* step 4 (flipping first leaves main running the retired release-please with no `auto-release.yml`, so a release would be cut by the old engine and masquerade as Model B working) and *before* any delete attempt (GitHub returns 422 on deleting the default branch, and the ruleset's `deletion` rule still covers staging while staging is default). This single flip auto-migrates the ruleset's `deletion` / `non_fast_forward` / `pull_request` rules from staging to main.

7. **Delete the classic branch-protection rule on pattern `staging`** — `DELETE /repos/Roxabi/roxabi-plugins/branches/staging/protection`. Name-pinned, so it survives the flip and holds `allow_deletions:false`. Second of staging's two deletion blocks (the ruleset was the first, cleared by step 6).

8. **Delete the remote branch** — `git push --delete origin staging`. ⚠️ **IRREVERSIBLE** (recoverable only by re-pushing `f7bd5043` from a local clone while one still holds it).

9. **Land the repo code changes** (table below) as a normal PR to main. Ships `check-skill-version.sh` + its test fixtures in lockstep — non-negotiable, they fail CI if split.

10. **Local clone hygiene (every machine — M₁ and M₂).** Not optional, none of it self-heals:
    - `git checkout main` (DWIM creates it from `origin/main`), then `git branch -D staging` and `git config --unset branch.staging.remote; git config --unset branch.staging.merge`. Otherwise a stray `git push` from a staging checkout **recreates `refs/heads/staging` on origin unopposed** — the ruleset has no `creation` rule.
    - `git remote set-head origin -a` — `fetch --prune` does *not* fix `origin/HEAD`; leaving it dangling makes bare `git log origin` / `git rev-parse origin` fail with `fatal: ambiguous argument 'origin'`.
    - `git fetch --prune` — a stale `refs/remotes/origin/staging` makes `detect_base_branch` keep returning `staging` and makes `check-skill-version.sh` diff against a frozen snapshot with no SKIP warning.

11. **Re-add the marketplace clone** — `claude plugin marketplace remove roxabi-marketplace && claude plugin marketplace add Roxabi/roxabi-plugins`. `~/.claude/plugins/marketplaces/roxabi-marketplace/.git/config:10` is a **single-branch clone pinned to `+refs/heads/staging:refs/remotes/origin/staging`** — after deletion `git fetch` resolves nothing and every plugin (dev-core, dev-init, compress, …) freezes at its last staging fetch, silently. Its HEAD is currently parked on a stale feature branch. Same pin at `roxabi-marketplace.bak/.git/config:10`.

12. **Update org SSoT** (separate repo `Roxabi/projects-meta`, separate commit) — `~/projects/ssot/conventions.ssot.md:12`. Split roxabi-plugins out of the staging list into a trunk clause. This file is `@`-imported by `~/projects/CLAUDE.md`, so until it lands every agent session is instructed to run `gh pr create --base staging` against a branch that no longer exists.

---

## Repo code changes

| file:line | current | → new |
|---|---|---|
| `.github/workflows/ci.yml:4` | `branches: [main, staging]` | `branches: [main]` |
| `.github/workflows/ci.yml:6` | `branches: [main, staging]` | `branches: [main]` |
| `.github/workflows/auto-merge.yml:22` | `branches: [staging, main]` | `branches: [main]` |
| `.github/workflows/context-lint.yml:12` | `branches: [main, staging]` | `branches: [main]` |
| `.github/workflows/pr-title.yml:6` | `branches: [main, staging]` | `branches: [main]` |
| `.github/workflows/auto-merge.yml:5-7` | "Squash merges flatten the per-commit history that staging→main promotions rely on." | merge commits required: `auto-release.sh` demands a 2-parent merge (D3) and `price.sh` walks per-commit history for the bump map |
| `scripts/check-skill-version.sh:8` | `git fetch origin staging --quiet …` | `git fetch origin main --quiet …` |
| `scripts/check-skill-version.sh:9` | `… --verify --quiet origin/staging …` | `… --verify --quiet origin/main …` |
| `scripts/check-skill-version.sh:10` | `SKIP: … (origin/staging unreachable …)` | `… (origin/main unreachable …)` |
| `scripts/check-skill-version.sh:13` | `git diff --name-only origin/staging...HEAD …` | `… origin/main...HEAD …` |
| `scripts/check-skill-version.sh:22` | `git show "origin/staging:$pj"` | `git show "origin/main:$pj"` |
| `scripts/check-skill-version.sh:5-6` | staging in comments | main |
| `scripts/__tests__/check-gates.test.ts:150` | `git('git push -q origin HEAD:staging', work)` | `HEAD:main` |
| `scripts/__tests__/check-gates.test.ts:252` | `expect(stderr).toMatch(/origin\/staging unreachable/)` | `/origin\/main unreachable/` |
| `scripts/__tests__/check-gates.test.ts:131,147,155,156,214,215,234,235` | staging in titles/comments | main |
| `scripts/provision-release-gate.sh:43` | `DEFAULT_REF="staging"` | `DEFAULT_REF="roxabi-plugins/vX.Y.Z"` (tag — safer than `main`; the script's own comment recommends it) |
| `scripts/provision-release-gate.sh:50` | usage text `default: staging` | matching new default |
| `CONTRIBUTING.md:6` | `feature/fix branch → PR → staging → (promote) → main` | `feature/fix branch → PR → main → auto-release cuts roxabi-plugins/vX.Y.Z` |
| `CONTRIBUTING.md:9` | ``Create a branch from `staging` `` | ``… from `main` `` |
| `CONTRIBUTING.md:10` | ``Open a PR targeting `staging` `` | ``… targeting `main` `` |
| `CHANGELOG.md:5` | "Entries are generated automatically by /promote and committed to staging before the promotion PR." | GitHub Releases cut by `auto-release.yml` are the source of truth (or declare the file historical) |
| `docs/CREATE-PLUGIN-GUIDE.md:92` | ``on push to `main`/`staging` `` | ``on push to `main` `` |
| `plugins/dev-core/README.md:28` | ``When new versions land on `staging`/`main` `` | ``… on `main` `` |
| `plugins/dev-core/README.md:97` | `\| promote \| Ship \| Promotes to staging/production \|` | reword for trunk |

**Do not touch:**
- `.github/workflows/auto-release.yml` — byte-gated by `/checkup` N11, already `branches: [main]`
- `plugins/dev-core/skills/promote/SKILL.md:64` — pinned by `release-model-docs.test.ts:25`; it *becomes* the operative row post-migration

**`CONTRIBUTING.md` caution:** lines 113/121/144 use "promote" in the unrelated sense of promoting a wrapped plugin to the curated marketplace. Do not blanket-replace.

---

## Fleet vs repo-local

**roxabi-plugins-only (safe):** all workflow branch filters, `scripts/*`, `scripts/__tests__/*`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/CREATE-PLUGIN-GUIDE.md`, all platform settings, all local clone hygiene.

**Shared dev-core / dev-init — ships to `roxabi-factory` + `roxabi-live`, both still `default_branch: staging`. DO NOT change as part of this migration:**

| surface | why not |
|---|---|
| `shared/adapters/github-infra.ts:50` `PROTECTED_BRANCHES = ['main','staging']` | narrowing to `['main']` stops `/checkup` verifying and `/init` applying staging protection **on factory + live** — a security regression exported to other repos, to suppress one cosmetic skip line here. Correct fix is model-aware resolution, a dev-core feature. |
| `shared/lib.sh:16` `for b in staging main master` | designed fallthrough; returns `main` automatically once `origin/staging` is pruned. Removing `staging` breaks base detection in factory/live. |
| `shared/workflows/workflow-generators.ts:37,248,306,416,418` + `workflows-fleet.ts:18,20` | generator output for staging-train consumers. Also pinned by `workflows.test.ts:141`/`:139` (`expect(yml).toContain('branches: [main, staging]')`) — editing turns a cosmetic `/checkup` warn into a red build. |
| `skills/cleanup/analyze-branches.sh:75,314` + `cleanup/SKILL.md:298` | protected-name allowlist; removing `staging` makes `/cleanup` treat staging as deletable in factory/live. |
| `shared/references/release-convention.md:5,17,18` | still true for staging-train consumers. Needs a **trunk carve-out**, not a rewrite. Line 18 ("never merge feature branches directly into `main`") is the sharpest contradiction — `/code-review` could flag the very merge that constitutes the release. |
| `promote/preflight.sh:49-51`, `promote/references/release-artifacts.md:72,155` | guarded by the `trunk_mode` early-exit; correct for the default model; asserted by `preflight.test.ts`. |
| `dev/SKILL.md:95,173,334,335,372` | stale prose; the executed path is `${BASE}`-resolved. Fix should be base-agnostic phrasing, **not** hardcoding `main`. |

**Regression flag:** any edit that removes `staging` from a shared dev-core constant, generator, or allowlist pushes `roxabi-factory` and `roxabi-live` off staging before they are ready. That is a fleet regression, not part of this migration.

**Fleet eligibility, measured 2026-07-20:**

| | `roxabi-factory` | `roxabi-live` | `roxabi-plugins` |
|---|---|---|---|
| `auto-release.yml` | absent | absent | present (#371) |
| `release:` ∈ stack.yml | absent (file gitignored) | absent (idem) | `model: trunk` |
| main…staging | diverged, staging +3934 / −33 | diverged, +6 / −1 | diverged, +183 / −4 |
| criticality | **prod M₁** — Quadlet, `make converge` | CF Worker + D1 | — |

Flipping their default now removes the staging train **without** granting trunk mode: neither `/promote` nor auto-release. Each needs its own recon + a resolution for distributing `release.model` (their `.claude/stack.yml` is gitignored).

---

## Risks & rollback

| failure | trigger | consequence | reversal |
|---|---|---|---|
| **Regressive v0.1.0** | main reset/renamed/force-moved to staging instead of merged | `v0.4.0` leaves ancestry → `select_base` rc=10 → `DERIVED=0.1.0`; **no tag collision stops it**, publishes green. Floor never self-heals. D3 guard does not catch it (staging's tip is itself a merge). | Delete tag + Release, restore main to `f2c82a72`, redo as a merge. Painful — prevent, don't cure. |
| **Wrong release engine** | default flipped before step 4 | `release-please.yml` (live on main today, last successful run 2026-07-02) cuts the release; `auto-release.yml` absent. Looks like Model B working. | Close the release-please PR, land the merge, re-run. |
| **183 commits lost** | staging deleted before step 4 | Entire Model B implementation orphaned. | Re-push `f7bd5043` from any unpruned local clone. |
| **CI gate silently gone** | step 2 skipped | Red PRs merge to main → auto-merge fires (delegating to required checks that no longer exist) → tagged public Release from unverified code. Silent. | One API call to add the rule. |
| **Main permanently unmergeable** | required context provisioned as `CI` instead of `ci` | Check never reports; every PR blocks. | Correct the context string. |
| **First release REFUSEs** | sync merge landed as squash/rebase/ff | `auto-release.sh:47-51` exit 1 — loud red, no bad artifact. | Redo as a 2-parent merge. |
| **Staging resurrected** | stray `git push` from a local staging checkout, or `/checkup protect-branches` (see below) | Branch reappears; ruleset has no `creation` rule to stop it. | `git push --delete origin staging` again, then step 10. |
| **Marketplace frozen** | step 11 skipped | All plugins stop updating. Fails quietly. | Remove + re-add marketplace. |
| **Version gate dies silently** | script repointed but fixtures not, or neither | Split → 3 tests fail (loud, caught by CI). Neither → gate diffs against a stale unpruned ref or SKIPs to exit 0 — enforcement stops with no red. | Land script + fixtures in one commit. |
| **Downstream repo deadlock** | `provision-release-gate.sh` run post-deletion with `DEFAULT_REF="staging"` | Commits a stub pinned `@staging` **and** arms a required check with zero bypass actors in the same run → that repo's main deadlocks. Latent today (verified: zero stubs provisioned org-wide). | Fix line 43 first; recover by deleting the `release-consistency-gate` ruleset. |

**Irreversible:** step 4 (tag + public Release), step 8 (branch deletion). Step 6 is reversible but re-breaks everything downstream while wrong.

---

## Known latent hazard — tracked separately

`plugins/dev-init/skills/init/lib/protection.ts:27-34` runs `git branch staging` + `git push -u origin staging` when the branch is absent, so a `/checkup` `protect-branches` remediation would **resurrect staging** after this migration. Correct fix is skip-if-absent gated on `release.model` (precedent: `doctor-github.ts:152-158` emits `status:'skip'`). Must **not** be fixed by narrowing `PROTECTED_BRANCHES` — that ships to factory + live and drops their staging protection.

Until fixed: **do not run `protect-branches` on this repo.**

---

## Out of scope

- **#374, #375** — deferred fleet hardening from the #373 review.
- **Fleet migration** — roxabi-factory, roxabi-live, roxabi-site, roxabi-intel, roxabi-idna, roxabi-1page stay on staging.
- **Shared dev-core constants / generators / allowlists** — the "do not change" table above.
- **Making `PROTECTED_BRANCHES` / branch filters / `release-convention.md` release-model-aware** — real dev-core features, separately scoped.
- **Org meta-repo doc sweep** — `~/projects/docs/release-convention.md:23,44`, `git-check.sh:50,54`, `security/baseline/check.sh:289-290` (asserts protection *existence*, not *strength* — would certify the post-migration state as compliant), `HANDOFF-*.md`. Cosmetic drift in `Roxabi/projects-meta`. Only `conventions.ssot.md:12` (step 12) is required, because it is `@`-imported into live agent context.
- **Repo hygiene newly unblocked, not required** — `delete_branch_on_merge=false` (safe to flip only *after* staging is gone), 11 merged-but-undeleted feature branches, stale `release-please--branches--main--components--roxabi-plugins` ref at `e16b0a8`.
- **`release-consistency.yml` staging references** (`:13`, `:56`, `:136-139`) — doubly dead: no caller stub exists in this repo, and the trunk early-green at `:128-131` returns before `:136`. Dead-code cleanup.

**Verified clean, no action:** `dependabot.yml`, CODEOWNERS (absent), issue/PR templates, `FUNDING.yml`, `biome.json`, `tsconfig.json`, `vitest.config.ts`, `commitlint.config.js`, `.gitattributes`, `Makefile`, `deploy-preview.yml`, `upstream-watch.yml`, `marketplace.json` / `plugin.json` version surfaces, org secrets/variables, environments (0), Pages (404), webhooks (none), deploy keys (none), tag rulesets (none), `docs/architecture/adr/` (zero staging hits), `plugins/compress/` goldens.
