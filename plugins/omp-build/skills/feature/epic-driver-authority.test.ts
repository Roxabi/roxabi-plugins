import { describe, expect, it } from 'vitest'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from '../../engine/workflow-accepted-spec-types.ts'
import { effectiveMandateRole } from '../../engine/workflow-mandate.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { confirmedEpicMandate } from './epic-driver-authority'

describe('confirmed epic mandate projection', () => {
  const fixtures = roxabiWorkflowFixtures()
  const scope = { repository: 'o/r', target: 'o/r#1' }
  const accepted = (number: number): AcceptedOwnSpec => {
    const mandate = fixtures.featureMandate({ ...scope, target: `o/r#${number}` })
    const result = resolveAcceptedSpec(mandate, [fixtures.historyFrom([mandate])])
    if (!result.ok) throw new Error(`unconfirmed fixture Spec: ${result.reason}`)
    return result.spec
  }

  it('projects current accepted children from a stored feature mandate', () => {
    const record = fixtures.featureMandate(scope)
    const observed = accepted(3)
    const current = {
      scope: observed.ref.uw,
      specVersion: observed.snapshot.spec.version,
      snapshot: observed.snapshot,
      tier: observed.tier,
    }
    const own = { ...accepted(1), children: [current] }
    expect(effectiveMandateRole(record.payload.role, own)).toBe('epic')

    const projected = confirmedEpicMandate(record, own)

    expect(projected).toMatchObject({ mandateId: record.recordId, run: 'run00001', children: [current] })
    expect(projected.children).toBe(own.children)
  })

  it('refuses a fix-only mandate before projecting authority fields', () => {
    const record = fixtures.fixOnlyMandate(scope)

    expect(() => confirmedEpicMandate(record, accepted(1))).toThrow('is fix-only, not normal authority')
  })
})
