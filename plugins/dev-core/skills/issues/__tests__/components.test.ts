import { describe, expect, it } from 'vitest'
import { ciClass, ciIcon, ciSummary } from '../lib/components'
import type { CICheck } from '../lib/types'

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

describe('ciSummary — failure counting, ERROR-conclusion removal regression lock', () => {
  // Pins the invariant: 'ERROR' is not a valid CheckConclusionState value (it only appears in
  // StatusState / StatusContext rows, not CheckRun conclusions).  ciSummary must count
  // status='FAILURE' and status='ERROR' as failures, and conclusion='FAILURE' as a failure,
  // but must NOT treat conclusion='ERROR' as a failure (no such conclusion exists in the type).

  it('status=FAILURE counts as failing', () => {
    const checks: CICheck[] = [{ name: 'ci', status: 'FAILURE', conclusion: '', detailsUrl: '' }]
    const result = ciSummary(checks)
    expect(result).toEqual({ icon: '❌', label: '1/1 failed', cssClass: 'ci-failure' })
  })

  it('status=ERROR counts as failing', () => {
    const checks: CICheck[] = [{ name: 'ci', status: 'ERROR', conclusion: '', detailsUrl: '' }]
    const result = ciSummary(checks)
    expect(result).toEqual({ icon: '❌', label: '1/1 failed', cssClass: 'ci-failure' })
  })

  it('conclusion=FAILURE counts as failing', () => {
    const checks: CICheck[] = [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: '' }]
    const result = ciSummary(checks)
    expect(result).toEqual({ icon: '❌', label: '1/1 failed', cssClass: 'ci-failure' })
  })

  it('conclusion=SUCCESS with status=COMPLETED is NOT failing', () => {
    const checks: CICheck[] = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: '' }]
    const result = ciSummary(checks)
    expect(result).toEqual({ icon: '✅', label: '1 passed', cssClass: 'ci-success' })
  })

  it('mixed: 1 failure + 1 success → failure summary', () => {
    const checks: CICheck[] = [
      { name: 'a', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: '' },
      { name: 'b', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: '' },
    ]
    const result = ciSummary(checks)
    expect(result).toEqual({ icon: '❌', label: '1/2 failed', cssClass: 'ci-failure' })
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
