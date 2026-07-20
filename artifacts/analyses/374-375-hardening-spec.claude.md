<!--
PROVENANCE — this is the raw synthesis output of a 17-agent hardening review
(ground-truth → 3 designs/issue → judge → 3 adversarial refute lenses → synthesis,
~1.79M tokens) run 2026-07-20. Archived verbatim as the design record.

READ WITH CARE — it was the INPUT to implementation, not a post-hoc report, and
some of its own premises were corrected during implementation:
  - #375 was implemented as the MINIMAL resolvability guard, NOT the `script_path`
    config contract this doc designs (productisation deferred to #386 / FU-5).
  - #374 was implemented as the config-authority fix only; the gate stays inert
    and its larger holes are #385 / FU-2.
  - FU-3/FU-4 were narrowed on implementation (context-lint drift is L29 only —
    L12 `[main]` is the deliberate #376 trunk migration; the verifier extension
    keys on non-SHA refs, not ACTION_PINS membership).

WHERE THE FIXES LANDED: FU-1 → PR #382 (v0.5.2) · #375 → PR #383 (v0.5.3) ·
#374 → PR #384 (v0.5.4). Follow-ups filed: #385 (FU-2), #386 (FU-5).
-->

# FINAL IMPLEMENTATION SPEC — dev-core #374 and #375

Everything below is verified against the working tree at `/home/mickael/projects/roxabi-plugins` (branch `main`). Where I ran a command to settle a disputed claim, the result is quoted.

---

## PART 0 — Verdict disposition (every fatal/major objection)

### #374

| # | Lens | Objection | Disposition |
|---|---|---|---|
| B1 | bypass (fatal) | `git show "origin/$PR_BASE_REF:..."` is an **ambiguous revision**; a tag named `origin/main` shadows the remote-tracking ref | **FOLDED.** Reproduced: with a tag `origin/main` present, `git show origin/main:.claude/stack.yml` printed `model: trunk` (+ `warning: refname 'origin/main' is ambiguous`), while `git show refs/remotes/origin/main:...` printed `model: staging-train`. Spec uses `refs/remotes/origin/<ref>` everywhere, including the `price.sh` anchor. Falsifier G2. |
| B2 | bypass (fatal) | The caller stub is committed into the target repo and is taken from the PR merge ref → a PR can replace the `uses:` job with `run: exit 0` | **DISMISSED FOR THIS CHANGE, ESCALATED.** Unfixable inside `release-consistency.yml`: `provision-release-gate.sh:95-140` writes the stub into the target repo and the ruleset (`:201-219`) has `bypass_actors: []` and requires the context **by name only**. The control has to be `file_path_restriction` on `.github/workflows/**`, CODEOWNERS, or org required-workflows. → **follow-up FU-2**, and it is the reason Part 3 says #374 must not be over-invested in. |
| B3 | bypass (fatal) | Stub exposes `workflow_dispatch` against any ref → push path runs with `PUSH_SHA` = attacker branch tip → `version_files: []` early green lands a GREEN check-run on the PR head SHA | **FOLDED.** New `RUN_REF` guard: any non-`pull_request` run whose `github.ref != refs/heads/main` is a hard **red** (never a green — a green is the payload). Falsifier G9. |
| F1 | fleet-regression (major) | New pre-Gate steps (self-pin assert + `.gate-tools` checkout) fail the **job**, which sits in front of every in-job `exit 0` → deadlocks all PRs in every provisioned repo | **FOLDED BY DELETION.** The winner's cross-repo tooling checkout is **cut entirely**. Zero new steps. D15c is preserved at job granularity, not just step granularity. |
| F2 | fleet-regression (major) | Gate reads component from `origin/main` while `/promote` step 1a reads the local tree (= `staging`, 3934 commits apart on factory) → `/promote` predicts green, gate reds | **FOLDED.** `promote/SKILL.md` step 1a is amended to read the component from `refs/remotes/origin/<base>` under staging-train. Also, the provisioner **preflight is cut** — its stated justification (bootstrap deadlock) was disproven (`head != staging` early-greens at :136 *before* the component read at :141), and it was the thing that hard-blocked factory/live. |
| O1 | operational (major) | Hoisting `MODEL=$(read_model)` to a bare assignment makes a **malformed** base `stack.yml` abort under `set -euo pipefail` → hard red on every PR including the fixing PR → unrecoverable (zero bypass actors) | **FOLDED.** Reproduced: `M=$(yq -r '...' /tmp/bad.yml)` under `set -euo pipefail` aborted, rc=1, `SURVIVED` never printed. Readers now swallow parse errors and the script **coerces to `staging-train` with a `::warning::`, never a red**. Falsifier G5. |
| O2 | operational (major) | `expect(reusableSrc.indexOf('fetch-depth: 0'))` matches the **comment at :44**, not the step at :52 → vacuous ordering guard | **MOOT + LESSON APPLIED.** No `.gate-tools` step exists, so the assertion is not written. All new text assertions use `^`-anchored multiline regexes, never bare `indexOf` on a string that also appears in prose. |
| O3 | operational (major) | Two-commit protocol self-contradicts on T4; mutation F-B's isolation claim is wrong | **MOOT.** T4/F-B belonged to the deriver-pinning layer, which is cut. |
| O4 | operational (minor) | `bun run test` gains an undeclared `yq`/`python3`+PyYAML dependency; T8b would pass for the wrong reason | **FOLDED.** `hasYamlReader()` guard mirroring `auto-release-actionlint.test.ts:44-58` — loud throw under `process.env.CI`, skip locally. |
| O5 | operational (minor) | Divergence notice compares the **coerced** model → cries wolf | **FOLDED.** Compare `BASE_MODEL_RAW`. |

### #375

| # | Lens | Objection | Disposition |
|---|---|---|---|
| P1 | bypass (fatal) + fleet-regression (major) | L4 graft into `release-consistency.yml` puts `[ -f "$PRICE" ] \|\| exit 1` at :71, **above** all three early greens (:128 trunk, :136 head≠staging, :197 version_files empty) → every provisioned consumer's `main` deadlocks | **FOLDED BY DELETION.** L4 is cut from #375 entirely. Verified the ordering claim by reading the file: `PRICE` is assigned at :71 and first *consumed* at :149/:210. The safe (lazy) version belongs with the provisioning work → **follow-up FU-2**. This also disposes of bypass finding (4) (`script_path` as a PR-selectable exec sink) and the "unlinted graft" objection, since `script_path` no longer reaches any exec sink outside `auto-release.yml`. |
| P2 | fleet-regression (major) | The edit targets `.claude/stack.yml.example`; the **shipped** template is `plugins/dev-core/stack.yml.example`, which **already has** a `release:` block (`:71-75`, incl. `class: NONE`, `component: null`) | **FOLDED.** Verified both files. Edit moves to `plugins/dev-core/stack.yml.example`; `class:` and `component: null` preserved verbatim. The "no release block ⇒ trunk never productised" premise is retracted. `release-model-docs.test.ts:9` resolves `../../../stack.yml.example` → the shipped file; a sentinel is added there. |
| P3 | fleet-regression (major) | `parseRelease` gaining `scriptPath` breaks three exact-shape `toEqual` assertions | **FOLDED.** Verified at `plugins/dev-core/skills/shared/__tests__/parse-stack-yml.test.ts:154,159,174` plus the local type mirror at `:20`. All four listed as required edits. |
| P4 | fleet-regression (major) | `ADR-016` is taken by `016-plain-markdown-docs-no-fumadocs.md`, which **bans new `.mdx`** | **FOLDED.** New ADR is `017-…**.md**`. |
| P5 | bypass (major) | The L2 gate is not on the path by which trunk workflows are actually created (hand-copy), and `/checkup` does **not** run in CI | **PARTIALLY FOLDED + STATED PLAINLY.** Verified: `ci.yml` has no doctor/checkup step. Added an in-repo CI-enforced test (T-R) asserting the committed `auto-release.yml`'s `run:` path resolves from the repo root. For *consumers*, dev-core cannot enforce anything in their CI — N11b is advisory, and the spec says so rather than claiming a gate it does not have. |
| P6 | bypass (fatal) | `auto-release.yml` has `workflow_dispatch: {}` with no ref constraint; `auto-release.sh` only checks `PARENT_COUNT -ne 2` and never checks ancestry → anyone with write access can dispatch from a branch tipped by a merge commit and forge a real tag + Release under the App token | **CONFIRMED, SPLIT OUT AS FU-1, DO IT FIRST.** Verified `auto-release.sh:40-51` — `M=$(git rev-parse --verify "${M_REF}^{commit}")`, parent-count check, **no** `merge-base --is-ancestor`. This is the only **live** vulnerability in this batch (#374 and #375 are both latent). It is not #375 and must not be buried in a project-agnosticism refactor. Exact fix in Part 4. |
| P7 | bypass (minor) | The two byte gates diverge once `scriptPath` is a real input (`auto-release-actionlint.test.ts:24` hardcodes `trunkOpts`; N11 uses `workflowOptsFromStack`) | **FOLDED.** Test T-S pins the invariant: this repo's `.claude/stack.yml` must not set `release.script_path`. |
| P8 | operational (major) | The L2 `fs.existsSync` gate turns the currently-green `workflows.test.ts:404` red — its `beforeEach` chdirs into an **empty** `mkdtemp` | **FOLDED.** Verified `:340-351` and `:404-410`. That test is rewritten (it becomes T1b: create the closure in tmp first) and the refusal case is added beside it. The design's "no test fixture churn" claim is retracted. |
| P9 | operational (major) | T5 as specified does **not** crash — `generateAutoReleaseYml` is called only in the `else if` guarded by `existsSync(arPath)` | **FOLDED.** Verified at `workflow-drift.ts:106-125`. T5's fixture now also writes `auto-release.yml`. The `fleetImpact` claim "any repo that flips trunk gets /checkup crashing outright" is **retracted**: a consumer without the workflow gets a clean `fail`. The try/catch stays because the crash is real when the workflow *is* present. |
| P10 | operational (minor) | `writeWorkflows` calls `mkdirSync` before normalize → refusal is not fully atomic | **FOLDED.** Gate moves above `mkdirSync`. |
| P11 | operational (major, type churn) | `Required<WorkflowOpts>` → `NormalizedWorkflowOpts` churn breaks `workflows.test.ts:225,236` | **FOLDED BY REDESIGN.** `normalizeWorkflowOpts` is **not touched**. `scriptPath` is resolved at point of use via `resolveReleaseScriptPath()`. Zero type churn, `norm.release` stays `{model, component}`, both `toEqual` assertions stay green. |

---

## PART 1 — #374: fix in the YAML, nothing else

**Scope statement (read before implementing):** this closes the *config-authority* hole (`read_model`/`read_component`), the ref-ambiguity hole, and the dispatch hole. It **does not** close the head-supplied `price.sh` execution (`:149`) — that requires a pinned cross-repo tooling checkout, which requires solving the conditional-step problem from F1, which is the same work item as making the gate provisionable at all. That is FU-2. The workflow header must say so.

### Files touched
- `.github/workflows/release-consistency.yml` (hand-written; **no generator, no N11, no copy-sync** — verified: no `generateReleaseConsistencyYml` exists, and `tools/shared-sources.json` is `.ts`-only)
- `plugins/dev-core/skills/promote/__tests__/release-gate.test.ts` (retarget 1 block)
- `plugins/dev-core/skills/promote/__tests__/release-gate-exec.test.ts` (**new**)
- `plugins/dev-core/skills/promote/SKILL.md` (step 1a component source)

### 1.1 `release-consistency.yml` — header addendum

Append to the top-of-file comment block (after line 18):

```yaml
#
# TRUST MODEL (#374). On the pull_request path the working tree is the PR MERGE
# ref (base + head), and in a reusable workflow `actions/checkout` with no
# `repository:` takes the CALLER's repo. Head content is the SUBJECT of this
# check and must never decide whether the check runs.
#   AUTHORITY (base)    : release.model, release.component
#                         <- git show refs/remotes/origin/<base.ref>:.claude/stack.yml
#   WITNESSES (head)    : PR title, newest CHANGELOG.md heading — they ARE the claim
#   push/dispatch path  : the worktree IS the protected-branch tip; no head exists
#
# KNOWN-OPEN, tracked separately (do NOT read this gate as fully hardened):
#   (a) $PRICE below is still executed FROM THE CHECKOUT. A PR that rewrites
#       price.sh dictates its own verdict. Closing it needs a pinned checkout of
#       this workflow's own repo (job.workflow_repository / job.workflow_sha),
#       which must be a CONDITIONAL step or a failed cross-repo clone would fail
#       the JOB in front of the in-job early greens and deadlock main (D15c at job
#       granularity). Deferred with the provisioning work.
#   (b) The per-repo caller stub is committed into the target repo, so a PR can
#       replace this `uses:` job with `run: exit 0`. That is not fixable here —
#       it needs a ruleset file_path_restriction on .github/workflows/**,
#       CODEOWNERS, or an org required-workflow.
#   (c) push path: a merged PR that sets `version_files: []` neuters the NEXT
#       push, because post-merge that config IS the base. "Whoever can merge sets
#       policy" — code review's job, not this gate's.
```

### 1.2 Gate step `env:` — replace lines 60-67

```yaml
      - name: Gate
        env:
          EVENT_NAME: ${{ github.event_name }}
          # #374 — the authority anchor. Resolves against the CALLER's event
          # payload (the `github` context inside a reusable is always the
          # caller's; the pre-#374 code already relied on this for head.ref), so
          # no stub change and no re-provisioning is required.
          PR_BASE_REF: ${{ github.event.pull_request.base.ref }}
          PR_HEAD_REF: ${{ github.event.pull_request.head.ref }}
          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          PR_TITLE: ${{ github.event.pull_request.title }}
          PUSH_SHA: ${{ github.sha }}
          # #374 B3 — the ref this run is attached to, for the dispatch guard.
          RUN_REF: ${{ github.ref }}
          VERSION_FILES_OVERRIDE: ${{ inputs.version_files_override }}
```

### 1.3 Readers — replace lines 78-93 (`read_component` + `read_model`)

`read_version_files` (:94-100) and `parse_override` (:101-103) are **unchanged** — the push path's checkout is authoritative.

```bash
          # ── release.<key> from a YAML DOCUMENT ON STDIN (#374) ──────────────
          # Stdin, not a path, for two reasons proved empirically:
          #   `yq -r '.release.model // "staging-train"' <missing>` -> rc=1, stderr,
          #   NO stdout, so the documented default NEVER fired and the real return
          #   was "" (the old gate failed closed only by accident of string
          #   inequality). `printf '' | yq -r '... // "staging-train"'` -> rc=0 and
          #   the default DOES fire. Absence becomes a well-formed empty document.
          # Errors are swallowed on purpose: a MALFORMED base stack.yml must never
          # hard-red. The ruleset has zero bypass actors, and the base is malformed
          # for the fixing PR too, so a red there is an unrecoverable branch
          # deadlock. Unparseable degrades to the strict staging-train path, loudly.
          read_release_key() {   # $1 = key; YAML on stdin
            if command -v yq >/dev/null 2>&1; then
              yq -r ".release.${1} // \"\"" 2>/dev/null
            else
              python3 -c 'import sys,yaml; d=yaml.safe_load(sys.stdin) or {}; print(((d.get("release") or {}).get(sys.argv[1])) or "")' "$1" 2>/dev/null
            fi
          }
```

### 1.4 PR path — replace lines 122-149 (up to and including the `DERIVED=` line)

```bash
          if [ "$EVENT_NAME" = "pull_request" ]; then
            BASE_REF="${PR_BASE_REF:-}"
            # Reject anything that is not a plain branch name before it reaches a
            # revision expression. Empty base = cannot resolve policy = refuse.
            case "$BASE_REF" in
              ''|-*|*..*|*' '*|*'~'*|*'^'*|*':'*|*'?'*|*'*'*|*'['*|*'\'*|*'@{'*)
                echo "release-consistency: unusable pull_request base ref '${BASE_REF}' — refusing to gate (fail closed, #374)" >&2
                exit 1 ;;
            esac

            # FULLY QUALIFIED on purpose. `origin/main` is an AMBIGUOUS revision:
            # gitrevisions(7) resolves refs/tags/<name> (step 3) BEFORE
            # refs/remotes/<name> (step 5), and the fetch above pulls every tag
            # with --tags --force. A pushed tag literally named `origin/main`
            # would shadow the remote-tracking ref and hand the PR its own policy
            # back — reproduced; it also emits `warning: refname is ambiguous`,
            # which a 2>/dev/null would have swallowed. Never use the short form.
            BASE="refs/remotes/origin/${BASE_REF}"
            BASE_STACK=$(git show "${BASE}:${STACK}" 2>/dev/null || true)

            MODEL=$(printf '%s\n' "$BASE_STACK" | read_release_key model || true)
            BASE_COMPONENT=$(printf '%s\n' "$BASE_STACK" | read_release_key component || true)
            BASE_MODEL_RAW="$MODEL"

            if [ -z "$BASE_STACK" ]; then
              echo "::warning::release-consistency: no ${STACK} on ${BASE} — assuming release.model=staging-train (fail closed, #374)"
              MODEL="staging-train"
            fi
            # Absent, unparseable and unknown ALL resolve INTO the strict path,
            # never out of it. Never a hard red: a red on ambiguity would deadlock
            # every repo pinned to an older gate tag the moment a newer dev-core
            # coins a model name this tag never heard of. Unknown != trunk, so
            # coercion is already the safe direction.
            case "$MODEL" in
              trunk|staging-train) : ;;
              '')
                echo "::warning::release-consistency: release.model absent or unparseable on ${BASE} — assuming staging-train (fail closed, #374)"
                MODEL="staging-train" ;;
              *)
                echo "::warning::release-consistency: unknown release.model='${MODEL}' on ${BASE} — coercing to staging-train (#374)"
                MODEL="staging-train" ;;
            esac

            # Detection, not enforcement — compared against the RAW base value so a
            # coercion cannot manufacture a phantom divergence. A legitimate
            # staging-train -> trunk migration PR still lands; it is simply held to
            # the policy in force on the base, which is the correct semantics.
            HEAD_MODEL=""
            if [ -f "$STACK" ]; then HEAD_MODEL=$(read_release_key model < "$STACK" || true); fi
            if [ -n "$HEAD_MODEL" ] && [ "$HEAD_MODEL" != "$BASE_MODEL_RAW" ]; then
              echo "notice: release.model differs — base(${BASE})='${BASE_MODEL_RAW:-<absent>}' head='${HEAD_MODEL}'. Policy is read from BASE (#374)."
            fi

            if [ "$MODEL" = "trunk" ]; then
              echo "trunk mode (from ${BASE}) — release consistency enforced at merge-to-main, not on PRs — early green"
              exit 0
            fi
            if [ "$PR_HEAD_REF" != "staging" ]; then
              echo "not-a-promote (head=${PR_HEAD_REF:-?} != staging) — early green"
              exit 0
            fi

            COMPONENT="$BASE_COMPONENT"
            if [ -z "$COMPONENT" ]; then
              echo "release-consistency: release.component missing/null in ${BASE}:${STACK} (D13)" >&2
              exit 1
            fi

            # Without this a rename degrades the check SILENTLY: a head-read
            # component finds zero <new>/v* tags -> price.sh select_base returns 11
            # -> exit 10 -> the gate falls back to witness-only agreement (title ==
            # CHANGELOG), BOTH head-authored.
            HEAD_COMPONENT=""
            if [ -f "$STACK" ]; then HEAD_COMPONENT=$(read_release_key component < "$STACK" || true); fi
            if [ -n "$HEAD_COMPONENT" ] && [ "$HEAD_COMPONENT" != "$COMPONENT" ]; then
              {
                echo "release-consistency: release.component differs between base and head (#374)."
                echo "  base (authoritative, ${BASE}): ${COMPONENT}"
                echo "  head                         : ${HEAD_COMPONENT}"
                echo "  The gate prices against the BASE component; a rename changes tag lineage."
                echo "  Land the rename on ${BASE_REF} first — an ordinary branch->${BASE_REF} PR"
                echo "  early-greens at the head!=staging gate above — then re-run /promote."
              } >&2
              exit 1
            fi

            # Derive from the PR's own head (re-price per head SHA).
            set +e
            DERIVED=$(bash "$PRICE" "$COMPONENT" "$BASE" "$BASE" "$PR_HEAD_SHA")
            rc=$?
            set -e
```

Lines 150-184 (`TITLE_VER` through the three-way `exit 1`) are **unchanged**.

### 1.5 push/dispatch path — insert immediately after line 184's `fi`, before the `# ═══ push / workflow_dispatch path` banner

```bash
          # ── #374 B3: dispatch ref guard ────────────────────────────────────
          # The caller stub also exposes workflow_dispatch, dispatchable against
          # ANY ref. EVENT_NAME is then "workflow_dispatch", not "pull_request",
          # so the run falls to the push path with PUSH_SHA = the dispatched
          # branch tip. With `version_files: []` (the shipped default) that path
          # early-GREENS — landing a green `release-consistency` check-run on a PR
          # head SHA and satisfying the required check without the three-way check
          # ever running. A green is exactly the payload, so this is a hard RED,
          # never an early green.
          # refs/heads/main is literal to match the stub's `push: branches: [main]`
          # and the ruleset's `conditions.ref_name.include: ["refs/heads/main"]`
          # (provision-release-gate.sh) — the two surfaces that already hardcode it.
          if [ "${RUN_REF:-}" != "refs/heads/main" ]; then
            echo "release-consistency: ${EVENT_NAME} on ref '${RUN_REF:-<none>}' is not the protected branch — refusing to report a verdict (#374)" >&2
            exit 1
          fi
```

> `VERSION_FILES_OVERRIDE` remains reachable only by an actor who can dispatch **on `main`** (write access), and it can only weaken the at-rest floor check — it never cuts a release. Documented, not coded around.

### 1.6 `promote/SKILL.md` — step 1a component source (fixes F2)

Under staging-train, the gate now reads the component from the base branch while `/promote` runs on `staging`. On `roxabi-factory` those trees are 3934 commits apart and their `.claude/stack.yml` blobs differ (`fcc670d` vs `1aec15d`). Amend step 1a's Component check to read what the gate will read:

```bash
# staging-train: the release-consistency gate reads release.component from the BASE
# branch (#374), not from your working tree. Predict its verdict with the same source.
git fetch --force origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null 2>&1 || true
COMPONENT=$(git show refs/remotes/origin/main:.claude/stack.yml 2>/dev/null \
  | yq -r '.release.component // ""' 2>/dev/null || true)
```
with prose: *if this is empty while your working tree declares a component, the rename has not landed on `main` yet — land it via an ordinary branch→main PR (which early-greens at the `head != staging` gate) before running `/promote --finalize`.*

### 1.7 `release-gate.test.ts` — retarget one block only

Replace `:144-149` (`read_model()` / `.release.model` / `staging-train`) with:

```ts
  it('resolves release policy from the BASE ref, never the merge tree (#374)', () => {
    expect(reusableSrc).toMatch(/read_release_key\(\)/)
    expect(reusableSrc).toContain('.release.${1}')
    // Fully qualified — `origin/<ref>` is ambiguous (a tag of that name wins).
    expect(reusableSrc).toContain('BASE="refs/remotes/origin/${BASE_REF}"')
    expect(reusableSrc).not.toMatch(/git show "origin\//)
    expect(reusableSrc).not.toMatch(/\$PRICE" "\$COMPONENT" origin\/main/)
    // The base read must precede the branch the trunk early-exit takes.
    const showIdx = reusableSrc.indexOf('BASE_STACK=$(git show')
    const trunkIdx = reusableSrc.search(/[^!]= "trunk" \]/)
    expect(showIdx).toBeGreaterThan(-1)
    expect(trunkIdx).toBeGreaterThan(showIdx)
  })

  it('coerces absent/unparseable/unknown release.model to the strict path, never a hard red (#374)', () => {
    expect(reusableSrc).toMatch(/^\s+trunk\|staging-train\) : ;;$/m)
    expect(reusableSrc).toContain('unknown release.model=')
  })

  it('plumbs the base ref and the run ref into the Gate step (#374)', () => {
    // The exec suite supplies both itself, so it structurally cannot observe
    // these lines going missing. This is the one silent-degradation mode
    // execution cannot reach.
    expect(reusableSrc).toMatch(/^\s+PR_BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}$/m)
    expect(reusableSrc).toMatch(/^\s+RUN_REF: \$\{\{ github\.ref \}\}$/m)
  })

  it('refuses to report a verdict for a dispatch off the protected branch (#374 B3)', () => {
    expect(reusableSrc).toContain('is not the protected branch')
    const guardIdx = reusableSrc.indexOf('RUN_REF:-}" != "refs/heads/main"')
    const vfilesIdx = reusableSrc.indexOf('version_files empty')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(vfilesIdx) // must precede the early green it protects
  })
```

`:51-53`, `:55-59`, `:62-64`, `:69-118`, `:124-138`, `:151-171` are **unchanged**. In particular `:128-134` (`not.toMatch(/git merge-base --is-ancestor/)`, D10) and `:136-138` (`toMatch(/bash "\$PRICE"/)`) stay pointed at `reusableSrc` and stay load-bearing, because **the logic never leaves the YAML** in this design. `:162`'s hardened `[^!]= "trunk" \]` anchor still discriminates: the new condition is `[ "$MODEL" = "trunk" ]` (space before `=`).

### 1.8 NEW `release-gate-exec.test.ts`

The gate logic stays inside the YAML block scalar, so the suite extracts and executes **the shipped bytes**. The extractor derives the indent from the first non-empty body line (the actual YAML block-scalar rule) — not a hardcoded column count, so it survives a re-indent.

```ts
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const REUSABLE = fileURLToPath(
  new URL('../../../../../.github/workflows/release-consistency.yml', import.meta.url),
)

/** Extract a step's `run: |` body. Indent is taken from the first non-empty line
 *  (YAML block-scalar rule, no explicit indicator), so a re-indent cannot rot it. */
function extractRunBlock(yaml: string, stepName: string): string {
  const lines = yaml.split('\n')
  const nameIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`)
  if (nameIdx < 0) throw new Error(`step "${stepName}" not found`)
  const runIdx = lines.findIndex((l, i) => i > nameIdx && /^\s*run: \|\s*$/.test(l))
  if (runIdx < 0) throw new Error(`no block-scalar run: under "${stepName}"`)
  const body: string[] = []
  let indent = -1
  for (let i = runIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') { body.push(''); continue }
    const lead = l.length - l.trimStart().length
    if (indent < 0) indent = lead
    if (lead < indent) break
    body.push(l.slice(indent))
  }
  return `${body.join('\n').replace(/\s+$/, '')}\n`
}

