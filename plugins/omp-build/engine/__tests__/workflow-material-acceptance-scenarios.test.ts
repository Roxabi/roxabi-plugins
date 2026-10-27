import { describe, expect, test } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import type { MandateRecord } from '../workflow-control.ts'
import {
  buildMaterialAcceptanceControl,
  prepareMaterialAcceptance,
  recheckMaterialAcceptance,
} from '../workflow-material-acceptance.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import { materialAcceptanceDigest } from '../workflow-spec-assessment.ts'
import {
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  type ProposedAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { BODY, facts, featureMandate, history, must, SCOPE } from './workflow-test-support.ts'

function decisions() {
  return {
    reviewStep: null,
    epicStep: null,
    epicLand: null,
    ciWatchStatus: null,
    publish: { status: 'absent' as const, evidence: [] },
    landing: { status: 'absent' as const, evidence: [] },
    watch: { status: 'absent' as const, evidence: [] },
  }
}

function currentFacts(mandated: MandateRecord, currentSpec: ProposedAssessmentState) {
  return facts({
    productVersion: mandated.payload.config.productVersion,
    configVersion: mandated.payload.config.version,
    configDigest: mandated.payload.config.digest,
    supportedConfigVersions: [mandated.payload.config.version],
    currentSpec,
    identityAllocations: mandated.payload.ownSpec.identityAllocations,
  })
}

describe('workflow material acceptance scenarios', () => {
  test('keeps unknown assessments operator-decidable and binds material acceptance to its exact proposal', () => {
    const mandated = featureMandate()
    const initial = mandateAssessmentState(mandated)
    const unknown = assessFixture(
      mandated,
      'unknown',
      initial,
      proposedAssessmentState(initial, { body: 'unknown body' }),
      'unknown',
    )
    expect(
      reconstructWorkflow({
        evidence: { issue: history([mandated, unknown.start, unknown.result]), pullRequest: null, parents: [] },
        facts: currentFacts(mandated, unknown.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
    const unknownControl = acceptMaterialFixture(mandated, 'accept-unknown', unknown)
    expect(
      resolveAcceptedSpec(mandated, [history([mandated, unknown.start, unknown.result, unknownControl])]),
    ).toMatchObject({
      ok: true,
      spec: { ref: { version: unknown.currentVersion } },
    })

    const removed = assessFixture(
      mandated,
      'remove-c1',
      initial,
      proposedAssessmentState(initial, {
        body: 'no criteria remain',
        content: {
          criteria: [],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
      }),
      'material',
    )
    const exact = acceptMaterialFixture(mandated, 'accept-remove-c1', removed)
    if (exact.kind !== 'operator-control' || exact.payload.control !== 'accept-material')
      throw new Error('expected material acceptance control fixture')

    expect(resolveAcceptedSpec(mandated, [history([mandated, removed.start, removed.result, exact])])).toMatchObject({
      ok: true,
      spec: { ref: { version: removed.currentVersion } },
    })
    const wrongProposal = must(
      parseRecord({
        ...exact,
        recordId: 'accept-remove-wrong-proposal',
        payload: {
          ...exact.payload,
          controlId: 'accept-remove-wrong-proposal',
          proposalDigest: 'a'.repeat(64),
          confirmation: { ...exact.payload.confirmation, proposalDigest: 'a'.repeat(64) },
        },
      }),
    )
    const wrongConfirmation = must(
      parseRecord({
        ...exact,
        recordId: 'accept-remove-wrong-confirmation',
        payload: {
          ...exact.payload,
          controlId: 'accept-remove-wrong-confirmation',
          confirmation: { ...exact.payload.confirmation, operationId: 'op-unexpected-confirmation' },
        },
      }),
    )
    const wrongRetirement = must(
      parseRecord({
        ...exact,
        recordId: 'accept-remove-wrong-retirement',
        payload: {
          ...exact.payload,
          controlId: 'accept-remove-wrong-retirement',
          identityDelta: { retired: [] },
        },
      }),
    )
    const wrongPredecessorKind = must(
      parseRecord({
        ...exact,
        recordId: 'accept-remove-wrong-predecessor',
        payload: {
          ...exact.payload,
          controlId: 'accept-remove-wrong-predecessor',
          predecessor: {
            scope: exact.payload.assessment.scope,
            recordId: exact.payload.assessment.recordId,
            kind: 'action-receipt',
          },
        },
      }),
    )
    expect(
      resolveAcceptedSpec(mandated, [history([mandated, removed.start, removed.result, wrongPredecessorKind])]),
    ).toMatchObject({ ok: true, spec: { ref: { version: initial.ref.version } } })
    const wrongAssessmentRef = must(
      parseRecord({
        ...exact,
        recordId: 'accept-remove-wrong-assessment',
        inputs: [...exact.inputs.filter((id) => id !== removed.result.recordId), 'unrelated-assessment'],
        payload: {
          ...exact.payload,
          controlId: 'accept-remove-wrong-assessment',
          assessment: { scope: SCOPE, recordId: 'unrelated-assessment', kind: 'action-receipt' },
        },
      }),
    )
    expect(
      resolveAcceptedSpec(mandated, [history([mandated, removed.start, removed.result, wrongAssessmentRef])]),
    ).toMatchObject({ ok: false, reason: 'incomplete' })
    for (const control of [wrongProposal, wrongConfirmation, wrongRetirement]) {
      expect(
        resolveAcceptedSpec(mandated, [history([mandated, removed.start, removed.result, control])]),
      ).toMatchObject({
        ok: false,
        reason: 'material-spec',
      })
    }
  })

  test('prepares, rechecks, and builds exact material acceptance through the S2 material API', () => {
    const mandated = featureMandate()
    const initial = mandateAssessmentState(mandated)
    const removedProposed = proposedAssessmentState(initial, {
      body: 'no criteria remain',
      content: {
        criteria: [],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
    })
    const pending = assessFixture(mandated, 'prepare-remove-c1', initial, removedProposed, 'material')
    const histories = [history([mandated, pending.start, pending.result])]
    const prepared = prepareMaterialAcceptance({
      uw: SCOPE,
      operationId: 'op-accept-prepare-remove-c1',
      histories,
      mandate: mandated,
      currentProposed: pending.proposed,
      identityAllocations: mandated.payload.ownSpec.identityAllocations,
    })
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        proposal: {
          format: 'omp-build-material-acceptance/1',
          operationId: 'op-accept-prepare-remove-c1',
          uw: SCOPE,
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          predecessor: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          assessment: { scope: SCOPE, recordId: pending.result.recordId, kind: 'action-receipt' },
        },
      },
    })
    if (!prepared.ok) throw new Error('expected prepared material acceptance')
    expect(recheckMaterialAcceptance({ prepared: prepared.value, histories, mandate: mandated })).toEqual(prepared)

    const control = buildMaterialAcceptanceControl(prepared.value, {
      route: 'omp-native-command',
      operationId: prepared.value.proposal.operationId,
      proposalDigest: prepared.value.digest,
      confirmedAt: '2026-10-21T00:00:00Z',
    })
    expect(control).toMatchObject({
      ok: true,
      value: {
        kind: 'operator-control',
        operationId: 'op-accept-prepare-remove-c1',
        payload: {
          control: 'accept-material',
          specVersion: pending.currentVersion,
          proposalDigest: prepared.value.digest,
          identityDelta: { retired: ['C1'] },
          confirmation: {
            operationId: 'op-accept-prepare-remove-c1',
            proposalDigest: prepared.value.digest,
          },
        },
      },
    })

    expect(
      prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: 'op-accept-missing',
        histories: [history([mandated])],
        mandate: mandated,
        currentProposed: removedProposed,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-assessment-missing' }] })

    const duplicate = assessFixture(mandated, 'prepare-remove-c1-b', initial, removedProposed, 'material')
    expect(
      prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: 'op-accept-ambiguous',
        histories: [history([mandated, pending.start, pending.result, duplicate.start, duplicate.result])],
        mandate: mandated,
        currentProposed: removedProposed,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-assessment-ambiguous' }] })

    const malformed = assessFixture(mandated, 'prepare-malformed', initial, removedProposed, null)
    expect(
      prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: 'op-accept-malformed',
        histories: [history([mandated, malformed.start, malformed.result])],
        mandate: mandated,
        currentProposed: removedProposed,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'incomplete' }] })

    const editorial = assessFixture(
      mandated,
      'prepare-editorial-advance',
      initial,
      proposedAssessmentState(initial, { body: 'editorial reword of the same commitment' }),
      'editorial',
    )
    const stale = assessFixture(mandated, 'prepare-stale-remove', initial, removedProposed, 'material')
    expect(
      prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: 'op-accept-stale',
        histories: [history([mandated, editorial.start, editorial.result, stale.start, stale.result])],
        mandate: mandated,
        currentProposed: removedProposed,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'ambiguous' }] })

    const equivalent = assessFixture(mandated, 'prepare-remove-equivalent', initial, removedProposed, 'material')
    expect(
      recheckMaterialAcceptance({
        prepared: prepared.value,
        histories: [history([mandated, equivalent.start, equivalent.result])],
        mandate: mandated,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-assessment-missing' }] })
    expect(
      recheckMaterialAcceptance({
        prepared: prepared.value,
        histories: [history([mandated, editorial.start, editorial.result, pending.start, pending.result])],
        mandate: mandated,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'ambiguous' }] })

    expect(
      prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: pending.result.operationId,
        histories,
        mandate: mandated,
        currentProposed: pending.proposed,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-operation-conflict' }] })

    expect(
      buildMaterialAcceptanceControl(
        { ...prepared.value, digest: 'a'.repeat(64) },
        {
          route: 'omp-native-command',
          operationId: prepared.value.proposal.operationId,
          proposalDigest: 'a'.repeat(64),
          confirmedAt: '2026-10-21T00:00:00Z',
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-proposal-invalid' }] })
    const incoherentMechanicalProposal = {
      ...prepared.value.proposal,
      exactInputs: {
        ...prepared.value.proposal.exactInputs,
        mechanical: { ...prepared.value.proposal.exactInputs.mechanical, removed: [] },
      },
    }
    expect(
      buildMaterialAcceptanceControl(
        {
          proposal: incoherentMechanicalProposal,
          digest: materialAcceptanceDigest(incoherentMechanicalProposal),
        },
        {
          route: 'omp-native-command',
          operationId: prepared.value.proposal.operationId,
          proposalDigest: materialAcceptanceDigest(incoherentMechanicalProposal),
          confirmedAt: '2026-10-21T00:00:00Z',
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-proposal-invalid' }] })
    const incoherentRefProposal = {
      ...prepared.value.proposal,
      predecessor: { ...prepared.value.proposal.predecessor, kind: 'action-receipt' as const },
    }
    expect(
      buildMaterialAcceptanceControl(
        {
          proposal: incoherentRefProposal,
          digest: materialAcceptanceDigest(incoherentRefProposal),
        },
        {
          route: 'omp-native-command',
          operationId: prepared.value.proposal.operationId,
          proposalDigest: materialAcceptanceDigest(incoherentRefProposal),
          confirmedAt: '2026-10-21T00:00:00Z',
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-proposal-invalid' }] })
    expect(
      buildMaterialAcceptanceControl(prepared.value, {
        route: 'omp-native-command',
        operationId: 'op-wrong-confirmation',
        proposalDigest: prepared.value.digest,
        confirmedAt: '2026-10-21T00:00:00Z',
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-confirmation-mismatch' }] })
    expect(
      buildMaterialAcceptanceControl(prepared.value, {
        route: 'omp-native-command',
        operationId: prepared.value.proposal.operationId,
        proposalDigest: 'a'.repeat(64),
        confirmedAt: '2026-10-21T00:00:00Z',
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-confirmation-mismatch' }] })
  })
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
      const pending = assessFixture(mandated, `context-only-${classification}`, initial, contextOnly, classification)
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
        buildMaterialAcceptanceControl(prepared.value, {
          route: 'omp-native-command',
          operationId: prepared.value.proposal.operationId,
          proposalDigest: prepared.value.digest,
          confirmedAt: '2026-10-21T00:00:00Z',
        }),
      ).toMatchObject({ ok: true })
    }
    const noOp = assessFixture(
      mandated,
      'context-only-no-op',
      initial,
      proposedAssessmentState(initial, { body: initial.snapshot.raw.body, content: unchangedContent }),
      'material',
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
      buildMaterialAcceptanceControl(mechanicalPrepared.value, {
        route: 'omp-native-command',
        operationId: mechanicalPrepared.value.proposal.operationId,
        proposalDigest: mechanicalPrepared.value.digest,
        confirmedAt: '2026-10-21T00:00:00Z',
      }),
    ).toMatchObject({ ok: true })
  })

  test('does not let editorial classification bypass structural, tier, child, or exclusion changes', () => {
    const { childSnapshot } = roxabiWorkflowFixtures()
    const mandated = featureMandate()
    const initial = mandateAssessmentState(mandated)
    const child = childSnapshot({ repository: SCOPE.repository, target: 'acme/app#43' }, 'child commitment')
    const proposed = [
      proposedAssessmentState(initial, {
        body: 'add C2',
        content: {
          criteria: [
            { id: 'C1', statement: BODY },
            { id: 'C2', statement: 'new commitment' },
          ],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
      }),
      proposedAssessmentState(initial, {
        body: 'remove C1',
        content: {
          criteria: [],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
      }),
      proposedAssessmentState(initial, {
        body: BODY,
        content: {
          criteria: [{ id: 'C1', statement: BODY }],
          invariants: [],
          exclusions: ['excluded work'],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
      }),
      proposedAssessmentState(initial, { body: BODY, tier: 'F-lite' }),
      proposedAssessmentState(initial, { body: BODY, children: [child] }),
    ]
    for (const [index, state] of proposed.entries()) {
      const assessment = assessFixture(mandated, `mechanical-${index}`, initial, state, 'editorial')
      expect(resolveAcceptedSpec(mandated, [history([mandated, assessment.start, assessment.result])])).toMatchObject({
        ok: true,
        spec: { ref: { version: initial.ref.version } },
      })
    }
    const childAdded = assessFixture(
      mandated,
      'add-child',
      initial,
      proposedAssessmentState(initial, { body: BODY, children: [child] }),
      'material',
    )
    const childAccepted = acceptMaterialFixture(mandated, 'accept-child', childAdded)
    const afterChild = acceptedMaterialState(childAdded, childAccepted)
    const presentationBody = `${child.snapshot.raw.body}\n`
    const presentationOnlyChild = {
      ...child,
      snapshot: {
        ...child.snapshot,
        raw: {
          ...child.snapshot.raw,
          body: presentationBody,
          bodySha256: specDigest(presentationBody),
          lastEditedAt: '2026-10-22T00:00:00Z',
        },
      },
    }
    const presentationOnly = assessFixture(
      mandated,
      'child-presentation-only',
      afterChild,
      proposedAssessmentState(afterChild, { body: BODY, children: [presentationOnlyChild] }),
      'editorial',
    )
    expect(
      resolveAcceptedSpec(mandated, [
        history([
          mandated,
          childAdded.start,
          childAdded.result,
          childAccepted,
          presentationOnly.start,
          presentationOnly.result,
        ]),
      ]),
    ).toMatchObject({
      ok: true,
      spec: { children: [{ snapshot: { raw: { body: presentationBody } } }] },
    })
  })
})
