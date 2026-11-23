import { expect, test } from 'vitest'
import { buildRecord, canonicalValueDigest } from '../dist/contracts.js'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { shippedMandate } from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { sha256Bytes } from './uw-action-result.ts'
import { nonPlanExpansion } from './uw-context-negative-workflow.ts'

test('allows expansion from an authenticated strict implementation missing-context receipt', () => {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = shippedMandate()
  const start = fixtures.implementStart(mandate)
  const result = fixtures.rejectedImplementResult(mandate)
  if (
    start.payload.action !== 'implement' ||
    start.payload.phase !== 'start' ||
    result.payload.action !== 'implement' ||
    result.payload.phase !== 'result'
  )
    throw new Error('expected implementation pair')
  const { inputs: _inputs, ...draft } = result
  const negative = buildRecord({
    ...draft,
    payload: {
      ...result.payload,
      structured: {
        outcome: 'missing-context',
        missing: [
          {
            locator: { kind: 'information-request', description: 'Deployment region' },
            reason: 'Not in snapshot',
            targets: [],
          },
        ],
      },
      admission: null,
      diagnostics: [],
    },
  })
  if (!negative.ok) throw new Error(JSON.stringify(negative.diagnostics))
  const history = fixtures.historyFrom([mandate, start, negative.value])
  const ref = {
    source: 'record' as const,
    record: { scope: history.source.scope, kind: 'action-receipt' as const, recordId: negative.value.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(negative.value.payload),
  }
  const added = {
    source: 'git-file' as const,
    repository: mandate.repository,
    commit: 'b'.repeat(40),
    path: 'region.txt',
    digest: sha256Bytes(Buffer.from('region is eu-west')),
  }
  const request = {
    actionId: 'fresh-implement',
    purpose: 'implement' as const,
    subject: start.payload.inputs.manifest.subject,
    code: start.payload.inputs.manifest.code,
    stageSources: start.payload.inputs.stageSources,
    expandedContext: [ref, added],
  }
  const expanded = nonPlanExpansion(request, [history])
  expect(expanded, JSON.stringify(expanded)).toMatchObject({
    ok: true,
    value: { slot: { action: 'implement', exact: start.payload.exactInputs }, previous: start.payload.inputs },
  })
})
