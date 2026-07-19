---
name: promote
argument-hint: [--dry-run | --skip-preview | --finalize]
description: Promote staging→main — pre-flight, version bump, changelog, PR & tag. Triggers: "promote staging" | "release" | "deploy" | "cut a release" | "--finalize" | "merge to main" | "promote to production" | "ship a release" | "tag and release" | "publish release".
version: 0.5.0
allowed-tools: Bash, Read, Grep, Write, Edit, ToolSearch
---

# Promote

## Success

I₀ := PR created (staging→main) | I₁ := tag pushed + release created (--finalize)
V₀ := `gh pr list --base main --head staging --state open` | V₁ := `git tag -l $VERSION` ∧ `gh release view $VERSION`

Let: σ := staging | μ := main | V := release version (vX.Y.Z) | Q := user choice

σ → μ for production. Pre-flight → version → changelog → commit → preview → PR.
`--finalize`: post-merge tag + GitHub Release.

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 1 | pre-flight | ✓ | ¬REFUSE | — |
| 1b | pin-swap | — | ¬branch= deps remain | no-op if zero branch= deps |
| 2 | version | ✓ | V detected | — |
| 3 | changelog | ✓ | CHANGELOG.md updated | — |
| 4 | commit | ✓ | `git log` shows commit | — |
| 5 | preview | — | deploy success | `--skip-preview` skips |
| 6 | summary | ✓ | summary printed | — |
| 6b | changelog-commit | — | PR merged → staging | branch protection |
| 7 | create-pr | ✓ | PR URL shown | — |
| 8 | post-merge | — | — | reminder |
| 9 | finalize | — | tag + release ∃ | `--finalize` only |

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
bash ${CLAUDE_SKILL_DIR}/preflight.sh
```

Emits: `commits_ahead`, `status`, commit log, diff stat, open PRs on staging, CI check results, `hotfix_density`.

| Check | Condition | Action |
|-------|-----------|--------|
| Release mode | `status=trunk_mode` (`release.model==trunk`) | **REFUSE / no-op.** `/promote` does not apply — a trunk repo releases at merge-to-main via `auto-release.yml`, not a staging→main promote. Stop (see `## Trunk mode`). |
| No commits | `commits_ahead=0` | **REFUSE.** Stop. |
| Open PRs on σ | open_prs section non-empty | **WARN** + Q: **Continue** \| **Wait** |
| CI status | ci section | **WARN** if ¬passing |
| Hotfix density | `hotfix_density` section | **WARN** if gauge=warn (20–40%); **recommend pause** + `/checkup` if gauge=pause (>40%); advisory-only — never hard-block |
| Component set | `release.component` null/absent | **REFUSE** (S6/D13) + paste-ready `release:` block. On day 1 every repo takes this — it is the onboarding step, not a dead end. |
| Version-file drift | any `release.version_files` path ≠ `BASE` | **REFUSE** (S5). Message distinguishes *hand-drift* (`file < BASE`) from *a promote abandoned after step 2b* (`file > BASE`) — a reconcile command for each. |
| Gate provisioned | `release-consistency` **required** on `main` ∧ zero bypass actors | **REFUSE** on a **protectable** repo where it is missing/bypassable (name `scripts/provision-release-gate.sh`); **WARN** if the repo is un-protectable (`403` — private, free plan, D17); `Branch not protected` → REFUSE-with-onboarding. |

### Step 1a — Release guards (S5/S6/S7/D8)

**Component (S6/D13):**

```bash
COMPONENT=$(yq -r '.release.component // "null"' .claude/stack.yml 2>/dev/null \
  || python3 -c 'import yaml;print((yaml.safe_load(open(".claude/stack.yml")).get("release") or {}).get("component") or "null")')
{ [ "$COMPONENT" = null ] || [ -z "$COMPONENT" ]; } && { echo "REFUSE: release.component unset — paste a release: block (see stack.yml.example)"; exit 1; }
```

**Gate probe (S7/D6/D17)** — the check must be *required*, not merely present; a bypassable required check is advisory with better marketing, so the probe reads the actor list too:

```bash
RS=$(gh api "repos/:owner/:repo/rulesets?includes_parents=true" 2>&1) || true
case "$RS" in
  *"Upgrade to GitHub Pro"*|*"Not Found"*403*)
    echo "WARN: repo un-protectable (private, free plan) — release-consistency cannot be required here (D17). D4's derivation still yields the correct version.";;
  *)
    # Assert a main-targeting ruleset REQUIRES the `release-consistency` context with an empty bypass_actors list.
    # Absent/bypassable on a protectable repo → REFUSE; `Branch not protected` → REFUSE-with-onboarding.
    echo "REFUSE: release-consistency is not an enforced required check on main. Run: bash scripts/provision-release-gate.sh <owner/repo>"; exit 1;;
esac
```

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

Logic lives in `lib/pin-swap.ts` (pure functions, I/O-injected). Tests in `__tests__/pin-swap.test.ts`.

## Steps 2-4 — Version, Changelog, Commit

