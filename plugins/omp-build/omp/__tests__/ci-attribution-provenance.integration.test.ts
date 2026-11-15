import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { actionInputDigest, canonicalValueDigest } from '../../engine/action-input.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Result } from '../../engine/result.ts'
import { accounted } from '../../engine/review-context-authentication.ts'
import type { ActionSubject, RecordInputRef, UwActionRequest } from '../../roxabi/uw-action-contract.ts'
import { refuseOutsideStage } from '../../roxabi/uw-action-stage-closure.ts'
import { appendApprovedReview, pullHistory, setFailedCi } from '../../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { isolatedPinSandbox } from '../../testing/isolated-pin-sandbox.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

async function assertForeignEvidence(
  check: (candidate: UwActionRequest, bound?: ActionSubject, histories?: readonly DecodedHistory[]) => Result<true>,
  refused: (result: Result<true>) => void,
) {
  const foreignFixture = arrangeReviewFixture()
  roots.add(foreignFixture.box.root)
  const foreignPin = isolatedPinSandbox(foreignFixture.box)
  const foreignControl = path.join(foreignFixture.box.root, 'pin-control.json')
  writeFileSync(foreignControl, JSON.stringify({ shared: foreignPin.candidate }))
  foreignFixture.box.env = { ...foreignPin.env, PIN_CONTROL_FILE: foreignControl }
  await seedReviewFixture(foreignFixture.box, foreignFixture.cwd)
  appendApprovedReview(foreignFixture.box, foreignFixture.cwd)
  setFailedCi(foreignFixture.box)
  writeFileSync(foreignControl, '{}')
  const foreignRun = spawnSync(
    BUN,
    [
      path.resolve(import.meta.dirname, '../../testing/ci-attribution-provenance-prefix-runner.ts'),
      foreignFixture.cwd,
      'capture-intake',
    ],
    {
      cwd: foreignFixture.cwd,
      env: foreignFixture.box.env,
      encoding: 'utf8',
      timeout: 55_000,
    },
  )
  expect(foreignRun.status, `${foreignRun.stderr}\n${foreignRun.stdout}`).toBe(0)
  const foreignObserved = JSON.parse(foreignRun.stdout) as { intake?: ActionInputs }
  if (!foreignObserved.intake) throw new Error('foreign-intake-missing')
  const foreignIntake = { inputs: foreignObserved.intake }
  const foreignSubject = foreignIntake.inputs.manifest.subject
  if (foreignSubject.kind !== 'uw' || !foreignSubject.binding || !foreignSubject.pullRequest)
    throw new Error('foreign-bound-subject-missing')
  const foreignHistory = pullHistory(foreignFixture.box)
  const foreignRef = foreignIntake.inputs.stageSources[0]
  if (!foreignRef) throw new Error('foreign-attribution-ref-missing')
  const foreignOperation = foreignHistory.operations.find(
    (operation) => operation.recordId === foreignRef.record.recordId,
  )
  if (!foreignOperation?.record || !accounted(foreignHistory, foreignOperation.record))
    throw new Error('independent-attribution-not-accounted')
  const foreignRequest: UwActionRequest = {
    actionId: 'foreign-attribution-probe',
    purpose: 'correction',
    subject: foreignSubject,
    code: foreignIntake.inputs.manifest.code,
    stageSources: [foreignRef],
    expandedContext: [],
  }
  expect(check(foreignRequest, foreignSubject, [foreignHistory])).toEqual({ ok: true, value: true })
  const foreignParts = new Set(foreignOperation.parts.map((part) => part.locator))
  const foreignAuthored = decodeHistory({
    ...foreignHistory.source,
    comments: foreignHistory.source.comments.map((comment) =>
      foreignParts.has(comment.locator) ? { ...comment, author: 'foreign-author' } : comment,
    ),
  })
  refused(check(foreignRequest, foreignSubject, [foreignAuthored]))
  const decodedForeign = foreignAuthored.operations.find(
    (operation) => operation.recordId === foreignRef.record.recordId,
  )
  if (decodedForeign?.authority !== 'foreign') throw new Error('foreign-operation-not-decoded')
  refused(
    check(foreignRequest, foreignSubject, [
      { ...foreignAuthored, operations: [...foreignAuthored.operations, decodedForeign] },
    ]),
  )
}

