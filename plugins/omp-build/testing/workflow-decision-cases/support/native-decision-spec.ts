import { parseIssueSpecBody, rawSource } from '../../../adapters/github-native/uw-spec.ts'
import { parseRecord } from '../../../engine/record-construction.ts'
import type { MandateRecord } from '../../../engine/workflow-control.ts'
import { strictSpecBody } from '../../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { roxabiWorkflowFixtures } from '../../roxabi-presets.ts'
import { BODY, SCOPE } from './workflow-decision-fixtures.ts'

// This issue body is a declared native observation; the accepted record is parsed from it.
export const nativeDecisionBody = strictSpecBody(BODY)
const parsed = parseIssueSpecBody({
  uw: SCOPE,
  raw: rawSource(SCOPE.target, nativeDecisionBody, '2026-10-21T12:00:00Z'),
})
if (parsed.status !== 'conformant') throw new Error('Expected a conformant decision fixture Spec')
const snapshot = parsed.snapshot

export function nativeDecisionMandate(mandate: MandateRecord): MandateRecord {
  const result = parseRecord({
    ...mandate,
    payload: {
      ...mandate.payload,
      ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(SCOPE, snapshot),
    },
  })
  if (!result.ok || result.value.kind !== 'mandate') throw new Error('Expected a canonical decision mandate')
  return result.value
}
