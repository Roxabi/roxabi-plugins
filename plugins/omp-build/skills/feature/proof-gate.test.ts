import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { proofGate } from './proof-gate'

const base = {
  gaps: [] as string[],
  noTest: {} as Record<string, string>,
  acceptedReasons: [] as string[],
  assertledger: null as 'detection' | 'WEAK_ORACLE' | 'miss' | null,
  hasAdapter: false,
  typeFix: false,
}

describe('proofGate', () => {
  it('passes VERIFIED', () => {
    expect(proofGate({ ...base, verify: 'VERIFIED' })).toEqual({ pass: true })
  })

  it('passes a PARTIAL whose every gap is a NO TEST row', () => {
    expect(
      proofGate({
        ...base,
        verify: 'PARTIAL',
        gaps: ['prompt'],
        noTest: { prompt: 'prompt-logic-only' },
      }),
    ).toEqual({ pass: true })
  })

  it('stops an unjustified PARTIAL', () => {
    expect(proofGate({ ...base, verify: 'PARTIAL', gaps: ['ui'] }).pass).toBe(false)
  })

  it('stops BLOCKED', () => {
    expect(proofGate({ ...base, verify: 'BLOCKED' })).toEqual({ pass: false, reason: 'BLOCKED' })
  })

  it('stops WEAK_ORACLE on a fix ticket that has an adapter', () => {
    expect(
      proofGate({
        ...base,
        verify: 'VERIFIED',
        typeFix: true,
        hasAdapter: true,
        assertledger: 'WEAK_ORACLE',
      }),
    ).toEqual({ pass: false, reason: 'WEAK_ORACLE' })
  })

  it('is stated before openPr and read back as the matrix', () => {
    const feature = readFileSync(fileURLToPath(new URL('./SKILL.md', import.meta.url)), 'utf-8')
    const review = readFileSync(fileURLToPath(new URL('../dev-review/SKILL.md', import.meta.url)), 'utf-8')
    expect(feature).toContain('proofGate')
    expect(feature).toContain('.semctx/working/` empty apart from `.gitkeep')
    expect(feature).toContain('WEAK_ORACLE')
    expect(review).toContain('proof section')
  })
  it('does not block when no adapter exists', () => {
    expect(
      proofGate({
        ...base,
        verify: 'VERIFIED',
        typeFix: true,
        hasAdapter: false,
        assertledger: 'WEAK_ORACLE',
      }),
    ).toEqual({ pass: true })
  })
})
