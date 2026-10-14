import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Docs sentinel for the release.model contract (#371 N12/N13, narrowed by ADR-021).
// Grep-checkable so the trunk-mode concepts + the stack.yml.example key cannot
// silently rot.
//   __tests__ → promote (SKILL.md) ; __tests__ → promote → skills → dev-core (stack.yml.example)
//   __tests__ → promote → skills → dev-core → plugins (omp-build's sibling copy)
const SKILL_MD = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const STACK_EXAMPLE = fileURLToPath(new URL('../../../stack.yml.example', import.meta.url))
const OMP_SKILL_MD = fileURLToPath(new URL('../../../../omp-build/skills/promote/SKILL.md', import.meta.url))

const skill = readFileSync(SKILL_MD, 'utf8')
const example = readFileSync(STACK_EXAMPLE, 'utf8')
const ompSkill = readFileSync(OMP_SKILL_MD, 'utf8')

describe('promote docs — release.model contract (#371 S5 / N12,N13)', () => {
  it('has a Trunk mode section keyed to release.model', () => {
    expect(skill).toMatch(/##\s+Trunk mode/)
    expect(skill).toContain('release.model')
  })

  it('(a) documents that a trunk release is an annotated tag, pushed by a human (ADR-021)', () => {
    // The four original bullets described the merge-to-main tagger: merge-commits
    // required (D3), fires on every merge, empty payload = green no-op (D18), and
    // workflow_dispatch recovery. All four named machinery that no longer exists,
    // so they are deleted rather than re-pinned to replacement prose. What is left
    // is the one claim a reader can act on.
    expect(skill).toMatch(/git tag -a/)
    expect(skill).toMatch(/annotated/i)
  })

  it('(b) documents that /R-promote no-ops under trunk (status=trunk_mode)', () => {
    expect(skill).toContain('status=trunk_mode')
  })

  it('(e) narrows the trunk guard (B1) — create-PR path stays open, --finalize is refused', () => {
    // The blanket "no /R-promote" no-op stranded a staging-keeping repo with no path
    // to main (#371 B1). The create-PR path must be documented AND --finalize must
    // be refused (single writer) — both grep-checkable so the narrowing cannot rot.
    expect(skill).toContain('status=trunk_promote_pr')
    expect(skill).toMatch(/--finalize[^\n]*(refus|does not apply)/i)
  })

  it('(f) Step 1a skips the staging-train finalize guards under trunk — Component only (B1 Risk 2)', () => {
    // Without this, preflight opens the create-PR path but the Step 1a gate-probe
    // hard-REFUSEs a protectable repo with no required release-consistency check —
    // re-stranding the exact repo B1 unblocks. Grep-check the explicit skip.
    expect(skill).toMatch(/Trunk skip/i)
    expect(skill).toMatch(/Gate probe[\s\S]{0,140}SKIPPED/i)
    expect(skill).toMatch(/Component[^\n]*check runs/i)
  })

  it('stack.yml.example ships release.model defaulting to staging-train', () => {
    expect(example).toMatch(/^\s+model:\s+staging-train/m)
  })
})

// ─── #385 item 4 (corrected): the finalize trunk guard sits AFTER 9a ─────────
//
// The guard reads a release model, and its own text claims that read is
// legitimate because "--finalize runs post-merge on main, so the working tree IS
// the base". Placed at 9.0 — i.e. BEFORE 9a — nothing had established that: 9a
// is the step that fetches (dev-core also checks out and pulls), and Step 1a's
// own text says /promote runs on staging. So the exemption was asserted about a
// tree the skill had not reached yet. Ordering is the fix, and it is the thing
// that can silently regress, so pin it.
describe('promote docs — the finalize trunk guard reads a base the skill has reached (#385 item 4)', () => {
  for (const [name, src] of [
    ['dev-core', skill],
    ['omp-build', ompSkill],
  ] as const) {
    it(`${name}: the trunk guard comes after 9a, and nothing reads a stack before it`, () => {
      const stepNine = src.indexOf('## Step 9 — Finalize')
      const ninerA = src.indexOf('**9a.', stepNine)
      const guard = src.search(/\*\*9\.1 Trunk guard/)
      expect(stepNine).toBeGreaterThan(-1)
      expect(ninerA).toBeGreaterThan(stepNine)
      expect(guard).toBeGreaterThan(ninerA)
      // The falsifiable half: between the Step 9 heading and 9a there is no
      // release-policy read at all. Move the guard back to 9.0 and this slice
      // carries `.dev/stack.yml` again.
      expect(src.slice(stepNine, ninerA)).not.toContain('.dev/stack.yml')
    })
  }

  it('dev-core reads the local stack only because 9a checked main out', () => {
    // dev-core's 9a does `git checkout main && git pull`, so after it the working
    // tree really is the base. The justification must name that dependency,
    // otherwise it is the same unearned claim one step lower.
    expect(skill).toMatch(/9a\.[\s\S]{0,200}git checkout main/)
    expect(skill).toMatch(/only because it sits after 9a/)
  })

  it('omp-build reads the BASE REF — its 9a deliberately never checks anything out', () => {
    // omp-build's 9a is read-only on purpose (--finalize runs from a feature
    // worktree), so there is NO point at which its working tree is the base.
    // Reading the local file there is wrong at every position; the guard must
    // read refs/remotes/origin/main, the ref 9a's fetch refreshes.
    expect(ompSkill).toMatch(/There is no `git checkout main && git pull` here/)
    const guard = ompSkill.indexOf('**9.1 Trunk guard')
    const block = ompSkill.slice(guard, ompSkill.indexOf('**9b.', guard))
    expect(block).toContain('BASE_REF=refs/remotes/origin/main')
    expect(block).toMatch(/git show "\$\{BASE_REF\}:\.dev\/stack\.yml"/)
    expect(block).not.toMatch(/yq -r '\.release\.model[^']*' \.dev\/stack\.yml/)
  })
})
