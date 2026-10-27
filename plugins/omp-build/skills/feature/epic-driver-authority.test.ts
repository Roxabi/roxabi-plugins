import { describe, expect, it } from 'vitest'
import type { AcceptedOwnSpec } from '../../engine/workflow-accepted-spec-types.ts'
import { effectiveMandateRole } from '../../engine/workflow-mandate.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { assertChildGrant, confirmedEpicMandate, type EpicAuthority } from './epic-driver-authority'
import { acceptedOwnUw, BASE, child, facts, RUN, refusedOwnUw } from './epic-transition.fixture'

describe('accepted child commitment', () => {
  const authority = (): EpicAuthority => {
    const own = acceptedOwnUw(1)
    if (own.status !== 'accepted') throw new Error('fixture own UW must be accepted')
    const accepted = own.accepted
    return {
      epic: 575,
      repository: 'o/r',
      mandateId: 'epic-mandate',
      run: RUN,
      base: BASE,
      children: [
        {
          scope: accepted.ref.uw,
          specVersion: accepted.snapshot.spec.version,
          snapshot: accepted.snapshot,
          tier: accepted.tier,
        },
      ],
      config: { productVersion: 'test', version: 'test', digest: 'a'.repeat(64), effective: {} },
    }
  }

  it('accepts a fresh canonical own UW matching the structured child commitment', () => {
    expect(() => assertChildGrant(authority(), facts([child(1)]), 1)).not.toThrow()
  })

  it('names an unsettled or changed child rather than falling back to its body', () => {
    expect(() => assertChildGrant(authority(), facts([child(1, { ownUw: refusedOwnUw('incomplete') })]), 1)).toThrow(
      '#1 incomplete-child: graph-incomplete',
    )
    const changed = child(1)
    if (changed.ownUw.status !== 'accepted') throw new Error('fixture own UW must be accepted')
    changed.ownUw.accepted = {
      ...changed.ownUw.accepted,
      snapshot: {
        ...changed.ownUw.accepted.snapshot,
        spec: { ...changed.ownUw.accepted.snapshot.spec, version: 'c'.repeat(64) },
      },
    }
    expect(() => assertChildGrant(authority(), facts([changed]), 1)).toThrow('#1 changed-child:')
  })

  it('refuses a native child whose accepted commitment was removed', () => {
    expect(() => assertChildGrant({ ...authority(), children: [] }, facts([child(1)]), 1)).toThrow(
      '#1 is outside the epic mandate',
    )
  })
})

describe('confirmed epic mandate projection', () => {
  const fixtures = roxabiWorkflowFixtures()
  const scope = { repository: 'o/r', target: 'o/r#1' }
  const accepted = (children: AcceptedOwnSpec['children']): AcceptedOwnSpec => {
    const observed = acceptedOwnUw(1)
    if (observed.status !== 'accepted') throw new Error('fixture own UW must be accepted')
    return { ...observed.accepted, children }
  }

  it('projects current accepted children from a stored feature mandate', () => {
    const record = fixtures.featureMandate(scope)
    const observed = acceptedOwnUw(3)
    if (observed.status !== 'accepted') throw new Error('fixture own UW must be accepted')
    const current = {
      scope: observed.accepted.ref.uw,
      specVersion: observed.accepted.snapshot.spec.version,
      snapshot: observed.accepted.snapshot,
      tier: observed.accepted.tier,
    }
    const own = accepted([current])
    expect(effectiveMandateRole(record.payload.role, own)).toBe('epic')

    const projected = confirmedEpicMandate(record, own)

    expect(projected).toMatchObject({ mandateId: record.recordId, run: 'run00001', children: [current] })
    expect(projected.children).toBe(own.children)
  })

  it('refuses a fix-only mandate before projecting authority fields', () => {
    const record = fixtures.fixOnlyMandate(scope)

    expect(() => confirmedEpicMandate(record, accepted([]))).toThrow('is fix-only, not normal authority')
  })
})