/** #374 O4 — the gate needs a YAML reader. Loud under CI (a silently skipped
 *  gate is an illusory gate, #371 B5), skipped locally. */
function hasYamlReader(): boolean {
  if (spawnSync('yq', ['--version']).status === 0) return true
  return spawnSync('python3', ['-c', 'import yaml']).status === 0
}

const GATE = extractRunBlock(fs.readFileSync(REUSABLE, 'utf8'), 'Gate')
let GATE_SH: string

beforeAll(() => {
  if (!hasYamlReader() && process.env.CI) {
    throw new Error('release-gate-exec: neither yq nor python3+PyYAML present under CI — the gate suite would silently skip')
  }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-sh-'))
  GATE_SH = path.join(d, 'gate.sh')
  fs.writeFileSync(GATE_SH, GATE)
})

/** Strip every GIT_* location var so an ambient GIT_DIR (pre-push hook) cannot
 *  redirect fixture commits into the real worktree. Mirrors auto-release.test.ts. */
function gitEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) e[k] = v
  e.GIT_CONFIG_GLOBAL = '/dev/null'
  e.GIT_CONFIG_SYSTEM = '/dev/null'
  e.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z'
  e.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z'
  return e
}

interface Fixture {
  baseStack: string | null      // .claude/stack.yml content on main, null = absent
  headStack?: string | null     // on the head branch (default: same as base)
  baseTags?: string[]           // e.g. ['fixture/v1.2.3']
  headCommits?: string[]        // conventional subjects
  changelog?: string            // merge-tree CHANGELOG.md
  headBranch?: string           // default 'staging'
  shadowTag?: boolean           // create a tag literally named `origin/main` (B1)
}