async function captureLeafAttribution() {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const pin = isolatedPinSandbox(box)
  const control = path.join(box.root, 'pin-control.json')
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  box.env = { ...pin.env, PIN_CONTROL_FILE: control }
  await seedReviewFixture(box, cwd)
  appendApprovedReview(box, cwd)
  setFailedCi(box)
  writeFileSync(control, '{}')
  const run = spawnSync(
    BUN,
    [
      path.resolve(import.meta.dirname, '../../testing/ci-attribution-provenance-prefix-runner.ts'),
      cwd,
      'capture-intake',
    ],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
      timeout: 55_000,
    },
  )
  expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
  const observed = JSON.parse(run.stdout) as { intake?: ActionInputs }
  if (!observed.intake) throw new Error('intake-manifest-missing')
  const intake = { inputs: observed.intake }
  const subject = intake.inputs.manifest.subject
  if (subject.kind !== 'uw' || !subject.binding || !subject.pullRequest) throw new Error('bound-subject-missing')
  const history = pullHistory(box)
  const receipt = history.operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.phase === 'result' &&
      operation.record.payload.action === 'attribute-ci',
  )?.record
  if (
    receipt?.kind !== 'action-receipt' ||
    receipt.payload.phase !== 'result' ||
    receipt.payload.action !== 'attribute-ci'
  )
    throw new Error('attribute-ci-result-missing')
  const receiptPayload = receipt.payload
  const binding = history.operations.find(
    (operation) =>
      operation.record?.kind === 'workflow-binding' && operation.record.recordId === subject.binding?.record.recordId,
  )?.record
  if (binding?.kind !== 'workflow-binding') throw new Error('workflow-binding-missing')
  expect(receipt.payload.inputs.manifest.subject).toEqual(subject)
  expect(receipt.payload.mandate).toEqual(binding.payload.mandate)
  const attribution = intake.inputs.stageSources[0]
  if (!attribution) throw new Error('attribution-ref-missing')
  expect(attribution.record.recordId).toBe(receipt.recordId)
  expect(attribution.digest).toBe(canonicalValueDigest(receipt.payload))
  const boundSubject = { ...subject, binding: subject.binding, pullRequest: subject.pullRequest }
  return {
    intake,
    subject: boundSubject,
    history,
    receipt: { ...receipt, payload: receiptPayload },
    binding,
    attribution,
  }
}

