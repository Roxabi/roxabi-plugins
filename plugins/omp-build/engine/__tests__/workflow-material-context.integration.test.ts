import { describe, expect, test } from 'vitest'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import {
  buildMaterialAcceptanceControl,
  prepareMaterialAcceptance,
  recheckMaterialAcceptance,
} from '../workflow-material-acceptance.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { featureMandate, history, SCOPE } from './workflow-test-support.ts'

describe('material context acceptance', () => {
  test('carries authenticated context-only material and unknown assessments through exact acceptance', () => {
    const mandated = featureMandate()
    const initial = mandateAssessmentState(mandated)
    const unchangedContent = {
      criteria: initial.snapshot.spec.criteria,
      invariants: initial.snapshot.spec.invariants,
      exclusions: initial.snapshot.spec.exclusions,
      openQuestions: initial.snapshot.spec.openQuestions,
      sections: initial.snapshot.spec.sections,
    }
    const contextOnly = proposedAssessmentState(initial, {
      body: 'context promotion',
      content: {
        ...unchangedContent,
        sections: { ...initial.snapshot.spec.sections, context: 'Promoted from staging to production.' },
      },
    })
    for (const classification of ['material', 'unknown'] as const) {
      const pending = assessFixture(mandated, `context-only-${classification}`, initial, contextOnly, classification, [
        history([mandated]),
      ])
      const histories = [history([mandated, pending.start, pending.result])]
      const prepared = prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: `op-accept-context-only-${classification}`,
        histories,
        mandate: mandated,
        currentProposed: contextOnly,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      })
      if (!prepared.ok) throw new Error('expected prepared context-only material acceptance')
      expect(recheckMaterialAcceptance({ prepared: prepared.value, histories, mandate: mandated })).toEqual(prepared)
      expect(
        buildMaterialAcceptanceControl(
          prepared.value,
          {
            route: 'omp-native-command',
            operationId: prepared.value.proposal.operationId,
            proposalDigest: prepared.value.digest,
            confirmedAt: '2026-10-21T00:00:00Z',
          },
          { histories, mandate: mandated },
        ),
      ).toMatchObject({ ok: true })
    }
    const noOp = assessFixture(
      mandated,
      'context-only-no-op',
      initial,
      proposedAssessmentState(initial, { body: initial.snapshot.raw.body, content: unchangedContent }),
      'material',
      [history([mandated])],
    )
    expect(
      prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: 'op-accept-context-only-no-op',
        histories: [history([mandated, noOp.start, noOp.result])],
        mandate: mandated,
        currentProposed: noOp.proposed,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-assessment-not-material' }] })
    const mechanicalEditorial = assessFixture(
      mandated,
      'context-only-mechanical-editorial',
      initial,
      proposedAssessmentState(initial, {
        body: 'remove the criterion',
        content: {
          criteria: [],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
      }),
      'editorial',
      [history([mandated])],
    )
    const mechanicalHistories = [history([mandated, mechanicalEditorial.start, mechanicalEditorial.result])]
    expect(resolveAcceptedSpec(mandated, mechanicalHistories)).toMatchObject({
      ok: true,
      spec: { ref: { version: initial.ref.version } },
    })
    const mechanicalPrepared = prepareMaterialAcceptance({
      uw: SCOPE,
      operationId: 'op-accept-mechanical-editorial',
      histories: mechanicalHistories,
      mandate: mandated,
      currentProposed: mechanicalEditorial.proposed,
      identityAllocations: mandated.payload.ownSpec.identityAllocations,
    })
    if (!mechanicalPrepared.ok) throw new Error('expected prepared mechanically forced material acceptance')
    expect(mechanicalPrepared.value.proposal.classification).toBe('editorial')
    expect(
      recheckMaterialAcceptance({
        prepared: mechanicalPrepared.value,
        histories: mechanicalHistories,
        mandate: mandated,
      }),
    ).toEqual(mechanicalPrepared)
    expect(
      buildMaterialAcceptanceControl(
        mechanicalPrepared.value,
        {
          route: 'omp-native-command',
          operationId: mechanicalPrepared.value.proposal.operationId,
          proposalDigest: mechanicalPrepared.value.digest,
          confirmedAt: '2026-10-21T00:00:00Z',
        },
        { histories: mechanicalHistories, mandate: mandated },
      ),
    ).toMatchObject({ ok: true })
  })
})