function prFixture(f: Fixture): { repo: string; headSha: string } { /* see below */ }

function runGate(repo: string, env: Record<string, string>) {
  return spawnSync('bash', [GATE_SH], {
    cwd: repo, encoding: 'utf8', env: { ...gitEnv(), ...env },
  })
}
```

`prFixture` must, in order: `git init`; write `baseStack` + `CHANGELOG.md`; commit on `main`; `git tag` each of `baseTags`; `git update-ref refs/remotes/origin/main <main tip>`; `git checkout -b <headBranch>`; write `headStack`; one empty commit per `headCommits`; record `headSha`; `git checkout main && git merge --no-ff --no-commit <headBranch>` (leaving the merge tree in the worktree, i.e. `refs/pull/N/merge`); if `shadowTag`, `git tag origin/main <head branch tip>`.

**Cases** (`PR_TITLE` and the CHANGELOG heading are the witnesses; `EVENT_NAME=pull_request` unless stated):

| id | fixture | env | assert |
|---|---|---|---|
| **G1** | base `{model: staging-train, component: fixture}` + tag `fixture/v1.2.3`; head sets `model: trunk`, one `fix: x`; CHANGELOG `## 9.9.9` | `PR_BASE_REF=main PR_HEAD_REF=staging PR_TITLE='chore: release 9.9.9'` | `status===1`, stderr `/three-way DISAGREEMENT/`, stdout **not** `/trunk mode/` |
| **G2** | as G1 but base honest (`staging-train` on both branches) **and** `shadowTag: true` pointing at a commit whose stack says `model: trunk` | same | `status===1`; stdout **not** `/trunk mode/`. **This is the B1 falsifier.** |
| **G3** | base component `fixture` + tag `fixture/v1.2.3`; head renames to `renamed`; title **and** CHANGELOG both `0.1.0` (witnesses mutually consistent — exactly what makes today's failure a silent green through the exit-10 branch) | `PR_HEAD_REF=staging PR_TITLE='chore: release 0.1.0'` | `status===1`, stderr `/release\.component differs between base and head/` |
| **G4a** | `baseStack: null` | `PR_BASE_REF=main PR_HEAD_REF=feature/x` | `status===0`, stdout `/not-a-promote/` — **anti-over-correction**: a repo with no policy is not bricked |
| **G4b** | `baseStack: null`, head adds `{model: trunk, component: fixture}` | `PR_HEAD_REF=staging` | `status===1`, stdout `/no \.claude\/stack\.yml on refs\/remotes\/origin\/main — assuming release\.model=staging-train/`, stderr `/release\.component missing/`, stdout **not** `/trunk mode/` |
| **G5** | base stack is `"release:\n<<<<<<< HEAD\n"` (merge-conflict markers) | `PR_HEAD_REF=feature/x` | `status===0` — **the repo-bricking falsifier (O1)**; also stdout `/unparseable/` |
| **G6** | base `{model: trunk, component: fixture}` | `PR_HEAD_REF=feature/x` | `status===0`, stdout `/trunk mode \(from refs\/remotes\/origin\/main\)/` — regression guard for this repo's own PRs |
| **G7** | base stack with **no `release:` block at all** (verified real state of factory + live) | (a) `PR_HEAD_REF=feature/x` → `0`; (b) `PR_HEAD_REF=staging` → `1` on missing component | fleet default resolves staging-train, never trunk |
| **G8** | base `model: trunk-lite` | (a) `feature/x` → `0` + stdout `/unknown release\.model='trunk-lite'/`; (b) `staging` with disagreeing witnesses → `1` | unknown coerces, warns, never red |
| **G9** | any fixture | `EVENT_NAME=workflow_dispatch RUN_REF=refs/heads/staging PUSH_SHA=<head tip>` **and** base `version_files: []` | `status===1`, stderr `/is not the protected branch/` — **the B3 falsifier.** Companion: `RUN_REF=refs/heads/main` → `0` |
| **G10** | base `version_files: ['pkg.json']` + tag `fixture/v1.2.3` | `EVENT_NAME=push RUN_REF=refs/heads/main PUSH_SHA=<main tip>` | pkg.json `1.2.2` → `1` (`/is BEHIND/`); `1.2.3` → `0`; `1.3.0` → `0`; `version_files: []` → `0` — push path unchanged |

### 1.9 Falsification procedure — #374

Each falsifier is a **one-line `sed` revert applied to a copy of the extracted script**, isolating exactly one change. Run `bun run test` after each.

| id | mutation | expected |
|---|---|---|
| **F-A** (config authority) | `sed -i 's|BASE_STACK=$(git show "${BASE}:${STACK}" 2>/dev/null \|\| true)|BASE_STACK=$(cat "${STACK}" 2>/dev/null \|\| true)|'` | **G1, G3, G4b RED.** G4a/G5/G6/G7/G9/G10 stay green → proves isolation. G1 goes red because the merge tree says `trunk` → early exit 0. G3 goes red because the head component finds zero `renamed/v*` tags → `price.sh` exit 10 → witness-only agreement → 0. |
| **F-B** (ref ambiguity) | `sed -i 's\|BASE="refs/remotes/origin/${BASE_REF}"\|BASE="origin/${BASE_REF}"\|'` | **G2 RED only.** Everything else green. This is the proof that the fully-qualified form is load-bearing and not cosmetic. |
| **F-C** (fail-closed default) | `sed -i '0,/MODEL="staging-train"/s//MODEL="trunk"/'` | **G4b RED**; G1/G3 green. This falsifier is *impossible against the current code* — today's default is emergent from `""` losing a string comparison, so there is no line to flip. |
| **F-D** (never-red-on-ambiguity) | delete the whole `case "$MODEL" in … esac` block | **G5 and G8a RED**; G8b stays green (unknown already ≠ trunk), which is precisely why G8b alone is insufficient and the pair is required. |
| **F-E** (dispatch guard) | delete the `RUN_REF` guard | **G9 RED**; all others green. |
| **F-F** (malformed non-fatal) | `sed -i 's\| 2>/dev/null$\|\|'` on the two reader lines, and drop `\|\| true` at the two base call sites | **G5 RED** (script aborts under `set -euo pipefail` — reproduced independently: bare assignment from a malformed file gave rc=1 and never reached the next statement). |

**Declared negative controls** (green before *and* after; not evidence, present to catch over-correction): G4a, G6, G7, G10. Mutation-check them by making exactly those wrong edits (hoist a missing-policy `exit 1` above the scope gate → G4a red; invert the trunk test → G6 red; default to trunk → G7 red; route the push path through `git show` → G10 red).

**Not falsifiable by test, stated plainly:** the `PR_BASE_REF`/`RUN_REF` env plumbing (§1.7 covers it textually — the exec suite supplies both itself and structurally cannot see them disappear).

---

## PART 2 — #375: explicit path contract + fail-closed resolvability at the write boundary

Four layers. **L4 (release-consistency graft) is cut** — see P1.

### 2.1 `plugins/dev-core/skills/shared/workflows/workflow-types.ts` *(copy-synced)*

**Do not touch `normalizeWorkflowOpts`.** Interface only:

```ts
export interface WorkflowRelease {
  model: ReleaseModel
  /** `<component>` half of the `<component>/vX.Y.Z` tag — baked into auto-release.yml. */
  component: string
  /** Repo-relative path to auto-release.sh AS RESOLVED FROM THE TARGET REPO'S
   *  checkout root. dev-core ships as a Claude Code marketplace plugin, not an npm
   *  package, and a GitHub Actions runner has no plugin cache — so the script AND
   *  its closure (price.sh, lib/finalize.ts) must be COMMITTED to the repo the
   *  workflow is installed in. Absent -> DEFAULT_RELEASE_SCRIPT_PATH, which keeps
   *  the emitted bytes byte-identical for roxabi-plugins. #375 */
  scriptPath?: string
}
```

> `normalizeWorkflowOpts` is deliberately unchanged, so `norm.release` remains `{model, component}` and `workflows.test.ts:225,236` stay green. `scriptPath` rides through untouched and is resolved at point of use.

### 2.2 `plugins/dev-core/skills/shared/workflows/workflow-generators.ts` *(copy-synced)*

Add near the top of the generator section (module is pure — no I/O; note it **already** throws at `:180`, so throwing is established precedent, not a contract break):

```ts
export const DEFAULT_RELEASE_SCRIPT_PATH = 'plugins/dev-core/skills/promote/auto-release.sh'

/** Resolve the release script path without touching normalizeWorkflowOpts.
 *  `||` not `??` so an empty string falls back rather than emitting an invalid path. */
export function resolveReleaseScriptPath(release?: { scriptPath?: string }): string {
  return release?.scriptPath || DEFAULT_RELEASE_SCRIPT_PATH
}

/** Transitive dependency closure of auto-release.sh, derived from its path.
 *  auto-release.sh resolves its dependencies through `$HERE` — its own dirname
 *  (auto-release.sh:40) — at :56, :64 (price.sh) and :98 (bun run lib/finalize.ts),
 *  so all three must be co-located with `lib/` preserved. VERIFIED TERMINAL:
 *  price.sh has no $HERE/source/bun/node refs and finalize.ts has zero imports, so
 *  the closure stops at 3 files — no package.json, no node_modules, only `bun`
 *  (already provisioned by oven-sh/setup-bun in the emitted workflow). #375 */
export function autoReleaseClosure(scriptPath: string): string[] {
  const here = scriptPath.slice(0, scriptPath.lastIndexOf('/'))
  return [scriptPath, `${here}/price.sh`, `${here}/lib/finalize.ts`]
}

/** scriptPath is interpolated into a `run:` line in a `contents: write` job — the
 *  same injection sink the component regex already guards. Reject anything a shell
 *  could expand, anything escaping the workspace, and any leading `-` (bash would
 *  parse it as an option bundle). The leading class excludes `/`, blocking absolutes.
 *
 *  COUPLED DECISION: the emitted `run:` line leaves the path UNQUOTED, which is safe
 *  ONLY while this class excludes whitespace and every metacharacter. Relaxing it
 *  reopens the sink with no second line of defence — add quoting in the same change
 *  and accept the byte delta. Guarded by T4. */
export function assertReleaseScriptPath(p: string): void {
  const ok =
    /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(p) &&
    !p.includes('..') && !p.includes('//') && p.endsWith('.sh')
  if (!ok) {
    throw new Error(
      `generateAutoReleaseYml: release.scriptPath must be a repo-relative *.sh path matching /^[A-Za-z0-9._-][A-Za-z0-9._\\/-]*$/, with no '..' and no '//' (got ${JSON.stringify(p)}).`,
    )
  }
}
```

Inside `generateAutoReleaseYml`, after the existing component check:

```ts
  const scriptPath = resolveReleaseScriptPath(opts.release)
  assertReleaseScriptPath(scriptPath)
```

Replace **both** literals — a partial edit leaves the header comment lying about the run line:
- `:193` → `` # ${scriptPath}. Never inline that logic here: ``
- `:237` → `` `        run: bash ${scriptPath} "$COMPONENT" "\${{ github.sha }}"` ``
- JSDoc at `:166-168` also names the literal — update (TS comment, zero byte impact).

Extend `workflowOptsFromStack` (`:509-524`):
```ts
  release?: { model?: string; component?: string; scriptPath?: string }
  // …
        scriptPath: stack.release.scriptPath || undefined,
```

### 2.3 `plugins/dev-core/skills/shared/workflows/workflow-push.ts` *(copy-synced)*

```ts
/** Existence of `path` in the TARGET repo at `branch` — the same contents-API
 *  primitive pushWorkflowFile already uses (:44-51), now with `?ref=`. TRI-STATE on
 *  purpose: `null` = could not determine (5xx, network throw, 403 from a token
 *  without contents:read). NEVER collapse `null` into `true` — reading an
 *  indeterminate answer as present is the fail-open bug this gate exists to prevent. */
async function remoteExists(
  token: string, owner: string, repo: string, branch: string, p: string,
): Promise<boolean | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${p}?ref=${encodeURIComponent(branch)}`
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (res.ok) return true
    if (res.status === 404) return false
    return null
  } catch {
    return null
  }
}

