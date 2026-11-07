import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { Scope } from '../record-values.ts'
import { BODY } from './workflow-test-support.ts'

export const landingFixtures = roxabiWorkflowFixtures()
export const nativeBody = strictSpecBody(BODY)

export function nativeSnapshot(scope: Scope, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T00:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('Expected a conformant declared Spec')
  return parsed.snapshot
}
