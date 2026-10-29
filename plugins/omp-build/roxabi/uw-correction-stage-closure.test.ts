import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeHistory, encodeRecord } from '../adapters/github/history-codec.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ObservedComment } from '../engine/review-schema.ts'
import { acceptedActionInputs, standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { NATIVE_AUTHOR, submission, TEST_SCOPE } from '../testing/record-builders.ts'
import { contribution } from '../testing/record-decisions.ts'
import { observedComment } from '../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { assertCurrentOutputClosure } from './uw-action-closure.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'

function valid(value: unknown): CanonicalRecord {
  const result = parseRecord(value)
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join('; '))
  return result.value
}

function fixtureRecords(): CanonicalRecord[] {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../engine/__tests__/fixtures/native-correction-records.json', import.meta.url), 'utf8'),
  )
  if (!Array.isArray(raw)) throw new Error('Expected correction records')
  return raw.map(valid)
}

function encodedHistory(records: CanonicalRecord[]): DecodedHistory {
  const comments: ObservedComment[] = []
  const source = {
    scope: TEST_SCOPE,
    expectedAuthor: NATIVE_AUTHOR,
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  }
  for (const record of records) {
    const encoded = encodeRecord(record, source, null)
    if (!encoded.ok) throw new Error(encoded.diagnostics.map((item) => item.message).join('; '))
    for (const body of encoded.value) {
      const id = String(comments.length + 100)
      comments.push(observedComment({ locator: `correction-${id}`, nativeId: id, body }))
    }
  }
  return decodeHistory(source)
}

function ref(record: CanonicalRecord): RecordInputRef {
  return {
    source: 'record',
    record: {
      scope: { repository: record.repository, target: record.target },
      kind: record.kind,
      recordId: record.recordId,
    },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  }
}

function setup() {
  const records = fixtureRecords()
  const decision = records.find((record) => record.kind === 'decision')
  const initial = records.find((record) => record.kind === 'review-attempt' && record.payload.stage === 'initial')
  if (
    decision?.kind !== 'decision' ||
    initial?.kind !== 'review-attempt' ||
    initial.payload.stage !== 'initial' ||
    initial.payload.purpose !== 'correction'
  )
    throw new Error('Expected correction decision and initial inventory')
  const initialInventory = initial
  const correctionRequestId = initial.payload.requestId
  const selectedDecision = decision
  const baseline = standaloneReviewInputs()
  const uw = { repository: TEST_SCOPE.repository, target: 'acme/widgets#7' }
  const subject = { kind: 'uw' as const, uw, pullRequest: TEST_SCOPE, binding: null }
  const sealedSubject = {
    ...subject,
    binding: {
      source: 'record' as const,
      record: { scope: TEST_SCOPE, kind: 'workflow-binding' as const, recordId: 'workflow-binding-fixture' },
      selector: '/payload',
      digest: '0'.repeat(64),
    },
  }
  const request: UwActionRequest = {
    actionId: 'next-correction-action',
    purpose: 'correction',
    subject,
    code: { ...baseline.manifest.code, repository: TEST_SCOPE.repository },
    stageSources: [],
    expandedContext: [],
  }
  function actionRecords(id: string) {
    const inventoryId = `${id}-inventory`
    const accepted = acceptedActionInputs(roxabiWorkflowFixtures().fixOnlyMandate(uw), 'correction')
    const manifest = {
      ...accepted.manifest,
      subject: sealedSubject,
      code: {
        ...accepted.manifest.code,
        repository: TEST_SCOPE.repository,
        head: initialInventory.payload.candidateGitSHA,
        referenceCommit: initialInventory.payload.candidateGitSHA,
      },
    }
    const inputs = {
      ...accepted,
      manifest,
      fingerprint: actionInputDigest(manifest),
      stageSources: [ref(selectedDecision)],
    }
    const inventory = valid({
      ...initialInventory,
      recordId: inventoryId,
      operationId: `op-${inventoryId}`,
      inputs: [correctionRequestId, selectedDecision.recordId],
      payload: {
        ...initialInventory.payload,
        rootAttemptId: inventoryId,
        actionInputDigest: inputs.fingerprint,
        slots: [
          {
            slotId: 'apply-slot',
            phase: 'fix',
            role: 'R-devops',
            chunk: null,
            required: true,
            output: 'action-result',
            classId: null,
            sourceFindingIds: [],
            action: { actionId: id, inputs },
            correction: { phase: 'apply', causeId: 'cause-region', context: {} },
          },
        ],
      },
    })
    const output = {
      outcome: 'applied',
      commitSHAs: [],
      commands: [],
      proofPaths: [],
      guardInventory: [],
      proofToolCallId: null,
      proofUnavailableReason: 'No command was run',
    }
    const result = valid(
      contribution({
        id: `${id}-result`,
        inventoryId,
        inputs: [inventoryId, correctionRequestId, selectedDecision.recordId],
        content: 'action-result',
        phase: 'fix',
        role: 'R-devops',
        slotId: 'apply-slot',
        chunk: null,
        structured: output,
        rawAttempts: [submission({ structuredOutput: { status: 'valid', data: output } })],
      }),
    )
    return { inventory, result }
  }
  const prior = actionRecords('prior-action')
  return { records, decision, request, prior, actionRecords, sealedSubject }
}

