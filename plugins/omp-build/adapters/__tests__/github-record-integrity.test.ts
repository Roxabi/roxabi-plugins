import { describe, expect, it } from 'vitest'
import { nativeInstant, recordIntegrity } from '../github/record-integrity.ts'

const record = { kind: 'review', recordId: 'review-1' }

function part(createdAt: string | null, updatedAt: string | null) {
  return { createdAt, updatedAt }
}

describe('GitHub record integrity', () => {
  it('accepts equal native creation and revision instants', () => {
    expect(recordIntegrity([part('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')], record)).toBeNull()
  })

  it('refuses a revision one second after publication', () => {
    expect(recordIntegrity([part('2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')], record)).toMatchObject({
      reason: 'record-edited',
    })
  })

  it('refuses malformed calendar instants', () => {
    expect(nativeInstant('2026-02-30T00:00:00Z')).toBeNull()
    expect(recordIntegrity([part('2026-02-30T00:00:00Z', '2026-02-30T00:00:00Z')], record)).toMatchObject({
      reason: 'record-unreadable',
    })
  })
})
