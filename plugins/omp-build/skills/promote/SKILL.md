---
name: promote
disable-model-invocation: true
argument-hint: '[--dry-run | --skip-preview | --finalize]'
description: OMP-only — promote staging→main. Pre-flight, version, changelog, PR, tag. Offered after land, never automatic.
version: 0.1.0
---

# Promote

## Success

I₀ := PR created (staging→main) | I₁ := tag pushed + release created (--finalize)
V₀ := `gh pr list --base main --head staging --state open` | V₁ := `git tag -l $VERSION` ∧ `gh release view $VERSION`

Let: σ := staging | μ := main | V := release version (vX.Y.Z) | Q := user choice

σ → μ for production. Pre-flight → version → changelog → commit → preview → PR.
`--finalize`: post-merge tag + GitHub Release.

## Where this sits — the optional tail

`/promote` is **offered**, never run on its own initiative:

- It is not part of the feature cycle. `/feature` lands a ticket; landing does not
  promote, and nothing in the review→fix loop may reach this skill. A release that
  happens as a side effect of reviewing a PR is a release nobody decided to cut.
- The operator invokes it. There is no path from `/feature`, `skill://dev-review`
  or `skill://fix` that runs it automatically, and none may be added.
- `disable-model-invocation: true` in the frontmatter omits this skill from the
  prompt listing on omp — it is **not** a gate. The property that makes this
  user-only is the lane: `omp/index.ts` exposes `/promote` through
  `registerCommand`, which the model cannot call. `skill://promote` and
  `/skill:promote` still reach this body.

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 1 | pre-flight | ✓ | ¬REFUSE | **read-only** — see below |
| 1b | pin-swap | — | ¬branch= deps remain | no-op if zero branch= deps |
| 2 | version | ✓ | V detected | first user choice |
| 3 | changelog | ✓ | CHANGELOG.md updated | — |
| 4 | commit | ✓ | `git log` shows commit | first worktree write |
| 5 | preview | — | deploy success | `--skip-preview` skips |
| 6 | summary | ✓ | summary printed | — |
| 6b | changelog-commit | — | PR merged → staging | branch protection |
| 7 | create-pr | ✓ | PR URL shown | — |
| 8 | post-merge | — | — | reminder |
| 9 | finalize | — | tag + release ∃ | `--finalize` only — reads and derives, **then asks**, then writes |

**No mutation precedes the first question — on any invocation.** Not "in the full
flow": every entrypoint. Step 1 reads; Step 1b writes only on an explicit *Apply*;
Step 2b stamps only after *Use {VERSION}* is chosen; `--finalize` derives the
version, the tag target and the tag/release states, prints them, and writes
nothing until Step 9c is answered. A flag selects a **route**, never approves its
result — a `--finalize` that tags and pushes because it was invoked is the same
"the invocation is the consent" argument this skill rejects for `/feature` and
`/cleanup`. Any edit that moves a mutation earlier than the choice that
authorises it is a defect, not an optimisation.

## Pre-flight

Success: PR created (promote) ∨ tag+release (finalize)
Evidence: PR URL shown ∨ `git tag -l $VERSION`
Steps: pre-flight → version → changelog → commit → preview → create-pr
¬clear → STOP + ask: "Full promote or --finalize?"

## Usage

```
/promote                   → Full flow
/promote --skip-preview    → Skip deploy preview
/promote --dry-run         → Show what would be promoted, create nothing
/promote --finalize        → Post-merge: tag + GitHub Release
```

## Step 1 — Pre-flight

```bash
bash skill://promote/preflight.sh
```

Emits: `commits_ahead`, `status`, commit log, diff stat, open PRs on staging, CI check results, `hotfix_density`, and a closing `---worktree---` line naming the branch still checked out.

