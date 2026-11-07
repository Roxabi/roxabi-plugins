import { describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { parseRecord } from '../record-construction.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
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
  test.each(['conflicting', 'undetermined'] as const)(
    'refuses material acceptance when compatibility is %s',
    (state) => {
      const mandate = featureMandate()
      const accepted = mandateAssessmentState(mandate)
      const fixture = assessFixture(
        mandate,
        `compatibility-${state}`,
        accepted,
        proposedAssessmentState(accepted, { body: 'Changed material' }),
        'material',
        [history([mandate])],
      )
      const control = acceptMaterialFixture(mandate, `accept-${state}`, fixture)
      const structured = fixture.result.payload.structured
      if (structured === null || !('compatibility' in structured))
        throw new Error('Expected a compatibility assessment')
      const examined = structured.compatibility.examined
      const first = examined[0]
      const compatibility =
        state === 'undetermined'
          ? { state, examined, constraints: [first], references: [], reason: 'Unresolved constraint' }
          : {
              state,
              examined,
              conflicts: [
                {
                  left: first,
                  right: first,
                  reason: 'Conflicting constraints',
                  references: [
                    {
                      source: 'git-file',
                      repository: 'example/repo',
                      commit: 'a'.repeat(40),
                      path: 'proof',
                      digest: 'b'.repeat(64),
                    },
                  ],
                },
              ],
            }
      const result = must(
        parseRecord({
          ...fixture.result,
          payload: { ...fixture.result.payload, structured: { ...structured, compatibility } },
        }),
      )
      expect(resolveAcceptedSpec(mandate, [history([mandate, fixture.start, result, control])])).toMatchObject({
        ok: false,
      })
    },
  )

  test('keeps unknown assessments operator-decidable and binds material acceptance to its exact proposal', async () => {
    const initialBody = strictSpecBody(BODY)
    const unknownBody = strictSpecBody('unknown body')
    const original = parseIssueSpecBody({
      uw: SCOPE,
      raw: rawSource(SCOPE.target, initialBody, '2026-10-21T00:00:00Z'),
    })
    const proposedNative = parseIssueSpecBody({
      uw: SCOPE,
      raw: rawSource(SCOPE.target, unknownBody, '2026-10-21T00:00:00Z'),
    })
    if (original.status !== 'conformant' || proposedNative.status !== 'conformant')
      throw new Error('Expected native Spec snapshots')
    const base = featureMandate()
    const mandated = must(
      parseRecord({
        ...base,
        payload: {
          ...base.payload,
          ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(SCOPE, original.snapshot),
        },
      }),
    )
    if (mandated.kind !== 'mandate') throw new Error('Expected a mandate')
    const initial = mandateAssessmentState(mandated)
    const unknown = assessFixture(
      mandated,
      'unknown',
      initial,
      proposedAssessmentState(initial, {
        body: unknownBody,
        content: {
          criteria: proposedNative.snapshot.spec.criteria,
          invariants: proposedNative.snapshot.spec.invariants,
          exclusions: proposedNative.snapshot.spec.exclusions,
          openQuestions: proposedNative.snapshot.spec.openQuestions,
          sections: proposedNative.snapshot.spec.sections,
        },
      }),
      'unknown',
      [history([mandated])],
    )
    const issue = history([mandated, unknown.start, unknown.result])
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: unknownBody,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [issue],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    expect(
      reconstructWorkflow({
        evidence: { issue, pullRequest: null, parents: [], causal },
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
      [history([mandated])],
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
    if (wrongProposal.kind !== 'operator-control' || wrongProposal.payload.control !== 'accept-material')
      throw new Error('expected material acceptance control fixture')
    const badSuffix = must(
      parseRecord({
        ...wrongProposal,
        inputs: [...wrongProposal.inputs, exact.recordId],
        payload: {
          ...wrongProposal.payload,
          predecessor: { scope: SCOPE, recordId: exact.recordId, kind: 'operator-control' },
        },
      }),
    )
    expect(
      resolveSpecEffective({
        mode: 'historical',
        own: initial.ref,
        versionVector: [initial.ref],
        histories: [history([mandated, removed.start, removed.result, exact, badSuffix])],
      }).ok,
    ).toBe(false)
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
      const refusal = resolveAcceptedSpec(mandated, [history([mandated, removed.start, removed.result, control])])
      expect(refusal).toMatchObject({
        ok: false,
        evidence: expect.arrayContaining([expect.objectContaining({ code: 'material-spec' })]),
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
    const pending = assessFixture(mandated, 'prepare-remove-c1', initial, removedProposed, 'material', [
      history([mandated]),
    ])
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
          format: 'omp-build-material-acceptance/2',
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

    const control = buildMaterialAcceptanceControl(
      prepared.value,
      {
        route: 'omp-native-command',
        operationId: prepared.value.proposal.operationId,
        proposalDigest: prepared.value.digest,
        confirmedAt: '2026-10-21T00:00:00Z',
      },
      { histories, mandate: mandated },
    )
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

    const duplicate = assessFixture(mandated, 'prepare-remove-c1-b', initial, removedProposed, 'material', [
      history([mandated]),
    ])
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

    const malformed = assessFixture(mandated, 'prepare-malformed', initial, removedProposed, null, [
      history([mandated]),
    ])
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
      [history([mandated])],
    )
    const stale = assessFixture(mandated, 'prepare-stale-remove', initial, removedProposed, 'material', [
      history([mandated]),
    ])
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

    const equivalent = assessFixture(mandated, 'prepare-remove-equivalent', initial, removedProposed, 'material', [
      history([mandated]),
    ])
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
        { histories, mandate: mandated },
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
        { histories, mandate: mandated },
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
        { histories, mandate: mandated },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-proposal-stale' }] })
    expect(
      buildMaterialAcceptanceControl(
        prepared.value,
        {
          route: 'omp-native-command',
          operationId: 'op-wrong-confirmation',
          proposalDigest: prepared.value.digest,
          confirmedAt: '2026-10-21T00:00:00Z',
        },
        { histories, mandate: mandated },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-confirmation-mismatch' }] })
    expect(
      buildMaterialAcceptanceControl(
        prepared.value,
        {
          route: 'omp-native-command',
          operationId: prepared.value.proposal.operationId,
          proposalDigest: 'a'.repeat(64),
          confirmedAt: '2026-10-21T00:00:00Z',
        },
        { histories, mandate: mandated },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'material-confirmation-mismatch' }] })
  })
})
