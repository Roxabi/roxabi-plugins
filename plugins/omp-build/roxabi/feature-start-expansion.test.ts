import { expect, test } from 'vitest'
import { rawSource } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest, buildRecord, canonicalValueDigest } from '../dist/contracts.js'
import { receiptStartKey } from '../engine/workflow-control.ts'
import { fixtureHostReviewClassCatalogues } from '../testing/host-catalogue-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { observedUwWithoutPullRequests } from '../testing/uw-completion-observation.ts'
import { BODY, SCOPE, shippedMandate } from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { authorizeExpandedStart } from './feature-start-expansion.ts'
import { sha256Bytes } from './uw-action-result.ts'
import { nonPlanExpansion } from './uw-context-negative-workflow.ts'

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

test.each(['conserved', 'absent', 'positive'] as const)(
  'allows implementation context expansion only from a conserved native negative (%s raw)',
  (native) => {
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
    const structured = {
      outcome: 'missing-context' as const,
      missing: [
        {
          locator: { kind: 'information-request' as const, description: 'Deployment region' },
          reason: 'Not in snapshot',
          targets: [],
        },
      ],
    }
    const { inputs: _inputs, ...draft } = result
    const negative = buildRecord({
      ...draft,
      payload: {
        ...result.payload,
        native: {
          ...result.payload.native,
          raw:
            native === 'absent'
              ? null
              : {
                  exitCode: 0,
                  structuredOutput: {
                    status: 'valid',
                    data: native === 'positive' ? result.payload.structured : structured,
                  },
                },
        },
        structured,
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
    if (native !== 'conserved') {
      expect(expanded).toMatchObject({ ok: false })
      return
    }
    expect(expanded, JSON.stringify(expanded)).toMatchObject({
      ok: true,
      value: { slot: { action: 'implement', exact: start.payload.exactInputs }, previous: start.payload.inputs },
    })
    const oldStart = buildRecord({
      ...start,
      recordId: 'disposed-start',
      operationId: 'disposed-start-op',
      payload: { ...start.payload, actionId: 'disposed-implementation' },
    })
    if (!oldStart.ok) throw new Error(JSON.stringify(oldStart.diagnostics))
    if (
      negative.value.kind !== 'action-receipt' ||
      negative.value.payload.action !== 'implement' ||
      negative.value.payload.phase !== 'result'
    )
      throw new Error('expected implementation negative')
    const oldResult = buildRecord({
      ...negative.value,
      recordId: 'disposed-result',
      operationId: 'disposed-result-op',
      payload: {
        ...negative.value.payload,
        actionId: 'disposed-implementation',
        start: { scope: history.source.scope, kind: 'action-receipt', recordId: oldStart.value.recordId },
      },
    })
    if (!oldResult.ok || oldResult.value.kind !== 'action-receipt') throw new Error('expected disposed negative')
    const combined = fixtures.historyFrom([mandate, oldStart.value, oldResult.value, start, negative.value])
    expect(nonPlanExpansion(request, [combined]).ok).toBe(false)
    expect(nonPlanExpansion(request, [combined], new Set([receiptStartKey(oldResult.value)]))).toMatchObject({
      ok: true,
      value: { negative: { recordId: negative.value.recordId } },
    })
    expect(nonPlanExpansion(request, [combined], new Set(['unrelated-start']))).toMatchObject({ ok: false })
    const [planStart, planResult] = fixtures.planDraftRecords(mandate)
    if (
      planStart?.kind !== 'action-receipt' ||
      planStart.payload.action !== 'plan' ||
      planStart.payload.phase !== 'start' ||
      planResult?.kind !== 'action-receipt' ||
      planResult.payload.action !== 'plan' ||
      planResult.payload.phase !== 'result'
    )
      throw new Error('expected independent plan pair')
    const planNegative = buildRecord({
      ...planResult,
      payload: {
        ...planResult.payload,
        structured: {
          outcome: 'missing-context',
          missing: [
            { locator: { kind: 'information-request', description: 'Other hold' }, reason: 'needed', targets: [] },
          ],
        },
      },
    })
    if (!planNegative.ok) throw new Error(JSON.stringify(planNegative.diagnostics))
    const independent = fixtures.historyFrom([
      mandate,
      oldStart.value,
      oldResult.value,
      start,
      negative.value,
      planStart,
      planNegative.value,
    ])
    expect(nonPlanExpansion(request, [independent], new Set([receiptStartKey(oldResult.value)]))).toMatchObject({
      ok: false,
    })
  },
)
