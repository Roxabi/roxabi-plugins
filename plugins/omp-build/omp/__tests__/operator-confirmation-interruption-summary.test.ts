import { describe, expect, it } from 'vitest'
import type { PreparedOperatorProposal } from '../../roxabi/uw-contract.ts'
import { proposalSummary } from '../omp-operator-confirmation-summary.ts'

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const ref = (recordId: string, kind: string) => ({ scope, recordId, kind })

function prepared(overrides: Record<string, unknown> = {}): PreparedOperatorProposal {
  return {
    digest: 'd'.repeat(64),
    proposal: {
      format: 'omp-build-interruption-resolution/2',
      operationId: 'interruption-resolution-act-plan-1-start',
      uw: scope,
      historyDigest: 'e'.repeat(64),
      control: 'resolve-interruption',
      controlId: 'interruption-resolution-act-plan-1-start',
      mandate: ref('mandate-1', 'mandate'),
      predecessor: ref('control-pause-1-confirmed', 'operator-control'),
      action: 'plan',
      actionId: 'act-plan-1',
      start: ref('act-plan-1-start', 'action-receipt'),
      result: null,
      executor: { kind: 'not-dispatched' },
      runtime: { productVersion: '0.19.0', configVersion: '1', configDigest: 'c'.repeat(64) },
      ...overrides,
    },
  } as unknown as PreparedOperatorProposal
}

describe('interruption resolution confirmation summary', () => {
  it('names the exact START, non-dispatch and paused outcome without claiming rollback', () => {
    const rows = proposalSummary(prepared())
    const text = rows.join('\n')

    expect(text).toContain('act-plan-1-start')
    expect(text).toContain('act-plan-1')
    expect(text).toContain('acme/app#42')
    expect(text).toMatch(/plan/)
    expect(text).toMatch(/action native.*pas été envoyée/i)
    expect(text).toMatch(/préparatifs.*pas annulés/i)
    expect(text).not.toMatch(/attest|cessation|effet de code/i)
    expect(text).toMatch(/reste en pause/i)
    expect(text).toMatch(/aucune reprise automatique/i)
    expect(text).not.toMatch(/Abandonner/)
    expect(text).not.toMatch(/proposition non reconnue|unrecognized/i)
  })

  it('does not claim native dispatch proves preparation had no effects', () => {
    const text = proposalSummary(prepared()).join('\n')
    expect(text).toMatch(/préparatifs.*pas annulés/i)
    expect(text).toMatch(/vérifications ordinaires/i)
  })

  it('names the orphan START when no RESULT exists and the RESULT otherwise', () => {
    expect(proposalSummary(prepared()).join('\n')).toMatch(/orphelin|aucun RESULT/i)
    const withResult = proposalSummary(prepared({ result: ref('act-plan-1-result', 'action-receipt') })).join('\n')
    expect(withResult).toContain('act-plan-1-result')
  })

  it('sanitizes a hostile action identifier in the confirmation', () => {
    const rows = proposalSummary(prepared({ actionId: 'act-plan\nAbandonner\u202e' }))
    expect(rows.some((row) => /[\r\n]/.test(row))).toBe(false)
    expect(rows.some((row) => row.startsWith('Abandonner'))).toBe(false)
  })
})