Read [references/release-artifacts.md](${CLAUDE_SKILL_DIR}/references/release-artifacts.md) for full procedure.

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
4. Merge: `gh pr merge <N> --auto --merge --delete-branch` (merge commit — ¬squash, Release Convention). **`--auto` only *arms* auto-merge and returns immediately — it does not block.** Then poll until it lands, or step 7 reads a stale `origin/staging`:
   ```bash
   until [ "$(gh pr view <N> --json state --jq .state)" = MERGED ]; do sleep 10; done
   ```
5. Sync: `git fetch origin staging && git reset --hard origin/staging`

## Step 7 — Create Promotion PR

```bash
gh pr create \
  --base main --head staging \
  --title "chore: promote staging to main ($VERSION)" \
  --body "$(cat <<EOF
## Promotion: staging → main ($VERSION)

{changelog}

## Pre-flight
- [x] CI passing on staging
- [x] No open PRs targeting staging (or acknowledged)
- [{preview_check}] Deploy preview verified
- [x] Release notes committed to staging

---
Generated with [Claude Code](https://claude.com/claude-code) via \`/promote\`
EOF
)"
```

Display PR URL.

## Step 8 — Post-merge Reminder

**CRITICAL: Merge commit only, never squash** — see [`release-convention.md`](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/release-convention.md).

```
Promotion PR created: {URL}

⚠️  MERGE WITH MERGE COMMIT (not squash) — see release-convention.md.

After merge:
  1. Vercel auto-deploys to production
  2. Verify production at your domain
  3. Run /promote --finalize to tag + create GitHub Release
  4. Run /cleanup to clean up merged branches
```

## Step 9 — Finalize (`--finalize` only)

Skip Steps 1-8. Post-merge only.

**9a.** Verify merge:
```bash
git fetch origin main && git checkout main && git pull origin main
gh pr list --base main --head staging --state merged --limit 1 --json number,title,mergedAt
```
¬merged → REFUSE: "Merge the promotion PR first."

**9b.** Derive V from the **merge object alone** (S11/D4) — never from a witness. The finalize verdict (structural REFUSE, drift REFUSE, witness WARN, per-artifact act) is computed by `lib/finalize.ts` — the **tested classifier IS the executed decision** (#369), not a bash re-implementation of part of it. The PR title, CHANGELOG heading and version file are compared only to **WARN** (D7); a disagreement prints repair actions and finalize **tags the derived version anyway**, because the merge already shipped and a post-merge REFUSE would re-manufacture the shipped-no-release defect. Gather the inputs:

```bash
M=$(gh pr list --base main --head staging --state merged --limit 1 --json mergeCommit --jq '.[0].mergeCommit.oid')
PARENT_COUNT=$(( $(git rev-list --parents -n1 "$M" | wc -w) - 1 ))   # 3 words = 2 parents

# is-promote by PR metadata (D8), never by commit lineage: is M the newest merged staging→main PR?
NEWEST=$(gh pr list --base main --head staging --state merged --limit 1 --json mergeCommit --jq '.[0].mergeCommit.oid')
[ "$M" = "$NEWEST" ] && IS_PROMOTE=true || IS_PROMOTE=false

# Derived version + BASE floor — BOTH from price.sh, the sole deriver (D10). --base-only reuses
# the deriver's own floor predicate, so the gate and finalize never diverge from a second copy.
DERIVED=$(bash "${CLAUDE_SKILL_DIR}/price.sh" "$COMPONENT" "${M}^1" "$M"); RC=$?
{ [ "$RC" -ge 1 ] && [ "$RC" -ne 10 ]; } && { echo "REFUSE: price.sh error ($RC)"; exit 1; }
if [ "$RC" -eq 10 ]; then DERIVED=0.1.0; BASE=""; else       # first release — no floor
  set +e; BASE=$(bash "${CLAUDE_SKILL_DIR}/price.sh" --base-only "$COMPONENT" "${M}^1"); BRC=$?; set -e
  { [ "$BRC" -ge 1 ] && [ "$BRC" -ne 10 ]; } && { echo "REFUSE: price.sh --base-only error ($BRC)"; exit 1; }
  [ "$BRC" -eq 10 ] && BASE=""
fi
VERSION="${COMPONENT}/v${DERIVED}"

# Witnesses (WARN-only, D7) — empty string ⇒ artifact absent (a null witness, D12).
TITLE_V=$(gh pr view "$M" --json title --jq '.title' 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
HEADING_V=$(grep -oE '^##[[:space:]]+\[?v?[0-9]+\.[0-9]+\.[0-9]+' CHANGELOG.md 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
VFILE=$(yq -r '.release.version_files[0] // ""' .claude/stack.yml 2>/dev/null || true)
FILE_V=$([ -n "$VFILE" ] && [ -f "$VFILE" ] && grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "$VFILE" | head -n1 || true)
```
`Custom version` is retained only as the multi-component escape hatch (factory/cortex), never required here.

**9c/9d.** Let `finalize.ts` rule, then reconcile tag + release **per artifact** (D16). Re-evaluate after each act, so a finalize that died mid-way recovers and the loop converges (tag → create-release → noop). `finalize.ts` owns every hard REFUSE (≠2 parents, not-a-promote, empty payload, tag/release drift) and emits the witness WARNs:

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

  VERDICT=$(bun run "${CLAUDE_SKILL_DIR}/lib/finalize.ts" \
    --parent-count "$PARENT_COUNT" --is-promote "$IS_PROMOTE" \
    --derived "$DERIVED" --base "$BASE" \
    --witness-title "$TITLE_V" --witness-heading "$HEADING_V" --witness-file "$FILE_V" \
    --tag-state "$TAG_STATE" --release-state "$RELEASE_STATE") || true
  ACTION=$(printf '%s\n' "$VERDICT" | sed -n 's/^action=//p')
  printf '%s\n' "$VERDICT" | sed -n 's/^warning=/WARN: /p'   # witness disagreements (D7) — reconcile, do not block

  case "$ACTION" in
    refuse)         printf '%s\n' "$VERDICT" | sed -n 's/^reason=/REFUSE: /p'; exit 1 ;;
    tag)            git tag -a "$VERSION" -m "Release $VERSION" && git push origin "$VERSION" ;;
    create-release) TITLE="${VERSION/\/v/ v}"; gh release create "$VERSION" --title "$TITLE" --notes "$CHANGELOG_CONTENT" ;;
    noop|*)         break ;;
  esac