/** Fail-closed resolvability gate for the trunk release closure (#375).
 *  Checks the WHOLE closure: a consumer who vendors only auto-release.sh gets exit
 *  127 at price.sh one frame later, so an entry-script-only check is fail-open.
 *  Both `false` (confirmed absent) and `null` (unverifiable) refuse. */
export async function assertReleaseClosureResolvable(
  scriptPath: string,
  exists: (p: string) => Promise<boolean | null>,
): Promise<void> {
  const closure = autoReleaseClosure(scriptPath)
  const missing: string[] = []
  const unknown: string[] = []
  for (const p of closure) {
    const r = await exists(p)
    if (r === false) missing.push(p)
    else if (r === null) unknown.push(p)
  }
  if (!missing.length && !unknown.length) return
  throw new Error(
    [
      'REFUSE: not emitting auto-release.yml — the trunk release closure is not resolvable in the target repo.',
      missing.length ? `  absent:       ${missing.join(', ')}` : '',
      unknown.length ? `  unverifiable: ${unknown.join(', ')} (5xx / network / token lacks contents:read)` : '',
      '',
      'auto-release.yml runs `bash <scriptPath>` from the repo CHECKOUT. dev-core ships as a',
      'Claude Code marketplace plugin, not an npm package, and a GitHub Actions runner has no',
      'plugin cache — so all three files must be COMMITTED to this repo. Either vendor the',
      `closure (${closure.join(', ')}) and point release.script_path at it, or leave`,
      'release.model at staging-train. dev-core will never fetch it at release time (ADR-017).',
    ].filter(Boolean).join('\n'),
  )
}
```

Gate **before any write / any push**, and — per P10 — **before `mkdirSync`**:

```ts
// writeWorkflows — FIRST statement, above fs.mkdirSync
const o = normalizeWorkflowOpts(opts)
if (o.release.model === 'trunk') {
  const fsm = require('node:fs')
  await assertReleaseClosureResolvable(resolveReleaseScriptPath(o.release), async (p) => fsm.existsSync(p))
}
fsm.mkdirSync('.github/workflows', { recursive: true })
```
```ts
// pushWorkflows — after `const o = normalizeWorkflowOpts(opts)`, before the write loop
if (o.release.model === 'trunk') {
  const token = await getToken()   // hoisted — one mint, not one per closure file
  await assertReleaseClosureResolvable(
    resolveReleaseScriptPath(o.release),
    (p) => remoteExists(token, owner, repo, branch, p),
  )
}
```
Refusal is atomic in both: `workflowFileSet(o)` is fully evaluated in the `for…of` initializer, so nothing is written or pushed. `workflowFileSet`'s signature stays `Required<WorkflowOpts>` — **no type churn**.

### 2.4 `plugins/dev-core/skills/checkup/workflow-drift.ts`

Thread `scriptPath` at `:55-57`, then replace the N11 block (`:106-125`):

```ts
const arPath = join('.github/workflows', 'auto-release.yml')
const arExists = existsSync(arPath)
let expected = ''
let genError = ''
if (arExists) {
  try { expected = generateAutoReleaseYml(opts) }
  catch (e) { genError = e instanceof Error ? e.message : String(e) }
}