it('authenticates the host-sealed attribution identity at the correction stage closure', async () => {
  const { intake, subject, history, receipt, binding, attribution } = await captureLeafAttribution()
  const request: UwActionRequest = {
    actionId: 'provenance-probe',
    purpose: 'correction',
    subject,
    code: intake.inputs.manifest.code,
    stageSources: [attribution],
    expandedContext: [],
  }
  const check = (
    candidate: UwActionRequest,
    bound: ActionSubject = subject,
    histories: readonly DecodedHistory[] = [history],
  ) =>
    refuseOutsideStage(
      candidate,
      { subject: bound, correctionRoot: null },
      new Set(),
      histories,
      fixtureHostReviewClassCatalogues(),
    )
  const refused = (result: Result<true>) => {
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toEqual(['self-output'])
  }
  expect(check(request)).toEqual({ ok: true, value: true })
  refused(check({ ...request, code: { ...request.code, head: 'f'.repeat(40) } }))
  refused(check({ ...request, code: { ...request.code, repository: 'foreign/repo' } }))
  refused(check({ ...request, stageSources: [{ ...attribution, digest: '0'.repeat(64) }] }))
  refused(
    check({
      ...request,
      stageSources: [
        {
          ...attribution,
          record: { ...attribution.record, scope: { ...subject.pullRequest, target: 'acme/app#999' } },
        },
      ],
    }),
  )
  refused(check({ ...request, subject: { ...subject, uw: { ...subject.uw, target: 'acme/app#999' } } }))
  refused(
    check({ ...request, subject: { ...subject, pullRequest: { ...subject.pullRequest, target: 'acme/app#999' } } }),
  )
  refused(check(request, { ...subject, binding: null }))
  refused(check(request, { ...subject, pullRequest: null }))
  refused(check(request, { ...subject, uw: { ...subject.uw, target: 'acme/app#999' } }))
  refused(check(request, { ...subject, pullRequest: { ...subject.pullRequest, target: 'acme/app#999' } }))
  refused(check({ ...request, purpose: 'review' }))
  refused(check(request, { ...subject, binding: { ...subject.binding, digest: '0'.repeat(64) } }))
  refused(
    check(request, {
      ...subject,
      binding: { ...subject.binding, record: { ...subject.binding.record, recordId: 'wrong-binding' } },
    }),
  )
  const withoutBinding = {
    ...history,
    operations: history.operations.filter((operation) => operation.record?.recordId !== binding.recordId),
  }
  refused(check(request, subject, [withoutBinding]))
  const bindingOperation = history.operations.find((operation) => operation.record?.recordId === binding.recordId)
  if (!bindingOperation) throw new Error('binding-operation-missing')
  refused(check(request, subject, [{ ...history, operations: [...history.operations, bindingOperation] }]))
  const editedBindingParts = new Set(bindingOperation.parts.map((part) => part.locator))
  const unaccountedBinding = decodeHistory({
    ...history.source,
    comments: history.source.comments.map((comment) =>
      editedBindingParts.has(comment.locator) ? { ...comment, updatedAt: '2099-01-01T00:00:00Z' } : comment,
    ),
  })
  expect(unaccountedBinding.operations.find((operation) => operation.recordId === binding.recordId)?.status).toBe(
    'invalid',
  )
  expect(accounted(unaccountedBinding, binding)).toBe(false)
  refused(check(request, subject, [unaccountedBinding]))
  const startRecordId = receipt.payload.start.recordId
  const start = history.operations.find((operation) => operation.record?.recordId === startRecordId)?.record
  if (start?.kind !== 'action-receipt') throw new Error('attribution-start-missing')
  refused(
    check({
      ...request,
      stageSources: [
        {
          ...attribution,
          record: { ...attribution.record, recordId: start.recordId },
          digest: canonicalValueDigest(start.payload),
        },
      ],
    }),
  )
  const receiptOperation = history.operations.find((operation) => operation.record?.recordId === receipt.recordId)
  if (!receiptOperation) throw new Error('receipt-operation-missing')
  const editedReceiptParts = new Set(receiptOperation.parts.map((part) => part.locator))
  const unaccountedReceipt = decodeHistory({
    ...history.source,
    comments: history.source.comments.map((comment) =>
      editedReceiptParts.has(comment.locator) ? { ...comment, updatedAt: '2099-01-01T00:00:00Z' } : comment,
    ),
  })
  expect(unaccountedReceipt.operations.find((operation) => operation.recordId === receipt.recordId)?.status).toBe(
    'invalid',
  )
  expect(accounted(unaccountedReceipt, receipt)).toBe(false)
  refused(check(request, subject, [unaccountedReceipt]))
  const replaceReceipt = (replacement: CanonicalRecord, requireAccounted = true) => {
    const parts = encodeParts(replacement, 'Attribution identity probe', 65_536)
    if (!parts.ok) throw new Error('attribution-probe-encoding-failed')
    const removed = new Set(receiptOperation.parts.map((part) => part.locator))
    const template = receiptOperation.parts[0]
    if (!template) throw new Error('attribution-parts-missing')
    const comments = history.source.comments.filter((comment) => !removed.has(comment.locator))
    const rebuilt = decodeHistory({
      ...history.source,
      comments: [
        ...comments,
        ...parts.value.map((body, index) => ({
          ...template,
          body,
          locator: `identity-probe-${index}`,
          nativeId: `identity-probe-${index}`,
        })),
      ],
    })
    const record = rebuilt.operations.find((operation) => operation.recordId === replacement.recordId)?.record
    if (requireAccounted && (!record || !accounted(rebuilt, record))) throw new Error('attribution-probe-not-accounted')
    return { history: rebuilt, ref: { ...attribution, digest: canonicalValueDigest(replacement.payload) } }
  }
  const unboundManifest = { ...receipt.payload.inputs.manifest, subject: { ...subject, binding: null } }
  const unboundReceipt = replaceReceipt(
    {
      ...receipt,
      payload: {
        ...receipt.payload,
        inputs: {
          ...receipt.payload.inputs,
          manifest: unboundManifest,
          fingerprint: actionInputDigest(unboundManifest),
        },
      },
    },
    false,
  )
  refused(check({ ...request, stageSources: [unboundReceipt.ref] }, subject, [unboundReceipt.history]))
  for (const replacementSubject of [
    { kind: 'standalone-pr' as const, pullRequest: subject.pullRequest },
    { ...subject, uw: { ...subject.uw, target: 'acme/app#999' } },
    { ...subject, pullRequest: { ...subject.pullRequest, target: 'acme/app#999' } },
  ]) {
    const manifest = { ...receipt.payload.inputs.manifest, subject: replacementSubject }
    const mismatchedSubject = replaceReceipt(
      {
        ...receipt,
        payload: {
          ...receipt.payload,
          inputs: {
            ...receipt.payload.inputs,
            manifest,
            fingerprint: actionInputDigest(manifest),
          },
        },
      },
      false,
    )
    refused(check({ ...request, stageSources: [mismatchedSubject.ref] }, subject, [mismatchedSubject.history]))
  }
  const wrongMandate = replaceReceipt({
    ...receipt,
    payload: { ...receipt.payload, mandate: { ...receipt.payload.mandate, recordId: 'other-mandate' } },
  })
  refused(check({ ...request, stageSources: [wrongMandate.ref] }, subject, [wrongMandate.history]))
  const wrongMandateScope = replaceReceipt({
    ...receipt,
    payload: {
      ...receipt.payload,
      mandate: { ...receipt.payload.mandate, scope: { ...subject.uw, target: 'acme/app#999' } },
    },
  })
  refused(check({ ...request, stageSources: [wrongMandateScope.ref] }, subject, [wrongMandateScope.history]))
  const wrongEvidence = replaceReceipt(
    {
      ...receipt,
      payload: { ...receipt.payload, exactInputs: { ...receipt.payload.exactInputs, evidenceDigest: '0'.repeat(64) } },
    },
    false,
  )
  refused(check({ ...request, stageSources: [wrongEvidence.ref] }, subject, [wrongEvidence.history]))
  for (const attributionValue of ['pre-existing', 'infra', 'unknown'] as const) {
    const nonChange = replaceReceipt({
      ...receipt,
      payload: { ...receipt.payload, structured: { attribution: attributionValue, evidence: null } },
    })
    refused(check({ ...request, stageSources: [nonChange.ref] }, subject, [nonChange.history]))
  }
  const missingOutput = replaceReceipt({ ...receipt, payload: { ...receipt.payload, structured: null } })
  refused(check({ ...request, stageSources: [missingOutput.ref] }, subject, [missingOutput.history]))
  refused(check(request, subject, [{ ...history, operations: [...history.operations, receiptOperation] }]))
  const decision = history.operations.find((operation) => operation.record?.kind === 'decision')?.record
  if (decision?.kind !== 'decision') throw new Error('review-decision-missing')
  const decisionRef: RecordInputRef = {
    source: 'record',
    record: { scope: subject.pullRequest, kind: 'decision', recordId: decision.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(decision.payload),
  }
  refused(check({ ...request, stageSources: [attribution, decisionRef] }))
  await assertForeignEvidence(check, refused)
})