done
```
Re-running once **both** exist and point at `M` is a green no-op.

Inform: "Release $VERSION finalized. Run `/cleanup` to clean branches."

## Trunk mode — `release.model`

`release.model` in `.claude/stack.yml` selects the release train (#371, Model B):

- `staging-train` (**default** — absent ⇒ this) — the staging→main promote flow documented above. The whole fleet stays here until it opts in.
- `trunk` — versions are derived and releases cut **on every merge to `main`** by the generated `auto-release.yml`. No staging branch, no promotion PR, no pre-declared version.

Under `release.model: trunk` the contract changes on four points:

- **Merge-commits required.** `auto-release.sh` derives from `M^1..M`, so a release needs a 2-parent merge. A stray 1-parent push to `main` (direct commit, squash, fast-forward) is **loud-red**, never a silent release (D3). Keep the merge queue on merge-commits (never squash).
- **No `/promote`.** `/promote` and `preflight.sh` no-op with `status=trunk_mode` — releasing is `auto-release.yml`'s job, not a staging→main promotion. Running `/promote` on a trunk repo is a mistake, not a step.
- **Fires on every merge; empty is a green no-op.** The workflow runs on each `push: main`. A merge that adds no version-bumping conventional commit derives `== BASE` and exits green **without tagging** (D18). Only a bumping payload cuts a release, so most merges are no-ops.
- **Recovery via `workflow_dispatch`.** If a run dies mid-finalize (tag pushed, release not created), re-run the workflow from the Actions tab — the reconcile loop is per-artifact idempotent (D16): it creates only the missing artifact and no-ops once both the tag and release point at `M`.

`/checkup` enforces the trunk contract: it **fails** when `auto-release.yml` is absent or drifts from the generator (N11), or when a stray `release-please.yml` writer lingers (N10). Switch modes by flipping this one `release.model` value and regenerating workflows with `/ci-setup`.

## Options

| Flag | Description |
|------|-------------|
| (none) | Full flow: pre-flight → version → changelog → commit → preview → PR |
| `--skip-preview` | Skip deploy preview |
| `--dry-run` | Show summary + changelog, create nothing |
| `--finalize` | Post-merge: tag + GitHub Release |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Nothing to promote | REFUSE: σ up to date with μ |
| Open PRs on σ | Warn, list, Q |
| CI failing | Warn, show failures, Q |
| Preview fails | Show error, Q |
| PR already exists | Detect via `gh pr list`, offer update |
| `--dry-run` | Summary only, ¬create PR/commit |
| ¬merged (`--finalize`) | REFUSE: merge first |
| Tag exists (`--finalize`) | REFUSE |
| Invalid version | REFUSE: ask for valid `vX.Y.Z` |

## Safety Rules

1. ¬force-push to μ ∨ σ
2. Promotion PR: ¬auto-merge — user merges after review (merge commit). Changelog PR (Step 6b): `--auto --merge` via required checks
3. Always show changelog before creating PR
4. Always check CI before promoting
5. Always warn about open PRs on σ
6. ¬push directly to μ — changelog reaches μ via promotion PR

## Chain Position

- **Phase:** Ship
- **Predecessor:** — (standalone, NOT auto-triggered by `/dev`)
- **Successor:** — (manual `--finalize` follow-up)
- **Class:** standalone (user explicitly invokes `/promote`, never chained from a feature pipeline)

## Task Integration

- `/dev` SKIPS this step by default (Step 4 skip logic: `promote → skip`)
- This skill does NOT participate in dev-pipeline tasks
- Sub-tasks created: none
- When invoked manually: runs without any `/dev`-owned task lifecycle

## Exit

- **Success standalone:** print PR URL + manual next step (`--finalize` after merge). Stop.
- **Failure:** return error to user. No `/dev` recovery path (standalone).

$ARGUMENTS
