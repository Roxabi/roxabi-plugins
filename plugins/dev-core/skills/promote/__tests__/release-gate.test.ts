import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STACK_YML } from '../../../hooks/lib/contract-paths.cjs'

// The two D15 artifacts under test. Resolved relative to this file (never a
// hardcoded worktree path) so the suite survives the worktree being merged
// away — repo root is five levels up from __tests__/.
//   __tests__ → promote → skills → dev-core → plugins → <repo root>
const REUSABLE_PATH = fileURLToPath(
  new URL('../../../../../.github/workflows/release-consistency.yml', import.meta.url),
)
const PROVISIONER_PATH = fileURLToPath(new URL('../../../../../scripts/provision-release-gate.sh', import.meta.url))

// The one string that must be byte-identical across all three surfaces: the
// reusable job name, the ruleset-required context, and the /R-promote step-1 probe.
const CHECK = 'release-consistency'

const reusableSrc = readFileSync(REUSABLE_PATH, 'utf8')
const provisionerSrc = readFileSync(PROVISIONER_PATH, 'utf8')

// The caller stub is emitted by the provisioner's `render_stub` quoted heredoc
// (`<<'YAML' … YAML`). Extract it verbatim; the `@__REF__` sentinel is a plain
// string inside a `uses:` value, so the block is well-formed YAML as-is.
const heredocMatch = provisionerSrc.match(/<<'YAML'\n([\s\S]*?)\nYAML\n/)
if (!heredocMatch) throw new Error('could not locate the render_stub YAML heredoc in provision-release-gate.sh')
const stubHeredoc = heredocMatch[1]