if (!arExists) {
  checks.push({
    name: 'release-model:auto-release',
    status: 'fail',
    detail:
      'release.model is trunk but .github/workflows/auto-release.yml is absent. NOTE: /ci-setup does NOT generate it (the init CLI exposes no release flag) — generate it with writeWorkflows({ ...opts, release }), then satisfy release-model:auto-release-closure below.',
  })
} else if (genError) {
  // A reportable misconfiguration must be a check, not a crash. workflowOptsFromStack
  // maps `component ?? ''` and the generator throws on '' — and doctor.ts:49 calls
  // checkWorkflowDrift() unguarded inside an array literal, so this throw took down
  // the ENTIRE /checkup run for a component-less trunk repo that HAS the workflow.
  checks.push({
    name: 'release-model:auto-release',
    status: 'fail',
    detail: `release.model is trunk but auto-release.yml cannot be generated — ${genError}`,
  })
} else if (digest(readFileSync(arPath, 'utf8')) === digest(expected)) {
  checks.push({ name: 'release-model:auto-release', status: 'pass', detail: 'matches generator' })
} else {
  checks.push({
    name: 'release-model:auto-release',
    status: 'fail',
    detail: 'auto-release.yml differs from the generator (drift) — regenerate from the generator, never hand-edit (N11).',
  })
}

