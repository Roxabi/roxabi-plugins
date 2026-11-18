import { describe, expect, test } from 'vitest'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import { buildRecord } from '../engine/record-construction.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { shippedMandate } from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { plannerExpansion } from './uw-action-negative-expansion.ts'
import { sha256Bytes } from './uw-action-result.ts'

function fixture() {
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
  const ref = {
    source: 'record' as const,
    record: { scope: history.source.scope, kind: 'action-receipt' as const, recordId: negative.value.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(negative.value.payload),
  }
  const bytes = Buffer.from('region is eu-west')
  const added = {
    source: 'git-file' as const,
    repository: mandate.repository,
    commit: 'b'.repeat(40),
    path: 'region.txt',
    digest: sha256Bytes(bytes),
  }
  const request: UwActionRequest = {
    actionId: 'fresh-plan',
    purpose: 'plan',
    subject: start.payload.inputs.manifest.subject,
    code: start.payload.inputs.manifest.code,
    stageSources: start.payload.inputs.stageSources,
    expandedContext: [ref, added],
  }
  return { history, request, ref, added, mandate, start, negative: negative.value }
}

describe('planner negative expansion authentication', () => {
  test('requires the exact authenticated terminal and genuinely additional context', () => {
    const { history, request, ref, added } = fixture()
    const valid = plannerExpansion(request, [history])
    expect(valid.ok && valid.value !== null).toBe(true)
    expect(plannerExpansion({ ...request, expandedContext: [ref] }, [history]).ok).toBe(false)
    expect(plannerExpansion({ ...request, actionId: 'act-plan-1' }, [history]).ok).toBe(false)
    expect(
      plannerExpansion({ ...request, expandedContext: [{ ...ref, digest: '0'.repeat(64) }, added] }, [history]).ok,
    ).toBe(false)
  })

  test('rejects changed authority and incomplete history', () => {
    const { history, request } = fixture()
    expect(plannerExpansion({ ...request, code: { ...request.code, head: 'c'.repeat(40) } }, [history]).ok).toBe(false)
    expect(plannerExpansion(request, [{ ...history, source: { ...history.source, complete: false } }]).ok).toBe(false)
  })

  test('requires the current authenticated negative after a repeated negative', () => {
    const { request, ref, added, mandate, start, negative } = fixture()
    if (
      start.payload.action !== 'plan' ||
      start.payload.phase !== 'start' ||
      negative.payload.action !== 'plan' ||
      negative.payload.phase !== 'result'
    )
      throw new Error('expected plan pair')
    const manifest = { ...start.payload.inputs.manifest, expandedContext: [...request.expandedContext] }
    const inputs = { ...start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
    const nextStart = buildRecord({
      ...start,
      recordId: 'expanded-start',
      operationId: 'expanded-plan-operation',
      payload: { ...start.payload, actionId: request.actionId, inputs },
    })
    if (!nextStart.ok) throw new Error(JSON.stringify(nextStart.diagnostics))
    const nextResult = buildRecord({
      ...negative,
      recordId: 'expanded-negative',
      operationId: 'expanded-plan-result',
      payload: {
        ...negative.payload,
        actionId: request.actionId,
        inputs,
        start: {
          scope: request.subject.kind === 'uw' ? request.subject.uw : ref.record.scope,
          recordId: nextStart.value.recordId,
          kind: 'action-receipt',
        },
      },
    })
    if (!nextResult.ok) throw new Error(JSON.stringify(nextResult.diagnostics))
    const history = roxabiWorkflowFixtures().historyFrom([mandate, start, negative, nextStart.value, nextResult.value])
    const nextRef = {
      ...ref,
      record: { ...ref.record, recordId: nextResult.value.recordId },
      digest: canonicalValueDigest(nextResult.value.payload),
    }
    const another = { ...added, path: 'second-context.txt', digest: 'c'.repeat(64) }
    const fresh = { ...request, actionId: 'expanded-plan-again', expandedContext: [ref, added, nextRef, another] }
    const selected = plannerExpansion(fresh, [history])
    expect(selected.ok && selected.value?.leaf.recordId).toBe('expanded-negative')
    expect(plannerExpansion({ ...fresh, expandedContext: [ref, added, another] }, [history]).ok).toBe(false)
    expect(plannerExpansion({ ...fresh, expandedContext: [ref, added, nextRef] }, [history]).ok).toBe(false)
  })
})
