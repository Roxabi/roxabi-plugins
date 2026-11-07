import { expect, test } from 'vitest'
import { rawSource } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest, buildRecord, canonicalValueDigest } from '../dist/contracts.js'
import { fixtureHostReviewClassCatalogues } from '../testing/host-catalogue-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { observedUwWithoutPullRequests } from '../testing/uw-completion-observation.ts'
import { BODY, SCOPE, shippedMandate } from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { authorizeExpandedStart } from './feature-start-expansion.ts'
import { sha256Bytes } from './uw-action-result.ts'

test('rejects an expanded plan start that changes the authenticated original semantic slot', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = shippedMandate()
  const [start, result] = fixtures.planDraftRecords(mandate)
  if (
    start?.kind !== 'action-receipt' ||
    start.payload.action !== 'plan' ||
    start.payload.phase !== 'start' ||
    result?.kind !== 'action-receipt' ||
    result.payload.action !== 'plan' ||
    result.payload.phase !== 'result'
  )
    throw new Error('expected plan pair')
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
    },
  })
  if (!negative.ok) throw new Error(JSON.stringify(negative.diagnostics))
  const history = fixtures.historyFrom([mandate, start, negative.value])
  const date = '2026-10-27T12:00:00.000Z'
  const observation = await observedUwWithoutPullRequests({
    graph: {
      status: 'complete',
      root: SCOPE,
      observedAt: date,
      nodes: [
        {
          uw: SCOPE,
          title: 'Save region',
          raw: rawSource(SCOPE.target, BODY, date),
          updatedAt: date,
          labels: ['size:S'],
          wayfinderLabels: [],
          parent: null,
          children: [],
          blockers: [],
          native: { state: 'OPEN', stateReason: null },
        },
      ],
    },
    histories: [history],
    catalogues: fixtureHostReviewClassCatalogues(),
  })
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
  const manifest = { ...start.payload.inputs.manifest, expandedContext: [ref, added] }
  const inputs = { ...start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const changed = {
    ...start.payload,
    actionId: 'fresh-plan',
    inputs,
    exactInputs: { ...start.payload.exactInputs, specDigest: '0'.repeat(64) },
  }
  expect(
    authorizeExpandedStart(changed, [history], {
      histories: observation.histories,
      catalogues: observation.catalogues,
      observation,
    }),
  ).toEqual({ ok: false, reason: 'review-input-changed' })
})
