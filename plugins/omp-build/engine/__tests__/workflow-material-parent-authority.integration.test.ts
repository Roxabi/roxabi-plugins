import { describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { conditionHolds } from '../workflow-condition-evaluation.ts'
import { executableGraph } from '../workflow-graph.ts'
import { effectiveMandateRole } from '../workflow-mandate.ts'
import { resolveOwnSpecAuthority, selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import { walkWorkflow } from '../workflow-walk.ts'
import {
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { BODY, facts, history, must, PARENT, SCOPE } from './workflow-test-support.ts'

const landingFixtures = roxabiWorkflowFixtures()
const parentBody = strictSpecBody(BODY)
const initialChildBody = strictSpecBody(BODY)
const childC2Body = strictSpecBody('child C2')
function nativeSnapshot(scope: typeof SCOPE, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T00:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('Expected a conformant declared Spec')
  return parsed.snapshot
}
async function parentEvidence(child: DecodedHistory, parent: DecodedHistory, childBody: string, tier: 'S' | 'F-lite') {
  const causal = await observeFixtureNativeWorld({
    root: PARENT,
    nodes: [
      {
        scope: PARENT,
        title: 'Child',
        body: childBody,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: [`size:${tier}`],
        parent: SCOPE,
        children: [],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
      {
        scope: SCOPE,
        title: 'Parent',
        body: parentBody,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: ['size:S'],
        parent: null,
        children: [PARENT],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
    histories: [child, parent],
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
  return { issue: child, pullRequest: null, parents: [parent], causal }
}

describe('material parent authority', () => {
  test('derives feature-origin parent commitments from the latest material acceptance', async () => {
    const child = landingFixtures.featureMandate(PARENT, {
      recordId: 'child-mandate',
      runId: 'run-child',
      operationId: 'op-child',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: initialChildBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, nativeSnapshot(PARENT, initialChildBody)),
    })
    const parent = landingFixtures.featureMandate(SCOPE, {
      recordId: 'parent-material',
      runId: 'run-parent',
      operationId: 'op-parent',
      branch: 'feature/parent',
      base: 'main',
      lineageHead: null,
      body: parentBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(SCOPE, nativeSnapshot(SCOPE, parentBody)),
    })
    const initial = mandateAssessmentState(parent)
    const parentContent = {
      criteria: initial.snapshot.spec.criteria,
      invariants: initial.snapshot.spec.invariants,
      exclusions: initial.snapshot.spec.exclusions,
      openQuestions: initial.snapshot.spec.openQuestions,
      sections: initial.snapshot.spec.sections,
    }
    const childC2Snapshot = nativeSnapshot(PARENT, childC2Body)
    const childC2Content = {
      criteria: childC2Snapshot.spec.criteria,
      invariants: childC2Snapshot.spec.invariants,
      exclusions: childC2Snapshot.spec.exclusions,
      openQuestions: childC2Snapshot.spec.openQuestions,
      sections: childC2Snapshot.spec.sections,
    }
    const changed = assessFixture(
      parent,
      'parent-child-change',
      initial,
      proposedAssessmentState(initial, {
        body: parentBody,
        content: parentContent,
        children: [
          { scope: PARENT, snapshot: childC2Snapshot, specVersion: childC2Snapshot.spec.version, tier: 'F-lite' },
        ],
      }),
      'material',
      [history([parent]), history([], PARENT)],
    )
    const acceptedChange = acceptMaterialFixture(parent, 'accept-parent-child-change', changed)
    const afterChange = acceptedMaterialState(changed, acceptedChange)
    expect(afterChange.ref).toEqual(initial.ref)
    expect(afterChange.children).toHaveLength(1)
    const removed = assessFixture(
      parent,
      'parent-child-removal',
      afterChange,
      proposedAssessmentState(afterChange, { body: parentBody, content: parentContent, children: [] }),
      'material',
      [history([parent, changed.start, changed.result, acceptedChange]), history([], PARENT)],
    )
    const acceptedRemoval = acceptMaterialFixture(parent, 'accept-parent-child-removal', removed, {
      scope: SCOPE,
      kind: 'operator-control',
      recordId: acceptedChange.recordId,
    })
    const afterRemoval = resolveAcceptedSpec(parent, [
      history([parent, changed.start, changed.result, acceptedChange, removed.start, removed.result, acceptedRemoval]),
      history([], PARENT),
    ])
    expect(afterRemoval).toMatchObject({
      ok: true,
      spec: { ref: initial.ref, children: [], coverage: null },
    })
    if (afterRemoval.ok) expect(afterRemoval.spec.chain.at(-1)?.source.recordId).toBe(acceptedRemoval.recordId)
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: {
          ...child.payload,
          parent: landingFixtures.mandateRef(parent),
          inheritedOwnSpecRefs: [afterChange.ref],
        },
      }),
    )
    if (childWithParent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const acceptedChildMandate = childWithParent
    const childHistory = history([childWithParent], PARENT)
    const changedParentHistory = history([parent, changed.start, changed.result, acceptedChange], SCOPE)
    const acceptedParent = resolveAcceptedSpec(parent, [changedParentHistory])
    if (acceptedParent.ok) {
      expect(acceptedParent.spec.ref).toEqual(initial.ref)
      expect(acceptedParent.spec.chain.at(-1)?.source.recordId).toBe(acceptedChange.recordId)
    }
    if (!acceptedParent.ok) throw new Error('changed parent Spec was not accepted')
    expect(effectiveMandateRole(parent.payload.role, acceptedParent.spec)).toBe('epic')
    expect(
      selectApplicableMandate(
        childHistory,
        [changedParentHistory],
        (await parentEvidence(childHistory, changedParentHistory, initialChildBody, 'S')).causal,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: 'materially-changed',
    })
    const childInitial = mandateAssessmentState(childWithParent)
    const childC2 = proposedAssessmentState(childInitial, {
      body: childC2Body,
      content: childC2Content,
      tier: 'F-lite',
    })
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
    async function assertChildAssessmentRoute() {
      const childEvidence = await parentEvidence(childHistory, changedParentHistory, childC2Body, 'F-lite')
      const childAuthority = resolveOwnSpecAuthority(childHistory, [changedParentHistory], childEvidence.causal)
      const childNext = reconstructWorkflow({
        evidence: childEvidence,
        facts: controlFacts,
        decisions: controlDecisions,
      })
      const acceptedForProbe = childAuthority.ok ? childAuthority.value.accepted : null
      const effective =
        acceptedForProbe === null
          ? null
          : resolveSpecEffective({
              mode: 'historical',
              own: acceptedForProbe.ref,
              versionVector: [acceptedForProbe.ref, ...acceptedForProbe.inheritedOwnSpecRefs],
              histories: childEvidence.causal.histories,
            })
      const graph = executableGraph(acceptedChildMandate)
      const walk = graph.ok
        ? walkWorkflow(graph.value, childEvidence, controlFacts, controlDecisions, acceptedChildMandate)
        : graph
      const differs = conditionHolds(
        'spec-differs',
        childHistory,
        controlFacts,
        controlDecisions,
        acceptedChildMandate,
        null,
        childEvidence.causal,
      )
      expect(
        childNext,
        JSON.stringify(
          {
            childAuthority: childAuthority.ok
              ? {
                  own: acceptedForProbe?.ref,
                  inherited: acceptedForProbe?.inheritedOwnSpecRefs,
                  snapshot: acceptedForProbe?.snapshot,
                  tier: acceptedForProbe?.tier,
                }
              : childAuthority,
            current: controlFacts.currentSpec,
            effective,
            differs,
            walk,
            childNext,
          },
          null,
          2,
        ),
      ).toMatchObject({ status: 'action', action: 'assess-spec', mandateId: childWithParent.recordId })
    }
    await assertChildAssessmentRoute()
    const childAssessment = assessFixture(childWithParent, 'child-c2-assessment', childInitial, childC2, 'material', [
      childHistory,
      changedParentHistory,
    ])
    const assessedChildHistory = history([childWithParent, childAssessment.start, childAssessment.result], PARENT)
    expect(
      reconstructWorkflow({
        evidence: await parentEvidence(assessedChildHistory, changedParentHistory, childC2Body, 'F-lite'),
        facts: controlFacts,
        decisions: controlDecisions,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
    const acceptedChild = acceptMaterialFixture(childWithParent, 'accept-child-c2', childAssessment)
    const acceptedChildHistory = history(
      [childWithParent, childAssessment.start, childAssessment.result, acceptedChild],
      PARENT,
    )
    expect(
      selectApplicableMandate(
        acceptedChildHistory,
        [changedParentHistory],
        (await parentEvidence(acceptedChildHistory, changedParentHistory, childC2Body, 'F-lite')).causal,
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
      resolveOwnSpecAuthority(
        childHistory,
        [parentHistory],
        (await parentEvidence(childHistory, parentHistory, initialChildBody, 'S')).causal,
      ),
    ).toMatchObject({ ok: true })
    expect(
      selectApplicableMandate(
        childHistory,
        [parentHistory],
        (await parentEvidence(childHistory, parentHistory, initialChildBody, 'S')).causal,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: 'unknown-binding',
    })
  })
})
