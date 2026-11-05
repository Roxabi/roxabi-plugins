import { describe, expect, test } from 'vitest'
import { fixtureCausal, workflowEvidence } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { parseRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { effectiveMandateRole } from '../workflow-mandate.ts'
import { resolveOwnSpecAuthority, selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { BODY, facts, history, must, PARENT, SCOPE } from './workflow-test-support.ts'

const landingFixtures = roxabiWorkflowFixtures()

describe('material parent authority', () => {
  test('derives feature-origin parent commitments from the latest material acceptance', () => {
    const child = landingFixtures.featureMandate(PARENT, {
      recordId: 'child-mandate',
      runId: 'run-child',
      operationId: 'op-child',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: BODY,
    })
    const parent = landingFixtures.featureMandate(SCOPE, {
      recordId: 'parent-material',
      runId: 'run-parent',
      operationId: 'op-parent',
      branch: 'feature/parent',
      base: 'main',
      lineageHead: null,
      body: BODY,
    })
    const initial = mandateAssessmentState(parent)
    const changed = assessFixture(
      parent,
      'parent-child-change',
      initial,
      proposedAssessmentState(initial, {
        body: BODY,
        children: [{ ...landingFixtures.childSnapshot(PARENT, 'child C2'), tier: 'F-lite' }],
      }),
      'material',
    )
    const acceptedChange = acceptMaterialFixture(parent, 'accept-parent-child-change', changed)
    const afterChange = acceptedMaterialState(changed, acceptedChange)
    const removed = assessFixture(
      parent,
      'parent-child-removal',
      afterChange,
      proposedAssessmentState(afterChange, { body: BODY, children: [] }),
      'material',
    )
    const acceptedRemoval = acceptMaterialFixture(parent, 'accept-parent-child-removal', removed, afterChange)
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: { ...child.payload, parent: landingFixtures.mandateRef(parent) },
      }),
    )
    if (childWithParent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const childHistory = history([childWithParent], PARENT)
    const changedParentHistory = history([parent, changed.start, changed.result, acceptedChange], SCOPE)
    const acceptedParent = resolveAcceptedSpec(parent, [changedParentHistory])
    if (!acceptedParent.ok) throw new Error('changed parent Spec was not accepted')
    expect(effectiveMandateRole(parent.payload.role, acceptedParent.spec)).toBe('epic')
    expect(
      selectApplicableMandate(
        childHistory,
        [changedParentHistory],
        fixtureCausal([childHistory, changedParentHistory]),
      ),
    ).toMatchObject({
      status: 'refused',
      reason: 'materially-changed',
    })
    const childInitial = mandateAssessmentState(childWithParent)
    const childC2 = proposedAssessmentState(childInitial, { body: 'child C2', tier: 'F-lite' })
    const controlFacts = facts({
      productVersion: childWithParent.payload.config.productVersion,
      configVersion: childWithParent.payload.config.version,
      configDigest: childWithParent.payload.config.digest,
      supportedConfigVersions: [childWithParent.payload.config.version],
      currentSpec: childC2,
      identityAllocations: childWithParent.payload.ownSpec.identityAllocations,
    })
    const controlDecisions = {
      reviewStep: null,
      epicStep: 'start' as const,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent' as const, evidence: [] },
      landing: { status: 'absent' as const, evidence: [] },
      watch: { status: 'absent' as const, evidence: [] },
    }
    expect(
      reconstructWorkflow({
        evidence: workflowEvidence(childHistory, null, [changedParentHistory], []),
        facts: controlFacts,
        decisions: controlDecisions,
      }),
    ).toMatchObject({ status: 'action', action: 'assess-spec', mandateId: childWithParent.recordId })
    const childAssessment = assessFixture(childWithParent, 'child-c2-assessment', childInitial, childC2, 'material')
    const assessedChildHistory = history([childWithParent, childAssessment.start, childAssessment.result], PARENT)
    expect(
      reconstructWorkflow({
        evidence: workflowEvidence(assessedChildHistory, null, [changedParentHistory], []),
        facts: controlFacts,
        decisions: controlDecisions,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
    const acceptedChild = acceptMaterialFixture(childWithParent, 'accept-child-c2', childAssessment)
    expect(
      selectApplicableMandate(
        history([childWithParent, childAssessment.start, childAssessment.result, acceptedChild], PARENT),
        [changedParentHistory],
        fixtureCausal([
          history([childWithParent, childAssessment.start, childAssessment.result, acceptedChild], PARENT),
          changedParentHistory,
        ]),
      ),
    ).toMatchObject({ status: 'applicable', mandate: { recordId: childWithParent.recordId } })
    const parentHistory = history(
      [parent, changed.start, changed.result, acceptedChange, removed.start, removed.result, acceptedRemoval],
      SCOPE,
    )

    const removedParent = resolveAcceptedSpec(parent, [parentHistory])
    if (!removedParent.ok) throw new Error('removed parent Spec was not accepted')
    expect(effectiveMandateRole(parent.payload.role, removedParent.spec)).toBe('feature')
    expect(
      resolveOwnSpecAuthority(childHistory, [parentHistory], fixtureCausal([childHistory, parentHistory])),
    ).toMatchObject({ ok: true })
    expect(
      selectApplicableMandate(childHistory, [parentHistory], fixtureCausal([childHistory, parentHistory])),
    ).toMatchObject({
      status: 'refused',
      reason: 'unknown-binding',
    })
  })
})