// N11b (#375) — the workflow runs `bash <scriptPath>` from the CHECKOUT. Existence of
// the workflow says NOTHING about resolvability of what it invokes: a repo that
// hand-copied auto-release.yml passes N11 byte-identically and still dies exit 127.
// Whole closure — an entry-script-only check is fail-open.
if (!genError) {
  const absent = autoReleaseClosure(resolveReleaseScriptPath(opts.release)).filter((p) => !existsSync(p))
  checks.push(
    absent.length === 0
      ? { name: 'release-model:auto-release-closure', status: 'pass', detail: 'release script closure present in checkout' }
      : {
          name: 'release-model:auto-release-closure',
          status: 'fail',
          detail: `auto-release.yml invokes files absent from this repo: ${absent.join(', ')} — the release job dies exit 127. Vendor the closure and set release.script_path, or set release.model back to staging-train.`,
        },
  )
}
```

Both new checks stay inside the existing `if (stack.release?.model === 'trunk')` guard — staging-train is untouched. The false `run /ci-setup to generate it` text is deleted.

### 2.5 `plugins/dev-core/hooks/lib/parse-stack-yml.cjs` (+ `.d.cts`)

**Not** in `tools/shared-sources.json` (verified) — no sync needed.

```js
  const scriptPathMatch = block.match(/^\s+script_path:\s*(\S+)/m)
  return {
    model: modelMatch ? modelMatch[1] : null,
    component: componentMatch ? componentMatch[1] : null,
    scriptPath: scriptPathMatch ? scriptPathMatch[1] : null,
  }
```
Update the `Expected shape:` example (`:238-240`) and `@returns` (`:249`). `.d.cts`: `StackRelease` gains `scriptPath: string | null`.

### 2.6 `plugins/dev-core/skills/checkup/doctor-shared.ts`

`:95` → `release: { model: string; component: string | null; scriptPath: string | null } | null`
`:114-116` → add `scriptPath: stack.release.scriptPath`.
The `catch` fallback (`release: null`) is unchanged — an unreadable stack.yml degrades to staging-train, so N11/N11b stay inert rather than crashing.

### 2.7 `plugins/dev-core/stack.yml.example` — **the shipped template** (P2)

Preserve `class:` and `component: null` verbatim; append one commented key + note after `:75`:

```yaml
  # trunk ONLY: auto-release.yml runs this script from the repo CHECKOUT. dev-core is a
  # Claude Code marketplace plugin, not an npm package, and a CI runner has no plugin
  # cache — so this file AND its closure must be COMMITTED to your repo, co-located,
  # with lib/ preserved:  <dir>/auto-release.sh  <dir>/price.sh  <dir>/lib/finalize.ts
  # Runner also needs: bash, git, gh, bun, coreutils. /checkup N11b verifies presence.
  # script_path: plugins/dev-core/skills/promote/auto-release.sh