**This script is read-only.** It derives everything from `origin/main..origin/staging`
and never checks out, pulls or merges. Its one write is `git fetch`, which touches
`refs/remotes/*` and nothing else. dev-core's copy ran `git checkout staging && git
pull origin staging` here — before the operator had been asked anything, and in a
feature worktree that either fails or drags the tree off its own branch.

| Check | Condition | Action |
|-------|-----------|--------|
| Release mode (trunk + staging) | `status=trunk_promote_pr` | **Proceed.** Open the staging→main merge PR — Step 1a runs the **Component check only** (the Gate-probe / Unfinalized-promote / Version-file guards are staging-train finalize invariants, skipped under trunk), then Steps 1b–8. Merging lands the commits on `main`; it tags nothing. Do **not** run `--finalize` — Step 9 refuses it under trunk. See `## Trunk mode`. |
| Release mode (trunk, no staging) | `status=trunk_mode` (`release.model==trunk`) | **REFUSE / no-op.** `/promote` does not apply — a pure trunk repo (no `staging` branch) cuts releases by pushing an annotated tag. Stop (see `## Trunk mode`). |
| Missing ref | `status=missing_ref:<ref>` | **REFUSE.** `origin/main` or `origin/staging` does not exist — a structured refusal, never a silent `commits_ahead=0`. |
| No commits | `commits_ahead=0` | **REFUSE.** Stop. |
| Open PRs on σ | open_prs section non-empty | **WARN** + Q: **Continue** \| **Wait** |
| CI status | ci section | **WARN** if ¬passing |
| Hotfix density | `hotfix_density` section | **WARN** if gauge=warn (20–40%); **recommend pause** if gauge=pause (>40%); advisory-only — never hard-block |
| Component set | `release.component` null/absent | **REFUSE** (S6/D13) + paste-ready `release:` block (§2a of [release-artifacts.md](skill://promote/references/release-artifacts.md)). On day 1 every repo takes this — it is the onboarding step, not a dead end. |
| Version-file drift | any `release.version_files` path ≠ `BASE` | **REFUSE** (S5). Message distinguishes *hand-drift* (`file < BASE`) from *a promote abandoned after step 2b* (`file > BASE`) — a reconcile command for each. |
| Gate provisioned | `release-consistency` **required** on `main` ∧ zero bypass actors | **REFUSE** on a **protectable** repo where it is missing/bypassable; **WARN** if the repo is un-protectable (`403` — private, free plan, D17); `Branch not protected` → REFUSE-with-onboarding. |

### Step 1a — Release guards (S5/S6/S7/D8)

**Trunk skip (`release.model: trunk`, #371 B1).** Under trunk the create-PR path opens a *plain* staging→main merge PR: there is **no pre-declared version** to validate, and merging tags nothing (ADR-021). So the **Gate probe, Unfinalized-promote, and Version-file** checks below (all staging-train *finalize* invariants) are **SKIPPED**; only the **Component** check runs — `release.component` still scopes the release-consistency floor and the `<component>/vX.Y.Z` tag prefix. Detect and short-circuit before the staging-train guards:

**Authority comes from the BASE branch, not your working tree (#374 F2, #385 item 4).** The `release-consistency` gate resolves `release.model` and `release.component` from `refs/remotes/origin/<base>:.dev/stack.yml` — for a staging→main promote, from `main`. `/promote` runs on `staging`. On `roxabi-factory` those two trees are 3934 commits apart and their `stack.yml` blobs differ, so reading the local file here makes `/promote` predict a verdict the gate will not return. Read what the gate reads:

```bash
BASE_REF=refs/remotes/origin/main    # the promote PR's base — same ref the gate anchors on
git fetch --force origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null 2>&1 || true
BASE_STACK=$(mktemp)
git show "${BASE_REF}:.dev/stack.yml" > "$BASE_STACK" 2>/dev/null || : > "$BASE_STACK"

MODEL=$(yq -r '.release.model // "staging-train"' "$BASE_STACK" 2>/dev/null \
  || python3 -c 'import sys,yaml;d=yaml.safe_load(open(sys.argv[1])) or {};print(((d.get("release") or {}).get("model")) or "staging-train")' "$BASE_STACK" 2>/dev/null \
  || echo staging-train)
MODEL=${MODEL:-staging-train}        # absent/unparseable coerces to the strict path, like the gate
# → if MODEL=trunk: run ONLY the Component check below, then jump to Step 1b.
#   (The promote-PR's version heading/title, computed in Steps 2–4, is COSMETIC under
#    trunk — no tag is cut at merge; a release is named later by an annotated tag.)
```

**Component (S6/D13)** — same source, same reason:

```bash
COMPONENT=$(yq -r '.release.component // ""' "$BASE_STACK" 2>/dev/null \
  || python3 -c 'import sys,yaml;d=yaml.safe_load(open(sys.argv[1])) or {};print(((d.get("release") or {}).get("component")) or "")' "$BASE_STACK" 2>/dev/null \
  || true)
{ [ -z "$COMPONENT" ] || [ "$COMPONENT" = null ]; } && { echo "REFUSE: release.component unset on ${BASE_REF}:.dev/stack.yml — paste the release: block from references/release-artifacts.md §2a"; exit 1; }
```

If this is empty while your **working tree** declares a component, the `release:` block (or the rename) has not landed on the base yet. Land it first via an ordinary branch→`main` PR — that PR early-greens at the gate's `head != staging` scope gate, so it is mergeable even with the gate already armed — then re-run `/promote`.

**Gate probe (S7/D6/D17)** — the check must be *required*, not merely present; a bypassable required check is advisory with better marketing, so the probe reads the actor list too. Read the **effective rules for `main`** (`rules/branches/main` resolves org-level and repo-level rulesets, including parents), then the bypass list of each ruleset that contributes the check:

```bash
RULES=$(gh api "repos/:owner/:repo/rules/branches/main" 2>&1) || true
case "$RULES" in
  *"Upgrade to GitHub Pro"*|*"Not Found"*403*)
    echo "WARN: repo un-protectable (private, free plan) — release-consistency cannot be required here (D17). D4's derivation still yields the correct version.";;
  *)
    # Is `release-consistency` actually required on main? `[]` here is the
    # unprotected repo — no rules apply — and takes the same REFUSE, whose text
    # is the onboarding: it names the ruleset to provision.
    REQUIRED=$(printf '%s' "$RULES" | jq -r '
      [ .[]? | select(.type == "required_status_checks")
             | .parameters.required_status_checks[]?.context ]
      | index("release-consistency") // empty' 2>/dev/null || true)
    [ -z "$REQUIRED" ] && { echo "REFUSE: release-consistency is not an enforced required check on main. Provision a ruleset targeting refs/heads/main with required_status_checks containing the context 'release-consistency' and bypass_actors: []."; exit 1; }

    # Required, but by whom can it be skipped? Every contributing ruleset must
    # carry an empty bypass list, or the gate is advisory for the actors listed.
    BYPASSABLE=""
    for RS_ID in $(printf '%s' "$RULES" | jq -r '.[]? | select(.type == "required_status_checks") | .ruleset_id' 2>/dev/null | sort -u); do
      ACTORS=$(gh api "repos/:owner/:repo/rulesets/${RS_ID}" --jq '(.bypass_actors // []) | length' 2>/dev/null || echo 0)
      [ "${ACTORS:-0}" -gt 0 ] && BYPASSABLE="${BYPASSABLE} ${RS_ID}"
    done
    [ -n "$BYPASSABLE" ] && { echo "REFUSE: release-consistency is required on main but bypassable — ruleset(s)${BYPASSABLE} declare bypass_actors. Empty the list; a bypassable required check is not a gate."; exit 1; }
    ;;
esac
```

The remediation names the ruleset shape, not a provisioning script: the gate lives
in the *promoted repository*, and this plugin ships no writer for it. The probe
refuses on a measured absence — never unconditionally, or the remediation it
prints could not be satisfied by doing what it says.

**Unfinalized promote (S5/D8)** — the newest merged promote **by PR metadata**, never by commit lineage (a `<merge>^2`-vs-staging ancestry test false-positives after any backmerge — it flags real hotfixes #267/#257 as promotes):

```bash
LAST=$(gh pr list --base main --head staging --state merged --limit 1 --json number,mergeCommit --jq '.[0].mergeCommit.oid')
# Derive its version: price.sh "$COMPONENT" "${LAST}^1" "$LAST". No matching tag on that version → offer to resume:
#   "Unfinalized promote detected (PR merged, no tag). Run /promote --finalize?"
```

**Version-file drift (S5)** — each `release.version_files` path is compared to `BASE`; `file < BASE` = hand-drift (reconcile: re-stamp from BASE), `file > BASE` = a promote stopped after step 2b (resume: re-open the promotion PR). `[]` → skip.

## Step 1b — Pin-swap Phase

Runs after pre-flight, before version bump. Rewrites mutable `branch=` git deps in `[tool.uv.sources]` to immutable `tag=` pins for the promotion commit.

**Trigger:** `pyproject.toml` exists AND `[tool.uv.sources]` contains at least one entry with `branch=`.

**No-op:** if zero `branch=` git deps found → silent skip, continue to Step 2.

### Detection

Scan `pyproject.toml` `[tool.uv.sources]`:

```toml
# Detected — has branch=
roxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", branch = "staging" }

# Ignored — already pinned
roxabi-nats = { git = "https://github.com/Roxabi/roxabi-nats", tag = "v1.2.3" }
```

### Resolution

For each detected dep:
1. Read pinned SHA from `uv.lock` (`rev = "<sha>"` in package source)
2. Run `git ls-remote --tags <gitUrl>` on the remote
3. Match SHA → release tag at that exact commit
4. Tag matching: prefer `<pkg>/vX.Y.Z` (monorepo subdirectory style), fall back to bare `vX.Y.Z`

### user choice gate

```
── Decision: Pin uv git deps ──
Context:     N branch= git deps found; will be rewritten for promotion
Target:      Immutable tag pins in pyproject.toml before staging→main
Path:        Rewrite pyproject.toml, run uv lock, stage both files

Deps:
  - roxabi-nats: branch=staging → tag=roxabi-nats/v1.2.3 (SHA: abc123def456)

Options:
  1. Apply — rewrite + regenerate uv.lock + stage
  2. Abort — stop promotion, no changes
Recommended: Option 1
```

### On Apply

```bash
# Rewrite pyproject.toml (branch= → tag=) for each dep
# Then regenerate:
uv lock
git add pyproject.toml uv.lock
```

### On Abort

Revert `pyproject.toml` to original (no changes were written). Stop promotion.

### Error: no tag at SHA

```
FAIL: No release tag found at roxabi-nats@abc123def4 on https://github.com/Roxabi/roxabi-nats.
Cut a release tag (e.g. roxabi-nats/vX.Y.Z) at abc123def4 upstream first.
```

Stops promotion. User must cut a tag upstream before retrying.

### `--dry-run`

Show pin-swap plan (deps + resolved tags) but do NOT write files. Continue to show version/changelog summary, then stop.

### Implementation

Logic lives in `skill://promote/lib/pin-swap.ts` (pure functions, I/O-injected). Tests in `__tests__/pin-swap.test.ts`.

## Steps 2-4 — Version, Changelog, Commit

Read [references/release-artifacts.md](skill://promote/references/release-artifacts.md) for full procedure.

Step 4 is where a branch is first checked out: `git checkout staging` belongs here,
after the version choice, never in pre-flight.

## Step 5 — Deploy Preview

¬`--skip-preview` ⇒

```bash
gh workflow run deploy-preview.yml --ref staging -f target=both
sleep 5
RUN_ID=$(gh run list --workflow=deploy-preview.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN_ID --exit-status
```

Q: **Looks good — proceed** | **Issues — abort** | **Skip preview, proceed**

`--skip-preview` ⇒ skip.

## Step 6 — Summary

```
Promotion Summary
=================
  Version:   {$VERSION}
  Commits:   {N} commits ahead of main
  PRs:       {N} merged PRs
  Files:     {N} files changed
  CI:        passing/failing/pending
  Preview:   verified/skipped
```

`--dry-run` ⇒ display + stop. "Run `/promote` to create the promotion PR."

## Step 6b — Changelog Commit

σ may have branch protection. Direct push fails →
1. Branch: `git branch chore/$VERSION-changelog staging`
2. Push: `git push origin chore/$VERSION-changelog`
3. PR: `gh pr create --base staging --head chore/$VERSION-changelog --title "chore(release): add $VERSION changelog"`
4. Merge: `gh pr merge <N> --auto --merge --delete-branch` (merge commit — ¬squash, see `## Merge method`). **`--auto` only *arms* auto-merge and returns immediately — it does not block.** Then poll until it lands, or step 7 reads a stale `origin/staging`:
   ```bash
   until [ "$(gh pr view <N> --json state --jq .state)" = MERGED ]; do sleep 10; done
   ```
5. Sync: `git fetch origin staging && git reset --hard origin/staging`

## Step 7 — Create Promotion PR

**Forced path (no free-form `gh pr create`).** Use `create-promote-pr.sh` — it always runs `collect-closing-issues.sh` and injects the Closes section. Skipping harvest is impossible without editing the wrapper.

```bash
# 1) Write body WITHOUT Closes (wrapper appends harvest)
BODY_FILE="$(mktemp)"
cat >"$BODY_FILE" <<EOF
## Promotion: staging → main ($VERSION)

{changelog}

## Pre-flight
- [x] CI passing on staging
- [x] No open PRs targeting staging (or acknowledged)
- [{preview_check}] Deploy preview verified
- [x] Release notes committed to staging

---
Generated with [Roxabi omp-build](https://github.com/Roxabi/roxabi-plugins) via \`/promote\`
EOF

# 2) Create or update staging→main PR (harvest + inject mandatory)
# Exit 1 if harvest degraded (exit 3 from collect) unless --allow-degraded after human review.
PR_URL=$(bash skill://promote/create-promote-pr.sh \
  --base main --head staging \
  --title "chore: promote staging to main ($VERSION)" \
  --body-file "$BODY_FILE")
# Optional after reviewing WARNs: add --allow-degraded
rm -f "$BODY_FILE"
```

**Does this auto-close?** For every `Closes #N` **listed in the promote body** after harvest: yes, when the promote PR **merges into `main`**. Harvest is **best-effort** (same-repo keyword adjacency only; open issues at harvest). Degraded harvest **REFUSE**s the PR create unless `--allow-degraded`. Cross-repo `owner/repo#N` is not re-emitted. Eyeball the Closes section before merge.

Display PR URL (`$PR_URL`).

## Step 8 — Post-merge Reminder

**CRITICAL: Merge commit only, never squash** — see `## Merge method` below.

```
Promotion PR created: {URL}

⚠️  MERGE WITH MERGE COMMIT (not squash) — see ## Merge method.

After merge:
  1. Production deploy runs from main
  2. Verify production at your domain
  3. Run /promote --finalize to tag + create GitHub Release
  4. Run /cleanup to clean up merged branches
```

## Step 9 — Finalize (`--finalize` only)

Skip Steps 1-8. Post-merge only.

**9.0 Trunk guard (#371 B1).** `/promote --finalize` is the *staging-train* tagger. Under `release.model: trunk` a release is cut by pushing an annotated tag (ADR-021), and there is no promotion to finalize — refuse before touching anything (see `## Trunk mode`):

```bash
MODEL=$(yq -r '.release.model // "staging-train"' .dev/stack.yml 2>/dev/null \
  || { [ -f .dev/stack.yml ] && python3 -c 'import sys,yaml;d=yaml.safe_load(open(".dev/stack.yml")) or {};print(((d.get("release") or {}).get("model")) or "staging-train")' || echo staging-train; })
[ "$MODEL" = trunk ] && { echo "REFUSE: release.model==trunk — a trunk release is cut by pushing an annotated tag (ADR-021); /promote --finalize does not apply."; exit 1; }
```

Unlike Step 1a, this one legitimately reads the **local** `.dev/stack.yml`: `--finalize` runs post-merge on `main`, so the working tree *is* the base the gate reads. No divergence to correct (#385 item 4).

**9a.** Verify the merge — **read-only**:
```bash
git fetch origin main      # refs/remotes/* only
gh pr list --base main --head staging --state merged --limit 1 --json number,title,mergedAt
```
¬merged → REFUSE: "Merge the promotion PR first."

There is no `git checkout main && git pull` here. `--finalize` runs from wherever
the operator is — routinely a feature worktree — and a checkout either fails or
drags that tree off its own branch, before a single question has been asked. The
fetch brings the merge object in; everything below is derived from that object,
and Step 9d tags it by SHA. dev-core's copy checked out first for the same reason
its pre-flight did, and it is wrong here for the same reason.

**9b.** Derive V from the **merge object alone** (S11/D4) — never from a witness. The finalize verdict (structural REFUSE, drift REFUSE, witness WARN, per-artifact act) is computed by `lib/finalize.ts` — the **tested classifier IS the executed decision** (#369), not a bash re-implementation of part of it. The PR title, CHANGELOG heading and version file are compared only to **WARN** (D7); a disagreement prints repair actions and finalize **tags the derived version anyway**, because the merge already shipped and a post-merge REFUSE would re-manufacture the shipped-no-release defect. Gather the inputs:

```bash
M=$(gh pr list --base main --head staging --state merged --limit 1 --json mergeCommit --jq '.[0].mergeCommit.oid')
PARENT_COUNT=$(( $(git rev-list --parents -n1 "$M" | wc -w) - 1 ))   # 3 words = 2 parents

# is-promote by PR metadata (D8), never by commit lineage: is M the newest merged staging→main PR?
NEWEST=$(gh pr list --base main --head staging --state merged --limit 1 --json mergeCommit --jq '.[0].mergeCommit.oid')
[ "$M" = "$NEWEST" ] && IS_PROMOTE=true || IS_PROMOTE=false

# Derived version + BASE floor — BOTH from price.sh, the sole deriver (D10). --base-only reuses
# the deriver's own floor predicate, so the gate and finalize never diverge from a second copy.
DERIVED=$(bash skill://promote/price.sh "$COMPONENT" "${M}^1" "$M"); RC=$?
{ [ "$RC" -ge 1 ] && [ "$RC" -ne 10 ]; } && { echo "REFUSE: price.sh error ($RC)"; exit 1; }
if [ "$RC" -eq 10 ]; then DERIVED=0.1.0; BASE=""; else       # first release — no floor
  set +e; BASE=$(bash skill://promote/price.sh --base-only "$COMPONENT" "${M}^1"); BRC=$?; set -e
  { [ "$BRC" -ge 1 ] && [ "$BRC" -ne 10 ]; } && { echo "REFUSE: price.sh --base-only error ($BRC)"; exit 1; }
  [ "$BRC" -eq 10 ] && BASE=""
fi
VERSION="${COMPONENT}/v${DERIVED}"

# Witnesses (WARN-only, D7) — empty string ⇒ artifact absent (a null witness, D12).
TITLE_V=$(gh pr view "$M" --json title --jq '.title' 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
# Witnesses come out of the merge object, not the working tree: with no checkout
# the tree is whatever branch the operator was on, and a feature branch's
# CHANGELOG is not a witness of what main shipped.
HEADING_V=$(git show "${M}:CHANGELOG.md" 2>/dev/null | grep -oE '^##[[:space:]]+\[?v?[0-9]+\.[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
VFILE=$(yq -r '.release.version_files[0] // ""' .dev/stack.yml 2>/dev/null || true)
FILE_V=$([ -n "$VFILE" ] && git show "${M}:${VFILE}" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
CHANGELOG_CONTENT=$(git show "${M}:CHANGELOG.md" 2>/dev/null | awk '/^## /{n++} n==1' || true)
```
`Custom version` is retained only as the multi-component escape hatch (factory/cortex), never required here.

**9c — Decision gate. Nothing above this line writes; nothing below it runs unanswered.**
A pushed tag is public the moment it lands, and a GitHub Release announces it;
"undo" is a force-delete on a ref other people have already fetched. So the
derived verdict is shown and approved *before* the first write, exactly as Step 2
gates the version bump. `--finalize` chose the route; it did not answer this
question (Safety Rule 7).

```
── Decision: Finalize release ──
Context:   promotion PR merged as {M} ({PARENT_COUNT} parents, is_promote={IS_PROMOTE})
Derived:   {VERSION}          ← price.sh over {M}^1..{M}, BASE floor {BASE}
Target:    tag {VERSION} → {M}
State:     tag={TAG_STATE} · release={RELEASE_STATE}
Witnesses: title={TITLE_V} · changelog={HEADING_V} · file={FILE_V}   (WARN-only, D7)

Options:
  1. Finalize — push the tag at {M}, create the GitHub Release
  2. Abort — write nothing
Recommended: Option 1
```

Anything other than an explicit Option 1 stops here, having written nothing.
`--dry-run` with `--finalize` prints this block and stops without asking — same
derivation, no tag. A `refuse` verdict from `finalize.ts` (Step 9d) still stops
the run after the gate: consent is not a check.

**9d.** On Option 1, let `finalize.ts` rule, then reconcile tag + release **per artifact** (D16). Re-evaluate after each act, so a finalize that died mid-way recovers and the loop converges (tag → create-release → noop). `finalize.ts` owns every hard REFUSE (≠2 parents, not-a-promote, empty payload, tag/release drift) and emits the witness WARNs:

```bash
for _ in 1 2 3; do
  # Per-artifact state (D16): where do the tag and release for $DERIVED point?
  TAG_AT=$(git rev-list -n1 "$VERSION" 2>/dev/null || true)
  if   [ -z "$TAG_AT" ];     then TAG_STATE=absent
  elif [ "$TAG_AT" = "$M" ]; then TAG_STATE=points-at-M
  else                            TAG_STATE=points-elsewhere; fi
  if gh release view "$VERSION" >/dev/null 2>&1; then
    { [ "$TAG_AT" = "$M" ] && RELEASE_STATE=points-at-M; } || RELEASE_STATE=points-elsewhere
  else RELEASE_STATE=absent; fi

  VERDICT=$(bun run skill://promote/lib/finalize.ts \
    --parent-count "$PARENT_COUNT" --is-promote "$IS_PROMOTE" \
    --derived "$DERIVED" --base "$BASE" \
    --witness-title "$TITLE_V" --witness-heading "$HEADING_V" --witness-file "$FILE_V" \
    --tag-state "$TAG_STATE" --release-state "$RELEASE_STATE") || true
  ACTION=$(printf '%s\n' "$VERDICT" | sed -n 's/^action=//p')
  printf '%s\n' "$VERDICT" | sed -n 's/^warning=/WARN: /p'   # witness disagreements (D7) — reconcile, do not block

  case "$ACTION" in
    refuse)         printf '%s\n' "$VERDICT" | sed -n 's/^reason=/REFUSE: /p'; exit 1 ;;
    tag)            git tag -a "$VERSION" -m "Release $VERSION" "$M" && git push origin "$VERSION" ;;
    create-release) TITLE="${VERSION/\/v/ v}"; gh release create "$VERSION" --title "$TITLE" --notes "$CHANGELOG_CONTENT" ;;
    noop|*)         break ;;
  esac
done
```
Re-running once **both** exist and point at `M` is a green no-op.

Inform: "Release $VERSION finalized. Run `/cleanup` to clean branches."

## Merge method — merge commit only

PRs merge via **merge commit**, never squash or rebase-merge.

Why: squash rewrites file hashes on every merged commit, which phantom-conflicts
every touched file on the next staging→main promote — it already bit
`roxabi-plugins` once, for 46 files. Merge commits preserve the commit/tag topology
Step 9's derivation reads, including the `<component>/vX.Y.Z` tag format.

Branch topology: `staging` is the default branch and every feature/fix targets it;
`main` is promote-only and is reached exclusively through this skill.

Enforce it in the promoted repo's branch protection: `allowed_merge_methods = ["merge"]`.

*(dev-core carried this as `shared/references/release-convention.md`. omp-build has
no `skills/shared/references/`: the file's only load-bearing content is the two
rules above, both already restated by the body that cited it, so the rules travel
and the file does not — #533's "a reference travels only when cited" cuts the
other way when the citation is a pointer to a restatement.)*

## Trunk mode — `release.model`

`release.model` in `.dev/stack.yml` selects the **branch flow** (#371, Model B). It does
**not** select a release trigger — see ADR-021:

- `staging-train` (**default** — absent ⇒ this) — the staging→main promote flow documented above. The whole fleet stays here until it opts in.
- `trunk` — no `staging` branch; features land directly on `main`. Nothing is derived and nothing is tagged at merge.

Under `release.model: trunk` the contract changes on two points:

- **A release is an explicit act — an annotated tag, pushed by a human.** `git tag -a <component>/vX.Y.Z -m "…" && git push origin <component>/vX.Y.Z`. The repo's own `release.yml` verifies the tag is annotated, points at that commit, and is reachable from `main`, then creates the GitHub Release. Merging to `main` cuts nothing, so a documentation merge no longer ships a version (ADR-021). The D18 bump map is untouched and simply not on this path — it still prices the **staging-train** fleet through Step 9.
- **No `/promote --finalize`; the create-PR path stays open while `staging` exists (#371 B1).** `/promote` is the staging-train tagger and a trunk repo has no promotion to finalize, so `--finalize` is **refused** under trunk (Step 9). But a repo mid-transition that still keeps a `staging` branch uses `/promote`'s **create-PR** path (`status=trunk_promote_pr`) to open the staging→main merge PR; merging it lands the commits on `main`, where a tag may later name them. A pure trunk repo with **no** `staging` branch no-ops entirely (`status=trunk_mode`) — `/promote` does not apply.

A trunk repo generates **no** release workflow, and its hand-written `release.yml` is
deliberately ungoverned. A stray `release-please.yml` writer lingering beside it is a
split brain (N10) — two release writers, one repo. Switch modes by flipping this one
`release.model` value.

## Options

| Flag | Description |
|------|-------------|
| (none) | Full flow: pre-flight → version → changelog → commit → preview → PR |
| `--skip-preview` | Skip deploy preview |
| `--dry-run` | Show summary + changelog, create nothing |
| `--finalize` | Post-merge: derive, **ask** (Step 9c), then tag + GitHub Release. Read-only until the answer |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Nothing to promote | REFUSE: σ up to date with μ |
| `origin/main` or `origin/staging` absent | REFUSE: `status=missing_ref:<ref>` |
| Open PRs on σ | Warn, list, Q |
| CI failing | Warn, show failures, Q |
| Preview fails | Show error, Q |
| PR already exists | `create-promote-pr.sh` updates open staging→main PR (title + body + Closes) |
| No closing keywords in range | Omit Closes section (ok) |
| Closing keywords only on feature→staging PRs | Re-emitted via forced collect in `create-promote-pr.sh` |
| Harvest degraded (collect exit 3) | REFUSE create-pr unless `--allow-degraded` after human review |
| Free-form `gh pr create` for promote | **Forbidden** — use `create-promote-pr.sh` only |
| `--dry-run` | Summary only, ¬create PR/commit |
| ¬merged (`--finalize`) | REFUSE: merge first — before Step 9c, so nothing was written |
| Tag exists (`--finalize`) | `finalize.ts` rules per artifact: points at M → noop; points elsewhere → REFUSE (drift) |
| Invalid version | REFUSE: ask for valid `vX.Y.Z` |

## Safety Rules

1. ¬force-push to μ ∨ σ
2. Promotion PR: ¬auto-merge — user merges after review (merge commit). Changelog PR (Step 6b): `--auto --merge` via required checks
3. Always show changelog before creating PR
4. Always check CI before promoting
5. Always warn about open PRs on σ
6. ¬push directly to μ — changelog reaches μ via promotion PR
7. **No mutation precedes the first question, on every invocation** — not just the full flow. Pre-flight reads; `--finalize` fetches refs, derives, prints Step 9c and writes nothing until it is answered. **A flag is a route, not consent**: `--finalize` says *which* operation, never that its result was approved. Any invocation that writes before it asks violates this rule, whatever flag selected it
8. `--finalize` never checks out or pulls — it tags the merge SHA it derived from (`git tag -a "$VERSION" … "$M"`), so a finalize run from a feature worktree cannot move that tree

## Chain Position

- **Phase:** Ship (optional tail)
- **Predecessor:** — standalone. The operator runs it; nothing chains into it.
- **Successor:** — manual `--finalize` follow-up, then `/cleanup` if offered and accepted
- **Class:** standalone. `/feature` may *offer* it after a ticket lands; offering is
  printing a line and stopping. It is never entered from the review→fix loop.

## Exit

- **Success standalone:** print PR URL + manual next step (`--finalize` after merge). Stop.
- **Failure:** return error to user. There is no orchestrator to recover into.

$ARGUMENTS
