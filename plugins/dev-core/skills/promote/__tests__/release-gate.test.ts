import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The two D15 artifacts under test. Resolved relative to this file (never a
// hardcoded worktree path) so the suite survives the worktree being merged
// away — repo root is five levels up from __tests__/.
//   __tests__ → promote → skills → dev-core → plugins → <repo root>
const REUSABLE_PATH = fileURLToPath(
  new URL('../../../../../.github/workflows/release-consistency.yml', import.meta.url),
)
const PROVISIONER_PATH = fileURLToPath(new URL('../../../../../scripts/provision-release-gate.sh', import.meta.url))

// The one string that must be byte-identical across all three surfaces: the
// reusable job name, the ruleset-required context, and the /promote step-1 probe.
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
    const prPathIdx = reusableSrc.indexOf('EVENT_NAME" = "pull_request"')
    const trunkIdx = reusableSrc.search(/= "trunk" \]/)
    const headStagingIdx = reusableSrc.indexOf('PR_HEAD_REF" != "staging"')
    expect(prPathIdx).toBeGreaterThan(-1)
    expect(trunkIdx).toBeGreaterThan(prPathIdx)
    expect(trunkIdx).toBeLessThan(headStagingIdx)
  })
})
