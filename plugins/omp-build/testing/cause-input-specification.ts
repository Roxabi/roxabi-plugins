import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { Scope } from '../engine/record-values.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

export const causeFixtureScope: Scope = { repository: 'acme/app', target: 'acme/app#42' }
const content = canonicalSpec({
  format: 'omp-build-spec-content/1',
  criteria: [{ id: 'C1', statement: 'Save the selected region' }],
  invariants: [],
  exclusions: [],
  openQuestions: [],
  sections: { origin: '', context: '', change: '' },
})
if (!content.ok) throw new Error('Invalid cause fixture Spec')
const body = renderIssueSpecBody(content.value)
const parsed = parseIssueSpecBody({
  uw: causeFixtureScope,
  raw: rawSource(causeFixtureScope.target, body, '2026-10-27T12:00:00.000Z'),
})
if (parsed.status !== 'conformant') throw new Error('Invalid cause fixture native Spec')
export const causeFixtureSnapshot = parsed.snapshot
const fixtures = roxabiWorkflowFixtures()
const mandate = fixtures.featureMandate(causeFixtureScope, {
  recordId: 'mandate-42',
  body,
  ownSpec: fixtures.ownSpecFromSnapshot(causeFixtureScope, causeFixtureSnapshot),
})

export function causeFixtureMandate() {
  return mandate
}