// Minimal indent-aware reader. The repo ships no YAML library — hooks hand-parse
// (`parse-stack-yml.cjs`) — and these assertions only need the immediate children
// of a top-level mapping key. Returns the 2-space-indented child keys under
// `parent:` (parent may be quoted, e.g. `"on":`, so YAML 1.1 does not coerce it
// to the boolean `true`).
function childKeys(src: string, parent: string): string[] {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^["']?${parent}["']?:\\s*$`).test(l))
  if (start < 0) return []
  const keys: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) break // next top-level key ends the block
    const m = line.match(/^ {2}(["']?)([A-Za-z_][\w-]*)\1:/)
    if (m) keys.push(m[2])
  }
  return keys
}

// ─── D15: reusable holds logic only (workflow_call) ───────────────────────────

describe('reusable workflow — release-consistency.yml', () => {
  it('is workflow_call-only (the triggers do NOT live here — D15)', () => {
    expect(childKeys(reusableSrc, 'on')).toEqual(['workflow_call'])
  })

  it('names its single job the required-check context, byte-identical', () => {
    expect(childKeys(reusableSrc, 'jobs')).toContain(CHECK)
    // The job's explicit `name:` is the reported check-run context — byte-for-byte,
    // no adjacent whitespace/case drift.
    expect(reusableSrc).toMatch(/^ {4}name: release-consistency$/m)
  })

  it('checks out full history + tags (fetch-depth: 0 — the shallow-clone-green trap, D15e)', () => {
    expect(reusableSrc).toMatch(/fetch-depth:\s*0\b/)
  })
})

// ─── D15: the caller stub owns the triggers ───────────────────────────────────

describe('provisioner caller-stub heredoc — triggers live in the STUB', () => {
  it('owns both pull_request AND push triggers (the D15 point)', () => {
    const onKeys = childKeys(stubHeredoc, 'on')
    expect(onKeys).toContain('pull_request')
    expect(onKeys).toContain('push')
  })

  it('places those triggers in the stub, not in the reusable workflow', () => {
    const reusableOnKeys = childKeys(reusableSrc, 'on')
    expect(reusableOnKeys).not.toContain('pull_request')
    expect(reusableOnKeys).not.toContain('push')
  })

  it('names its job the same required-check context as the reusable workflow', () => {
    expect(childKeys(stubHeredoc, 'jobs')).toContain(CHECK)
  })
})

// ─── D15: check-name identity across all three surfaces ───────────────────────

describe('check-name identity', () => {
  it('reusable job name === provisioner-required context === "release-consistency"', () => {
    // Surface 1: reusable job name (asserted textually above; assert its presence here too).
    expect(reusableSrc).toMatch(/^ {4}name: release-consistency$/m)
    // Surface 2: the context the provisioner requires — the JOB_NAME constant,
    // wired into the ruleset body as `--arg ctx "$JOB_NAME"` → `context: $ctx`.
    const jobNameConst = provisionerSrc.match(/JOB_NAME="([^"]*)"/)?.[1]
    expect(jobNameConst).toBe(CHECK)
    expect(provisionerSrc).toContain('--arg ctx "$JOB_NAME"')
    expect(provisionerSrc).toMatch(/context:\s*\$ctx/)
  })
})

// ─── Provisioner properties: idempotent + reversible ──────────────────────────

describe('provisioner — provision-release-gate.sh', () => {
  it('has a --remove path that reverses both artifacts', () => {
    expect(provisionerSrc).toMatch(/--remove\)\s*REMOVE=1/)
    // The remove branch calls both reversers.
    expect(provisionerSrc).toContain('remove_ruleset')
    expect(provisionerSrc).toContain('remove_stub')
  })

  it('is idempotent — a clean re-run makes no change (blob-sha + name guards)', () => {
    // Stub guard: blob-sha compare short-circuits with a no-change return.
    expect(provisionerSrc).toMatch(/\[ "\$local_sha" = "\$remote_sha" \]/)
    expect(provisionerSrc).toMatch(/up to date/)
    // Ruleset guard: name lookup short-circuits when already present.
    expect(provisionerSrc).toMatch(/already present/)
  })

  it('resolves the pin at provision time instead of hardcoding a tag that rots (#385 item 5)', () => {
    // The old contract WAS the literal `DEFAULT_REF="roxabi-plugins/v5.1.0"`, and
    // that literal is the defect: trunk cuts a new roxabi-plugins/vX.Y.Z on every
    // merge, so a pin written into this file is stale the day after and silently
    // provisions a repo against an old gate. The contract now: no version literal
    // is the default, the newest tag is resolved from the host repo, and an
    // unresolvable pin provisions NOTHING.
    expect(provisionerSrc).not.toMatch(/^DEFAULT_REF=/m)
    expect(provisionerSrc).not.toMatch(/^REF="[^"]+"/m)
    expect(provisionerSrc).toMatch(/^REF=""/m)
    expect(provisionerSrc).toMatch(/^resolve_pin\(\) \{/m)
    // Loud, not a fallback: no literal, no branch, nothing provisioned.
    expect(provisionerSrc).toContain('could not resolve a pin')
    expect(provisionerSrc).toContain('does NOT fall back to a hardcoded tag')
  })

  it('rejects a moving ref as a pin — a branch re-points every provisioned stub', () => {
    expect(provisionerSrc).toMatch(/^validate_pin\(\) \{/m)
    expect(provisionerSrc).toContain('is not an immutable pin')
  })
})

// ─── #385 item 1: the deriver is pinned, and the pin cannot fail the job ──────
//
// Behaviour lives in release-gate-exec.integration.test.ts, which runs the
// extracted shell. What execution structurally CANNOT see is the YAML step
// machinery around it — the exec harness supplies GATE_* itself, so it would not
// notice the checkout step, its `continue-on-error`, or the env plumbing going
// missing. Those three are asserted here and nowhere else.
describe('release-consistency — pinned gate tooling step (#385 item 1)', () => {
  it('checks out the REUSABLE workflow\u2019s own repo and commit, not the caller\u2019s', () => {
    // github.* in a reusable workflow is the CALLER's context; job.workflow_* is
    // the only pair that names this file's own repo and sha.
    expect(reusableSrc).toMatch(/repository: \$\{\{ job\.workflow_repository \}\}/)
    expect(reusableSrc).toMatch(/ref: \$\{\{ job\.workflow_sha \}\}/)
    expect(reusableSrc).toMatch(/path: \.gate-tools/)
  })

  it('cannot fail the job: the pinned checkout is continue-on-error and guarded by an if', () => {
    // The load-bearing bit. This step runs BEFORE every in-job early green, so a
    // step failure here is a JOB failure in front of them — and with zero bypass
    // actors that deadlocks main in every provisioned repo (D15c at job level).
    const stepIdx = reusableSrc.indexOf('- name: Checkout pinned gate tooling')
    const gateIdx = reusableSrc.indexOf('- name: Gate')
    expect(stepIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(stepIdx)
    const step = reusableSrc.slice(stepIdx, gateIdx)
    expect(step).toMatch(/continue-on-error: true/)
    expect(step).toMatch(/if: \$\{\{ job\.workflow_repository != '' && job\.workflow_sha != '' \}\}/)
    // The clone is credential-free: `persist-credentials: false` keeps the
    // cross-repo token out of .gate-tools/.git/config, where any later step —
    // including `bash "$PRICE"` itself — could read it. Scoped to this step like
    // its three siblings in the same `with:` block, so a drop is caught here
    // rather than satisfied by the string appearing anywhere in the file.
    expect(step).toMatch(/persist-credentials: false/)
  })

  it('clears .gate-tools/ before the pinned checkout — the head must not own that path', () => {
    // `.gate-tools/` lives in the PR-author-controlled checkout, and the pinned
    // step writes it ONLY when it runs (its `if:` and `continue-on-error` both
    // exist for good reasons). Without an unconditional clear, a
    // `.gate-tools/…/price.sh` committed by the PR survives into the Gate step.
    // Exec cannot see this: the harness runs the Gate script alone.
    const clearIdx = reusableSrc.indexOf('- name: Clear the pinned gate-tooling path')
    const pinIdx = reusableSrc.indexOf('- name: Checkout pinned gate tooling')
    expect(clearIdx).toBeGreaterThan(-1)
    expect(pinIdx).toBeGreaterThan(clearIdx)
    const step = reusableSrc.slice(clearIdx, pinIdx)
    expect(step).toMatch(/run: rm -rf \.gate-tools/)
    // Unconditional: no `if:` may gate it, or the attack path re-opens exactly
    // where the pinned step is skipped.
    expect(step).not.toMatch(/^\s+if:/m)
    // And it may not fail the job in front of an early green (D15c).
    expect(step).toMatch(/continue-on-error: true/)
  })

  it('plumbs the pin identity and the checkout outcome into the Gate step', () => {
    // Without these the gate cannot tell an operator WHY the deriver is missing,
    // and the exec suite — which supplies them — cannot observe their loss.
    expect(reusableSrc).toMatch(/^\s+GATE_TOOLS_OUTCOME: \$\{\{ steps\.gate_tools\.outcome \}\}$/m)
    expect(reusableSrc).toMatch(/^\s+GATE_PIN: \$\{\{ job\.workflow_repository \}\}@\$\{\{ job\.workflow_sha \}\}$/m)
  })

  it('runs the pinned deriver and never the checked-out one', () => {
    expect(reusableSrc).toContain('PRICE=".gate-tools/plugins/dev-core/skills/promote/price.sh"')
    expect(reusableSrc).not.toMatch(/PRICE="plugins\//)
  })

  it('decides on PROVENANCE: only a pinned checkout that RAN and SUCCEEDED blesses the deriver', () => {
    // `[ -f "$PRICE" ]` alone is presence, and the head can create presence at
    // that path. `steps.gate_tools.outcome` is the one witness it cannot write.
    // The exec suite proves the behaviour; this pins the predicate so a future
    // edit cannot quietly drop the outcome conjunct and keep the file check.
    expect(reusableSrc).toMatch(/^\s+price_available\(\) \{$/m)
    expect(reusableSrc).toContain('[ "${GATE_TOOLS_OUTCOME:-}" = "success" ] && [ -f "$PRICE" ]')
  })

  it('every `bash "$PRICE"` is immediately preceded by the lazy guard, and no guard precedes an early green', () => {
    // The placement contract of #385 item 3, read off the shipped bytes. The
    // behavioural half (early greens still exit 0 with no deriver) is in the exec
    // suite; this half pins the *structure* that makes it true, so a future edit
    // that adds a third call site without a guard fails here rather than shipping
    // an unguarded `bash "$PRICE"`.
    const lines = reusableSrc.split('\n')
    const callSites = lines.flatMap((l, i) => (/^\s*[A-Z_]+=\$\(bash "\$PRICE"/.test(l) ? [i] : []))
    const guards = lines.flatMap((l, i) => (/^\s*price_available \|\|/.test(l) ? [i] : []))
    expect(callSites.length).toBe(2)
    expect(guards.length).toBe(callSites.length)
    // No call site may be guarded by the old presence-only test.
    expect(reusableSrc).not.toMatch(/^\s*\[ -f "\$PRICE" \] \|\|/m)

    // Each call site has a guard above it with only comments and `set +e` between.
    for (const site of callSites) {
      const guard = guards.filter((g) => g < site).pop()
      expect(guard).toBeDefined()
      const between = lines
        .slice((guard as number) + 1, site)
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
      expect(between.every((l) => l.trim() === 'set +e')).toBe(true)
    }

    // And no guard sits above the first early green — that ordering is the P1
    // deadlock the #374 review killed.
    const firstEarlyGreen = reusableSrc.search(/[^!]= "trunk" \]/)
    expect(firstEarlyGreen).toBeGreaterThan(-1)
    const firstGuardOffset = reusableSrc.search(/^\s*price_available \|\|/m)
    expect(firstGuardOffset).toBeGreaterThan(firstEarlyGreen)
  })
})

// ─── F3/F7: the gate delegates derivation to the sole deriver, no duplicate ─────

describe('release gate delegates to price.sh — no duplicated deriver', () => {
  it('the push-path floor comes from `price.sh --base-only`, not a hand-copied loop', () => {
    expect(reusableSrc).toMatch(/--base-only/)
  })

  it('does NOT re-implement the reachability predicate (it lives only in price.sh)', () => {
    // The push path used to hand-copy price.sh's `git merge-base --is-ancestor "$sha"` BASE
    // selection — a second implementation of the sole-deriver predicate (D10). Re-introducing it
    // is the exact N×M drift #369 removed. Match the executable probe (`git ` prefix), not the
    // fetch-depth:0 doc comment that legitimately names the command.
    expect(reusableSrc).not.toMatch(/git merge-base --is-ancestor/)
  })

  it('the PR path also derives through price.sh (single deriver, D10)', () => {
    expect(reusableSrc).toMatch(/bash "\$PRICE"/)
  })
})

// ─── N7/N8 — trunk PR-path early-green (#371 S3) ──────────────────────────────

describe('release-consistency — trunk mode early-green (#371 N7/N8)', () => {
  it('reads the release model with a staging-train default (yq → python3 fallback, mirrors read_component)', () => {
    expect(reusableSrc).toMatch(/read_model\(\)/)
    expect(reusableSrc).toContain('.release.model')
    // Default so an absent/unknown model keeps the staging-train behaviour (N9).
    expect(reusableSrc).toMatch(/staging-train/)
  })

  it('early-greens EVERY PR under trunk mode — releases fire at merge-to-main, not on PRs', () => {
    // The trunk branch must sit in the PR path, BEFORE the head!=staging scope
    // gate, so a trunk repo never runs the promote three-way check.
    //
    // Falsifiable (#280): the `[^!]` anchor rejects the inverted `!= "trunk"`
    // guard — flipping `=`→`!=` (gating trunk PRs instead of early-greening them)
    // makes `trunkIdx` = -1 so the ordering assertion fails. The exit-0 probe
    // proves the matched branch actually short-circuits GREEN rather than falling
    // through to the three-way check. (The prior `/= "trunk" \]/` matched the tail
    // of `!= "trunk" ]` too, so an inverted guard shipped green — the B4 defect.)
    const prPathIdx = reusableSrc.indexOf('EVENT_NAME" = "pull_request"')
    const trunkIdx = reusableSrc.search(/[^!]= "trunk" \]/)
    const headStagingIdx = reusableSrc.indexOf('PR_HEAD_REF" != "staging"')
    expect(prPathIdx).toBeGreaterThan(-1)
    expect(trunkIdx).toBeGreaterThan(prPathIdx)
    expect(trunkIdx).toBeLessThan(headStagingIdx)
    // the guarded branch short-circuits GREEN (exit 0) between the guard and the
    // head!=staging gate — not a fall-through, not an exit 1.
    const trunkExitIdx = reusableSrc.indexOf('exit 0', trunkIdx)
    expect(trunkExitIdx).toBeGreaterThan(trunkIdx)
    expect(trunkExitIdx).toBeLessThan(headStagingIdx)
  })
})

// ─── #374: AUTHORITY read from the BASE ref, never the PR head ─────────────────
//
// On the pull_request path the checkout is the PR MERGE ref, so anything read
// from it is attacker-influenced. release.model + release.component are AUTHORITY
// (they decide whether/how the gate runs) and must come from the base; PR title +
// CHANGELOG are WITNESSES (the claim) and legitimately come from the head.
//
// These are source assertions, not a behavioural run: the gate is a workflow_call
// reusable with no caller stub here (inert), and executing its readers needs a yq
// or python3+pyyaml the vitest CI job does not carry — so the fix's observable is
// the workflow source. Each assertion checks a post-fix string absent from the
// pre-#374 file (which read $STACK with no arg and anchored a bare origin/main),
// so a revert fails here.
describe('release-consistency — authority from BASE ref, not PR head (#374)', () => {
  it('wires the PR base ref into the gate env', () => {
    expect(reusableSrc).toMatch(/PR_BASE_REF:\s*\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\}\}/)
  })

  it('materialises the base stack.yml from a fully-qualified remote ref (not the checkout)', () => {
    expect(reusableSrc).toContain('git show "refs/remotes/origin/${PR_BASE_REF}:${STACK}"')
  })

  it('reads BOTH release.model and release.component from the base stack, not $STACK', () => {
    expect(reusableSrc).toContain('read_model "$BASE_STACK"')
    expect(reusableSrc).toContain('read_component "$BASE_STACK"')
  })

  it('the trunk early-green is decided by the base model — a head adding release.model:trunk cannot self-green', () => {
    // The trunk guard specifically must read $BASE_STACK. If it read the checkout,
    // a PR that added `release.model: trunk` to its own stack.yml would flip its
    // own gate to unconditional green — the exact #374 defect.
    const trunkGuard = reusableSrc.match(/if \[ "\$\(read_model[^)]*\)" = "trunk" \]/)
    expect(trunkGuard).not.toBeNull()
    expect((trunkGuard as RegExpMatchArray)[0]).toContain('$BASE_STACK')
  })

  it('anchors the PR-path re-price at the fully-qualified base ref — no bare origin/main (B1)', () => {
    // A bare `origin/<ref>` is ambiguous with a same-named tag; on the PR path the
    // whole re-price must use refs/remotes/origin/… .
    expect(reusableSrc).not.toContain('"$COMPONENT" origin/main')
    expect(reusableSrc).toContain(
      'bash "$PRICE" "$COMPONENT" "refs/remotes/origin/${PR_BASE_REF}" "refs/remotes/origin/${PR_BASE_REF}" "$PR_HEAD_SHA"',
    )
  })

  it('AUTHORITY readers coerce on error instead of aborting under set -e (O1)', () => {
    // A malformed base stack.yml must not red every PR (zero bypass actors →
    // unmergeable): the readers swallow yq/python failures and coerce.
    expect(reusableSrc).toContain(`yq -r '.release.model // "staging-train"' "$f" 2>/dev/null || echo "staging-train"`)
    expect(reusableSrc).toContain(`yq -r '.release.component // ""' "$f" 2>/dev/null || echo ""`)
    // The readers take a file arg so the PR path can pass the base stack.
    expect(reusableSrc).toContain('local f="${1:-$STACK}"')
  })
})

// ─── push path fails CLOSED on a missing contract ──────────────────────────────
//
// Same source-assertion regime as the #374 block above (the reusable is inert
// here). The observable defended: a $STACK that resolves to nothing must NOT
// reach the `version_files empty — nothing to check` early green.
describe('release-consistency — push path refuses to gate without the contract', () => {
  it('declares $STACK from the contract resolver, not a second hardcoded literal', () => {
    // Pinned against contract-paths.cjs, so the workflow cannot drift back to
    // `.claude/stack.yml` (or anywhere else) while the resolver says otherwise.
    expect(reusableSrc).toContain(`STACK="${STACK_YML}"`)
  })

  it('hard-fails when $STACK is absent instead of early-greening the floor check', () => {
    // `read_version_files` has no `[ -f ]` coercion (deliberate: an absent contract
    // must not read as an empty list) and `mapfile < <(read_version_files)` swallows
    // the subshell failure under `set -euo pipefail` → n=0 → early GREEN. Verified:
    // with the guard stripped and $STACK pointed at a missing file the block exits 0;
    // with it, exit 1. So the guard IS the fail-closed behaviour, not decoration.
    expect(reusableSrc).toMatch(/\[ -f "\$STACK" \] \|\| \{.*exit 1.*\}/)
  })

  it('places that guard AFTER every PR-path early green and BEFORE the version_files read', () => {
    // Placement is the whole safety argument. Above the trunk / head!=staging early
    // greens the guard would red every PR of a repo whose base is not migrated yet —
    // and with zero bypass actors, red == unmergeable (KNOWN-OPEN (c)). Below the PR
    // `if … fi`, whose every branch exits, it is unreachable on a pull_request.
    const trunkIdx = reusableSrc.search(/[^!]= "trunk" \]/)
    const headStagingIdx = reusableSrc.indexOf('PR_HEAD_REF" != "staging"')
    const guardIdx = reusableSrc.search(/\[ -f "\$STACK" \] \|\|/)
    const readVfIdx = reusableSrc.indexOf('mapfile -t VFILES < <(read_version_files)')
    expect(guardIdx).toBeGreaterThan(trunkIdx)
    expect(guardIdx).toBeGreaterThan(headStagingIdx)
    expect(guardIdx).toBeLessThan(readVfIdx)
  })
})