function expectRefused(result: Result<true>) {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('self-output')
}

describe('correction stage closure', () => {
  it('admits a prior decision and native action result before the new action has an inventory', () => {
    const { records, decision, request, prior, sealedSubject } = setup()
    const history = encodedHistory([...records, prior.inventory, prior.result])
    expect(
      assertCurrentOutputClosure({ ...request, stageSources: [ref(decision), ref(prior.result)] }, [history], []),
    ).toEqual({ ok: true, value: true })
    expectRefused(assertCurrentOutputClosure({ ...request, stageSources: [ref(prior.result)] }, [history], []))
    expectRefused(
      assertCurrentOutputClosure(
        {
          ...request,
          subject: { ...sealedSubject, binding: { ...sealedSubject.binding, digest: 'f'.repeat(64) } },
          stageSources: [ref(decision), ref(prior.result)],
        },
        [history],
        [],
      ),
    )
    if (request.subject.kind !== 'uw') throw new Error('Expected UW subject')
    expectRefused(
      assertCurrentOutputClosure(
        {
          ...request,
          subject: { ...request.subject, uw: { ...request.subject.uw, target: 'acme/widgets#99' } },
          stageSources: [ref(decision), ref(prior.result)],
        },
        [history],
        [],
      ),
    )
  })

  it('rejects current action output in stage or normative inputs', () => {
    const { records, decision, request, prior, actionRecords } = setup()
    const current = actionRecords('next-correction-action')
    const currentRequest = { ...request, actionId: current.inventory.recordId }
    const history = encodedHistory([...records, prior.inventory, prior.result, current.inventory, current.result])
    expectRefused(
      assertCurrentOutputClosure(
        { ...currentRequest, stageSources: [ref(decision), ref(current.result)] },
        [history],
        [],
      ),
    )
    expectRefused(
      assertCurrentOutputClosure(
        { ...request, actionId: 'prior-action', stageSources: [ref(decision), ref(prior.result)] },
        [history],
        [],
      ),
    )
    expectRefused(assertCurrentOutputClosure(currentRequest, [history], [ref(current.result)]))
  })

  it('rejects changed digests and wrong-scope references for both kinds of prior stage data', () => {
    const { records, decision, request, prior } = setup()
    const history = encodedHistory([...records, prior.inventory, prior.result])
    for (const record of [decision, prior.result]) {
      const source = ref(record)
      for (const invalid of [
        { ...source, digest: '0'.repeat(64) },
        { ...source, record: { ...source.record, scope: { ...source.record.scope, target: 'acme/widgets#43' } } },
      ])
        expectRefused(
          assertCurrentOutputClosure(
            { ...request, stageSources: record.kind === 'decision' ? [invalid] : [ref(decision), invalid] },
            [history],
            [],
          ),
        )
    }
  })

  it('rejects foreign operations and a contribution unbound to its native inventory slot', () => {
    const { records, decision, request, prior } = setup()
    const history = encodedHistory([...records, prior.inventory, prior.result])
    for (const record of [decision, prior.result, prior.inventory]) {
      const foreign: DecodedHistory = {
        ...history,
        operations: history.operations.map((operation) =>
          operation.recordId === record.recordId ? { ...operation, authority: 'foreign' } : operation,
        ),
      }
      const stageSources = record.kind === 'decision' ? [ref(decision)] : [ref(decision), ref(prior.result)]
      expectRefused(assertCurrentOutputClosure({ ...request, stageSources }, [foreign], []))
    }
    if (prior.result.kind !== 'contribution') throw new Error('Expected action contribution')
    const unbound = valid({
      ...prior.result,
      payload: { ...prior.result.payload, host: { ...prior.result.payload.host, slotId: 'other-slot' } },
    })
    const unboundHistory = encodedHistory([...records, prior.inventory, unbound])
    expectRefused(
      assertCurrentOutputClosure({ ...request, stageSources: [ref(decision), ref(unbound)] }, [unboundHistory], []),
    )
  })

  it('does not admit an unrelated root as stage data for review', () => {
    const { records, request, prior } = setup()
    const history = encodedHistory([...records, prior.inventory, prior.result])
    expectRefused(
      assertCurrentOutputClosure({ ...request, purpose: 'review', stageSources: [ref(prior.result)] }, [history], []),
    )
  })
})
