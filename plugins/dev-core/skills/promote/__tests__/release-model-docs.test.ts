import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Docs sentinel for the release.model contract (#371 N12/N13). Grep-checkable so
// the four trunk-mode concepts + the stack.yml.example key cannot silently rot.
//   __tests__ → promote (SKILL.md) ; __tests__ → promote → skills → dev-core (stack.yml.example)
const SKILL_MD = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const STACK_EXAMPLE = fileURLToPath(new URL('../../../stack.yml.example', import.meta.url))

const skill = readFileSync(SKILL_MD, 'utf8')
const example = readFileSync(STACK_EXAMPLE, 'utf8')

describe('promote docs — release.model contract (#371 S5 / N12,N13)', () => {
  it('has a Trunk mode section keyed to release.model', () => {
    expect(skill).toMatch(/##\s+Trunk mode/)
    expect(skill).toContain('release.model')
  })

  it('(a) documents the merge-commit requirement', () => {
    expect(skill).toMatch(/merge.commit/i)
  })

  it('(b) documents that /promote no-ops under trunk (status=trunk_mode)', () => {
    expect(skill).toContain('status=trunk_mode')
  })

  it('(c) documents firing on every merge, with the empty payload = green no-op (D18)', () => {
    expect(skill).toMatch(/every merge/i)
    expect(skill).toContain('D18')
  })

  it('(d) documents the workflow_dispatch recovery runbook', () => {
    expect(skill).toContain('workflow_dispatch')
  })

  it('(e) narrows the trunk guard (B1) — create-PR path stays open, --finalize is refused', () => {
    // The blanket "no /promote" no-op stranded a staging-keeping repo with no path
    // to main (#371 B1). The create-PR path must be documented AND --finalize must
    // be refused (single writer) — both grep-checkable so the narrowing cannot rot.
    expect(skill).toContain('status=trunk_promote_pr')
    expect(skill).toMatch(/--finalize[^\n]*(refus|does not apply)/i)
  })

  it('stack.yml.example ships release.model defaulting to staging-train', () => {
    expect(example).toMatch(/^\s+model:\s+staging-train/m)
  })
})
