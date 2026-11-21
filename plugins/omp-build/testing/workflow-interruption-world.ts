import {
  appendRecords,
  INTERRUPTED_IMPLEMENTATION_ADMISSION,
  interruptedResult,
  interruptionResolution,
  type PlannedRecord,
  pairOf,
  resumeOf,
} from '../engine/__tests__/workflow-interruption-support.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { reconstructWorkflow } from '../engine/workflow-reconstruction-admission.ts'
import type { WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import { fixtureReviewClassCatalogues } from './action-input-fixtures.ts'
import { readDeclaredNativeWorld } from './declared-native-observation.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { nativeDecisionBody, nativeDecisionMandate } from './workflow-decision-cases/support/native-decision-spec.ts'
import {
  authenticatedPlanFixtures,
  decisions,
  eligiblePlan,
  SCOPE,
  shippedFacts,
  shippedMandate,
} from './workflow-decision-cases/support/workflow-decision-fixtures.ts'

const { historyFrom, implementStart, pauseConfirmed, pauseRequested, rejectedImplementResult } =
  roxabiWorkflowFixtures()

export async function observe(issue: DecodedHistory) {
  return readDeclaredNativeWorld(
    {
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Save the selected region',
          body: nativeDecisionBody,
          updatedAt: '2026-10-21T12:00:00Z',
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
    },
    fixtureReviewClassCatalogues,
  )
}

export async function decide(issue: DecodedHistory, mandate: MandateRecord, facts: Partial<WorkflowFacts> = {}) {
  const observation = await observe(issue)
  if (observation.status !== 'complete') throw new Error('Expected a complete native observation')
  const causal = { histories: observation.histories, catalogues: observation.catalogues, observation }
  return reconstructWorkflow({
    evidence: { issue, pullRequest: null, parents: [], causal },
    facts: { ...shippedFacts(mandate), ...facts },
    decisions: decisions(),
  })
}

export function planWorld() {
  const mandate = nativeDecisionMandate(shippedMandate())
  const authenticated = authenticatedPlanFixtures(mandate, [historyFrom([mandate])])
  const [start, result] = pairOf(authenticated.workflow.planDraftRecords(mandate, 'act-plan-1', authenticated.version))
  const request = pauseRequested(mandate)
  const pause = pauseConfirmed(mandate, request)
  return {
    mandate,
    authenticated,
    start,
    result,
    interrupted: interruptedResult(result),
    request,
    pause,
    resume: resumeOf(mandate, pause),
    paused: [request, pause] as CanonicalRecord[],
    issue: (records: readonly (CanonicalRecord | PlannedRecord)[]) => appendRecords(historyFrom([mandate]), records),
  }
}

export function implementationWorld() {
  const mandate = nativeDecisionMandate(shippedMandate())
  const start = implementStart(mandate)
  const interrupted = interruptedResult(rejectedImplementResult(mandate), {
    admission: INTERRUPTED_IMPLEMENTATION_ADMISSION,
  })
  const request = pauseRequested(mandate)
  const pause = pauseConfirmed(mandate, request)
  const resolution = interruptionResolution({
    mandate,
    pause,
    start,
    result: interrupted,
  })
  const resume = resumeOf(mandate, pause)
  return {
    mandate,
    start,
    interrupted,
    request,
    pause,
    resume,
    resolution,
    resolved: [request, pause, resolution, resume] as (CanonicalRecord | PlannedRecord)[],
    issue: (records: readonly (CanonicalRecord | PlannedRecord)[]) =>
      appendRecords(historyFrom(eligiblePlan(mandate, [historyFrom([mandate])])), records),
  }
}