```
Do **not** touch `.claude/stack.yml.example` (local artifact, ungoverned).

### 2.8 Docs

`promote/SKILL.md:374` — replace the false one-value-flip claim with the trunk-in-a-consumer-repo requirements (model + non-empty component; closure committed; `script_path` if vendored elsewhere; writers refuse, N11b fails; never a runtime fetch → ADR-017).

`ci-setup/cookbooks/workflows.md` — one honest line under the Standard set (`:16`): `auto-release.yml` is **not** in this set and is **not** emitted by `/ci-setup` (step 3's auto-detect never reads `release.*`, the init CLI has no release flag).

### 2.9 NEW `docs/architecture/adr/017-release-closure-resolved-from-checkout-never-fetched-at-runtime.md`

Plain `.md` (ADR-016 bans new `.mdx`). Title = the contract. Records the permanent rejection of runtime fetch (cross-repo trust edge into a `contents: write` job holding an App token; a SHA pin inside a `.ts` shell string is exactly the pin Dependabot cannot see — prior incident: two nonexistent action SHAs; fail-open by construction) and of dev-core auto-vendoring (N unsynced copies outside this repo's CI reach). Add the ADR-archive row to the release/workflow domain page.

### 2.10 Tests — #375

| id | file | content |
|---|---|---|
| **T1** | `shared/__tests__/workflows.test.ts` | empty tmp cwd + trunk opts → `await expect(writeWorkflows(...)).rejects.toThrow(/closure is not resolvable/)` **and** `expect(fs.existsSync('.github/workflows')).toBe(false)` (atomic — gate precedes `mkdirSync`) |
| **T1b** | same | **rewrite of the existing `:404` test.** Create `plugins/dev-core/skills/promote/{auto-release.sh,price.sh,lib/finalize.ts}` under tmp **first**, then assert `{file:'auto-release.yml',status:'created'}` as today. Two fixtures, opposite verdicts, one assertion. |
| **T2** | same | only `auto-release.sh` vendored → still rejects; message names `price.sh` **and** `lib/finalize.ts`. **Kills the naive entry-only fix.** |
| **T3** | same | `assertReleaseClosureResolvable(path, async () => null)` → rejects `/unverifiable/`; stub `fetch` reject and `{ok:false,status:500}` → both refuse |
| **T4** | same | injection corpus against `generateAutoReleaseYml`: `'../../etc/evil.sh'`, `'/abs/evil.sh'`, `'a b.sh'`, `'x.sh; curl evil\|sh'`, `'$(id).sh'`, `` '`id`.sh' ``, `'-c.sh'`, `'a//b.sh'`, `'x.txt'` all throw; `''` does **not** throw and emits the default; `'ci/release/auto-release.sh'` does not throw and appears verbatim in the `run:` line |
| **T5** | `checkup/__tests__/workflow-drift.test.ts` | fixture `release: {model: trunk}` (no component) **and** a byte-arbitrary `auto-release.yml` on disk → `expect(() => checkWorkflowDrift()).not.toThrow()` and `release-model:auto-release` is `fail` with the generator message |
| **T6** | same | trunk fixture with a **byte-correct** `auto-release.yml` but no closure on disk → `auto-release` = `pass`, `auto-release-closure` = `fail` (the two checks are orthogonal) |
| **T7** | `promote/__tests__/auto-release.test.ts` | read `auto-release.sh`, extract `/\$\{HERE\}\/([^\s"']+)/g`, assert the set equals `autoReleaseClosure('d/auto-release.sh').slice(1)` de-prefixed. **Labelled: forward regression guard, green on implementation.** |
| **T9** | `shared/__tests__/parse-stack-yml.test.ts` | `script_path: ci/release/auto-release.sh  # comment` → `'ci/release/auto-release.sh'`; key absent → `null`; no block → `release === null`. **Plus update `:20` type and the three `toEqual` at `:154,:159,:174`.** |
| **T10** | `dev-init/skills/init/__tests__/workflows.test.ts` | add the T1 refusal case (that file has **zero** trunk coverage today). **Labelled: coverage parity, not falsification.** |
| **T-R** | `shared/__tests__/auto-release-actionlint.test.ts` | extract the `run:` path from the **committed** `.github/workflows/auto-release.yml` and assert `existsSync(join(repoRoot, extracted))`. This is the only #375 control that runs in CI (verified: `ci.yml` has no checkup step). |
| **T-S** | same | assert this repo's `.claude/stack.yml` declares no `release.script_path` — the hardcoded `trunkOpts` at `:24` and N11's `workflowOptsFromStack` would otherwise become mutually unsatisfiable (P7) |
| **T-D** | `promote/__tests__/release-model-docs.test.ts` | sentinel: `expect(example).toContain('script_path')` — anti-rot on the **shipped** template |

### 2.11 Falsification procedure — #375

Baseline first: `bun run test` → **47 files, 825 passed, 4 skipped**. Any red after adding tests is attributable to them.

- **T1 / T2 / T10** — RED because no gate exists: `writeWorkflows` reaches `workflow-push.ts:111` and writes the file, so `rejects.toThrow` fails on "promise resolved". Reproduce now with `git stash` (source only, keep tests).
- **T2 additionally discriminates against the wrong fix of this design**: implement an entry-script-only guard → T1 goes green, **T2 stays red**. Strongest form of falsification available here.
- **T3** — RED: `assertReleaseClosureResolvable` cannot be imported. After implementing, mutate `if (r === null) unknown.push(p)` → `continue`: **T3 must go red while T1/T2 stay green**, proving the tri-state is load-bearing.
- **T4** — RED: `scriptPath` is not a field today; an extra opts key is ignored and valid YAML with the hardcoded path is returned, so `toThrow()` fails on every corpus entry and the positive case fails too (that *is* the bug).
- **T5** — RED. Verified by execution against the real `checkWorkflowDrift`: with `auto-release.yml` present and `component: ''`, it **THREW** `generateAutoReleaseYml: release.component must match /^[A-Za-z0-9._-]+$/ (got "")`. (Verified equally: **without** the workflow on disk it does **not** throw — which is why the design's original T5 fixture was wrong and is corrected here.)
- **T6** — RED: `release-model:auto-release-closure` does not exist, so `.status` is `undefined`.
- **T7** — GREEN on implementation; falsifiable **only by mutation**: add `bash "${HERE}/preflight.sh"` to a scratch copy of `auto-release.sh` and point the test at it → the extracted set gains `preflight.sh`, `autoReleaseClosure` does not, `toEqual` fails. Stated as a forward guard, not evidence.
- **T9** — RED: `parseRelease` returns `{model, component}` only (read at `parse-stack-yml.cjs:251-264`).
- **T-R / T-S / T-D** — T-R is green today (roxabi-plugins vendors dev-core) and is a forward guard for the class; T-S/T-D are RED only if someone later introduces the divergence. Labelled as such.

**Byte-delta assertion:** `DEFAULT_RELEASE_SCRIPT_PATH` is character-identical to the current literal at `:193`/`:237`, and this repo's `.claude/stack.yml` sets no `script_path` → `.github/workflows/auto-release.yml` needs **no regeneration**. The proof is mechanical: `auto-release-actionlint.test.ts:84` compares the committed file to the generator on every `bun run test`, so an off-by-one-character default goes red immediately. No separate verification step.

---

## PART 3 — Should either issue be fixed as filed?

**#374 — NO, not as filed.** Fix the config-authority defect it names (that part is correct and worth doing), but the issue's framing understates the surface in one direction and overstates the payoff in the other:

- The gate is **100% inert org-wide** — one ruleset on roxabi-plugins requiring only `ci`, zero caller stubs anywhere in the org — and **structurally non-functional downstream**: `price.sh` does not exist in `roxabi-factory` or `roxabi-live` (dev-core is a `~/.claude` plugin, never vendored) and `provision-release-gate.sh` vendors nothing, so `bash "$PRICE"` would be exit 127 on every promote PR.
- Two holes strictly larger than the filed one remain open after any config-read fix: the head-supplied `price.sh` is executed as the gate's own authority (`:149`), and the caller stub itself is head-editable. Neither is closable inside this change without adding a job-level cross-repo dependency in front of the in-job early greens — which would deadlock `main` in every provisioned repo.

So: land the small, correct, self-contained fix in Part 1 (it costs ~90 lines of YAML and adds zero new failure modes), and route the rest to FU-2. **Do not** ship it framed as "the gate is now hardened."

**#375 — YES, fixed as scoped in Part 2, but the issue's option (b)/(c) framing should be closed off in an ADR.** The core claim is verified and correct. Two of the issue's premises are wrong and must not be carried into the PR body: the REST path *can* do a path-existence check (`workflow-push.ts:44-51` already does exactly that GET), and the shipped `stack.yml.example` *does* already have a `release:` block. Severity is loud-not-silent: `bash <missing>` → 127 → red job → no release. It never risks a wrong version.

---

## PART 4 — Follow-ups (do NOT fold in)

**FU-1 — `auto-release.yml` `workflow_dispatch` forges releases from any ref. DO THIS FIRST; it is the only LIVE vulnerability in this batch.**
Verified: `auto-release.yml:15` is `workflow_dispatch: {}` with no ref constraint and no job-level `if:`; the job holds `contents: write` + a roxabi-ci App token; `auto-release.sh:40-51` computes `M=$(git rev-parse --verify "${M_REF}^{commit}")` and checks only `PARENT_COUNT -ne 2` — **there is no `merge-base --is-ancestor` anywhere in the script**. Anyone with write access pushes a branch tipped by a merge commit, runs `gh workflow run auto-release.yml --ref that-branch`, and gets a real `roxabi-plugins/vX.Y.Z` tag + GitHub Release cut from unreviewed commits. Fix, in `generateAutoReleaseYml` **plus** a regenerated `.github/workflows/auto-release.yml` in the same commit (N11 byte gate + `auto-release-actionlint.test.ts:84` both move together automatically; `trunkOpts` needs no change):
```yaml
  auto-release:
    if: github.ref == 'refs/heads/main'
```
belt-and-braces in `auto-release.sh` after the parent-count check:
```bash
git merge-base --is-ancestor "$M" origin/main 2>/dev/null || {
  echo "REFUSE: $M is not reachable from origin/main — releases are cut from main only." >&2; exit 1; }
```

**FU-2 — Make the release-consistency gate actually provisionable.** One work item, because every piece blocks the same single future event (the first real provision): pin the deriver to the reusable's own commit via `job.workflow_repository`/`job.workflow_sha` **as a conditional step** (so a failed cross-repo clone cannot fail the job in front of the early greens); a stub-integrity control (ruleset `file_path_restriction` on `.github/workflows/**`, CODEOWNERS, or org required-workflows) for B2; the `[ -f "$PRICE" ]` guard placed **lazily** immediately before each `bash "$PRICE"` at `:149`/`:210`, never above the early greens; whether a `provision-release-gate.sh` policy preflight should exist at all and how factory/live (no `release:` block on either branch) onboard; and `DEFAULT_REF` going stale (`roxabi-plugins/v0.5.0` hardcoded at `:43` while trunk mode cuts a new tag on every merge).

**FU-3 — `context-lint.yml:29` is `actions/checkout@v6`**, the repo's only unpinned action tag, invisible to `tools/verify-action-pins.ts` (`EMITTER_PATHS` = generator sources only) and to `validate_plugins.py` (no workflow check). Fix is arguably to extend the pin-verifier's scope to `.github/workflows/*.yml` — a real CI-gate change.

**FU-4 — Component divergence.** The gate reads `release.component` from `stack.yml` at runtime while `auto-release.yml:57` hardcodes `COMPONENT: roxabi-plugins` (byte-gated by N11, so it only changes via regeneration). A rename silently desynchronises gate from tagger.

**FU-5 — Productise consumer trunk** (only if a real consumer trunk repo appears): `--release-model` / `--release-component` / `--release-script-path` in `init.ts:58-101`, the `/ci-setup` cookbook, and a vendoring helper.

**FU-6 — `.claude/stack.yml` header contradiction.** The file is tracked (`git ls-files .claude/`) while its own header says "DO NOT commit this file." Tracking is what makes it PR-modifiable and therefore makes #374 exploitable at all. Decide which is the drift.

---

## PART 5 — Order of operations

```
FU-1  auto-release.yml dispatch guard          [separate PR, FIRST — live vuln]
      edit generateAutoReleaseYml + auto-release.sh
      bun run sync:shared                      # workflow-generators.ts is copy-synced
      /ci-setup  (or regenerate by hand)  ->  .github/workflows/auto-release.yml   [N11 REQUIRED]
      python3 tools/validate_plugins.py --check shared-sources-sync
      bun run test                             # actionlint byte gate re-passes

#374  [separate PR, --base main, merge-commit]
  1.  edit .github/workflows/release-consistency.yml   (§1.1-§1.5)
  2.  edit plugins/dev-core/skills/promote/SKILL.md    (§1.6)
  3.  retarget release-gate.test.ts                    (§1.7)
  4.  add release-gate-exec.test.ts                    (§1.8)
  5.  bun run lint && bun run typecheck && bun run test
  6.  run falsifiers F-A..F-F (§1.9); record each RED in the PR body
      -- NO sync:shared  (no file in tools/shared-sources.json is touched)
      -- NO N11          (release-consistency.yml is hand-written; verified no generator emits it)

#375  [separate PR, --base main, merge-commit]
  1.  workflow-types.ts        (interface only — do NOT touch normalizeWorkflowOpts)
  2.  workflow-generators.ts   (constant + 2 helpers + both literals + workflowOptsFromStack + JSDoc)
  3.  workflow-push.ts         (remoteExists + gate in BOTH writers, above mkdirSync)
  4.  bun run sync:shared                                          # 3 manifest entries
  5.  python3 tools/validate_plugins.py --check shared-sources-sync
  6.  parse-stack-yml.cjs + .d.cts    (NOT in the manifest — no sync)
  7.  doctor-shared.ts, workflow-drift.ts
  8.  plugins/dev-core/stack.yml.example    <-- the SHIPPED one, NOT .claude/
  9.  promote/SKILL.md, ci-setup/cookbooks/workflows.md, ADR-017 (.md)
 10.  tests: workflows.test.ts (T1,T1b-rewrite,T2,T3,T4), workflow-drift.test.ts (T5,T6),
      auto-release.test.ts (T7), parse-stack-yml.test.ts (T9 + :20,:154,:159,:174),
      dev-init workflows.test.ts (T10), auto-release-actionlint.test.ts (T-R,T-S),
      release-model-docs.test.ts (T-D)
 11.  bun run lint && bun run typecheck && bun run test
 12.  falsification: git stash (source only, keep tests) -> confirm T1,T2,T3,T4,T5,T6,T9,T10
      fail FOR THE STATED REASON (read each message; a typo failure proves nothing)
      -> git stash pop -> all green -> run the two mutation probes (T3 null->continue, T7 4th dep)
      -- NO N11          (zero byte delta; the actionlint byte gate proves it on every test run)
```

**Never hand-edit anything under `plugins/dev-init/skills/shared/workflows/`** — `bun run sync:shared` only. And do not add the new `.sh`-free artifacts to `tools/shared-sources.json`; the manifest is `.ts`-only by construction (verified: 20 entries, all `.ts` under `plugins/dev-core/skills/shared/`).