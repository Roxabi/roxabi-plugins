import { describe, expect, it } from 'vitest'
import { ciClass, ciIcon } from '../lib/components'

const CI_SPINNER_HTML = '<span class="ci-spinner"></span>'

describe('ciIcon — StatusContext rows (conclusion="")', () => {
  it('SUCCESS,"" → ✅', () => {
    expect(ciIcon('SUCCESS', '')).toBe('✅')
  })

  it('FAILURE,"" → ❌', () => {
    expect(ciIcon('FAILURE', '')).toBe('❌')
  })

  it('PENDING,"" → spinner', () => {
    expect(ciIcon('PENDING', '')).toBe(CI_SPINNER_HTML)
  })
})

describe('ciIcon — CheckRun rows (status=COMPLETED)', () => {
  it('COMPLETED,SUCCESS → ✅', () => {
    expect(ciIcon('COMPLETED', 'SUCCESS')).toBe('✅')
  })

  it('COMPLETED,FAILURE → ❌', () => {
    expect(ciIcon('COMPLETED', 'FAILURE')).toBe('❌')
  })
})

describe('ciClass — StatusContext rows (conclusion="")', () => {
  it('SUCCESS,"" → ci-success', () => {
    expect(ciClass('SUCCESS', '')).toBe('ci-success')
  })

  it('FAILURE,"" → ci-failure', () => {
    expect(ciClass('FAILURE', '')).toBe('ci-failure')
  })
})

describe('ciClass — CheckRun rows (status=COMPLETED)', () => {
  it('COMPLETED,SUCCESS → ci-success', () => {
    expect(ciClass('COMPLETED', 'SUCCESS')).toBe('ci-success')
  })
})

describe('ciIcon/ciClass — StatusContext-vs-CheckRun routing regression (Bug-1)', () => {
  // Pins the fix: StatusContext row with status=SUCCESS and non-empty conclusion must NOT
  // be misrouted to the CheckRun/COMPLETED branch.
  // Pre-fix code returned ⛔ (CANCELLED conclusion) for ciIcon and 'ci-cancelled' for ciClass.
  // Post-fix code correctly routes to the StatusContext SUCCESS branch.
  it('ciIcon: SUCCESS with CANCELLED conclusion → ✅ (StatusContext SUCCESS branch, not CheckRun)', () => {
    expect(ciIcon('SUCCESS', 'CANCELLED')).toBe('✅')
  })

  it('ciClass: SUCCESS with CANCELLED conclusion → ci-success (StatusContext SUCCESS branch, not CheckRun)', () => {
    expect(ciClass('SUCCESS', 'CANCELLED')).toBe('ci-success')
  })
})
