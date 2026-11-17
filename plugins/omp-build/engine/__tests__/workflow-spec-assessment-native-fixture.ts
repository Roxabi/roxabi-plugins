import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import {
  type AssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { must, SCOPE } from './workflow-test-support.ts'

export const workflowFixtures = roxabiWorkflowFixtures()

export const nativeInitialBody = strictSpecBody('ship the bounded workflow')
export function parsedNativeSpec(body: string) {
  const parsed = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, body, '2026-10-21T00:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('Expected a conformant declared Spec')
  return parsed.snapshot
}
export function nativeMandate() {
  const mandate = shippedFeatureMandate()
  const record = must(
    parseRecord({
      ...mandate,
      payload: {
        ...mandate.payload,
        ownSpec: workflowFixtures.ownSpecFromSnapshot(SCOPE, parsedNativeSpec(nativeInitialBody)),
      },
    }),
  )
  if (record.kind !== 'mandate') throw new Error('Expected a native mandate')
  return record
}
export function nativeProposal(accepted: AssessmentState, body: string) {
  const spec = parsedNativeSpec(body).spec
  return proposedAssessmentState(accepted, {
    body,
    content: {
      criteria: spec.criteria,
      invariants: spec.invariants,
      exclusions: spec.exclusions,
      openQuestions: spec.openQuestions,
      sections: spec.sections,
    },
  })
}

export async function nativeEvidence(issue: DecodedHistory, body: string, tier: 'S' | 'F-lite') {
  const causal = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Bounded workflow',
        body,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: [`size:${tier}`],
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
  return { issue, pullRequest: null, parents: [], causal }
}
