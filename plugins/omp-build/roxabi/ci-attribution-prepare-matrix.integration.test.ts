import { rmSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { encodeParts } from '../adapters/github/history-encoder.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import { buildRecord, parseRecord } from '../engine/record-construction.ts'
import { failedCheckEvidenceDigest } from '../engine/record-digests.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { accounted } from '../engine/review-context-authentication.ts'
import { type CiOperands, type MatrixSetup, setupMatrix } from '../testing/ci-attribution-prepare-matrix-fixture.ts'
import { featureMandate, pullHistory } from '../testing/feature-ci-review-fixture.ts'
import { writeSim } from '../testing/sandbox/sandbox-repository.ts'

const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function checkCanonicalCases(input: MatrixSetup): CiOperands {
  const { box, intake, subject, ref, history, op, receipt, baseline, refused } = input
  refused('digest', intake.manifest.code, [{ ...ref, digest: '0'.repeat(64) }])
  refused('request head', { ...intake.manifest.code, head: 'f'.repeat(40) }, [ref], 'action-code-moved')
  const startId = receipt.payload.start.recordId
  const start = history.operations.find((item) => item.recordId === startId)?.record
  if (start?.kind !== 'action-receipt') throw new Error('attribution-start-missing')
  refused('start phase', intake.manifest.code, [
    { ...ref, record: { ...ref.record, recordId: start.recordId }, digest: canonicalValueDigest(start.payload) },
  ])
  const decision = history.operations.find((item) => item.record?.kind === 'decision')?.record
  if (decision?.kind !== 'decision') throw new Error('decision-missing')
  expect(accounted(history, decision)).toBe(true)
  refused('post-decision attribution', intake.manifest.code, [
    ref,
    {
      source: 'record',
      record: { scope: subject.pullRequest, kind: 'decision', recordId: decision.recordId },
      selector: '/payload',
      digest: canonicalValueDigest(decision.payload),
    },
  ])
  const replace = (replacement: CanonicalRecord) => {
    const canonical = parseRecord(replacement)
    if (!canonical.ok) throw new Error(`matrix-record-invalid: ${JSON.stringify(canonical.diagnostics)}`)
    const encoded = encodeParts(canonical.value, 'Attribution prepare matrix', 65_536)
    if (!encoded.ok) throw new Error('matrix-encode-failed')
    const indices = new Set(op.parts.map((part) => Number(part.nativeId) - 1))
    const original = baseline.prs['7']?.comments
    if (!original) throw new Error('matrix-comments-missing')
    const template = original[[...indices][0] ?? -1]
    if (!template) throw new Error('matrix-comment-template-missing')
    writeSim(box, (state) => {
      const pull = state.prs['7']
      if (!pull) throw new Error('matrix-pull-missing')
      pull.comments = [
        ...original.filter((_comment, index) => !indices.has(index)),
        ...encoded.value.map((body, index) => ({ ...template, id: 900000 + index, body })),
      ]
    })
    const rebuilt = pullHistory(box)
    const record = rebuilt.operations.find((item) => item.recordId === replacement.recordId)?.record
    expect(record, 'replacement must decode as a native record').toBeDefined()
    if (!record) throw new Error('matrix-replacement-missing')
    expect(accounted(rebuilt, record), 'replacement must remain accounted').toBe(true)
    return { ...ref, digest: canonicalValueDigest(replacement.payload) }
  }
  const issueHistory = featureMandate(box).history
  const otherAction = issueHistory.operations.find(
    (item) =>
      item.record?.kind === 'action-receipt' &&
      item.record.payload.phase === 'result' &&
      item.record.payload.action !== 'attribute-ci',
  )?.record
  if (otherAction?.kind !== 'action-receipt') throw new Error('other-action-result-missing')
  expect(accounted(issueHistory, otherAction), 'source other-action receipt must be accounted').toBe(true)
  // Rehome the existing result to the PR fixture and rebuild its same-scope
  // input list; the action and its sealed inputs remain unchanged.
  const rehomed = buildRecord({
    ...otherAction,
    repository: receipt.repository,
    target: receipt.target,
    recordId: receipt.recordId,
    operationId: receipt.operationId,
  })
  if (!rehomed.ok) throw new Error(`other-action-rehome-invalid: ${JSON.stringify(rehomed.diagnostics)}`)
  const otherRef = replace(rehomed.value)
  refused('different action result', intake.manifest.code, [otherRef])
  for (const value of ['pre-existing', 'infra', 'unknown'] as const) {
    const changed = replace({
      ...receipt,
      payload: { ...receipt.payload, structured: { attribution: value, evidence: null } },
    })
    refused(`attribution ${value}`, intake.manifest.code, [changed])
  }
  const absent = replace({ ...receipt, payload: { ...receipt.payload, structured: null } })
  refused('null attribution', intake.manifest.code, [absent])
  const mandate = replace({
    ...receipt,
    payload: { ...receipt.payload, mandate: { ...receipt.payload.mandate, recordId: 'other-mandate' } },
  })
  refused('receipt mandate', intake.manifest.code, [mandate])
  const oldManifest = receipt.payload.inputs.manifest
  if (oldManifest.spec.kind !== 'accepted') throw new Error('accepted-spec-missing')
  const foreignUw = { ...subject.uw, target: 'acme/app#999' }
  const effective = oldManifest.spec.effective
  const foreignOwn = {
    ...effective.own,
    uw: foreignUw,
    sourceAccepted: { ...effective.own.sourceAccepted, scope: foreignUw },
  }
  const foreignSpec = {
    ...oldManifest.spec,
    effective: {
      ...effective,
      own: foreignOwn,
      versionVector: [foreignOwn, ...effective.versionVector.slice(1)] as typeof effective.versionVector,
    },
  }
  const foreignSources = oldManifest.acceptedSources.map((source) =>
    source.record.scope.repository === subject.uw.repository && source.record.scope.target === subject.uw.target
      ? { ...source, record: { ...source.record, scope: foreignUw } }
      : source,
  )
  for (const [name, manifest] of [
    [
      'receipt UW',
      { ...oldManifest, subject: { ...subject, uw: foreignUw }, spec: foreignSpec, acceptedSources: foreignSources },
    ],
    [
      'receipt PR',
      { ...oldManifest, subject: { ...subject, pullRequest: { ...subject.pullRequest, target: 'acme/app#999' } } },
    ],
  ] as const) {
    const changed = replace({
      ...receipt,
      payload: {
        ...receipt.payload,
        inputs: {
          ...receipt.payload.inputs,
          manifest,
          fingerprint: actionInputDigest(manifest),
        },
      },
    })
    refused(name, intake.manifest.code, [changed])
  }
  const operands = receipt.payload.inputs.manifest.operands
  if (operands?.action !== 'attribute-ci') throw new Error('attribution-operands-missing')
  for (const [name, patch] of [
    ['receipt head', { candidateGitSHA: 'e'.repeat(40) }],
    ['receipt scope', { scope: { ...subject.pullRequest, target: 'acme/app#999' } }],
  ] as const) {
    const basis = { ...receipt.payload.exactInputs, ...patch }
    const digest = failedCheckEvidenceDigest(basis)
    if (!digest) throw new Error('matrix-evidence-digest-missing')
    const exactInputs = { ...basis, evidenceDigest: digest }
    const manifest = { ...receipt.payload.inputs.manifest, operands: { ...operands, exactInputs } }
    const changed = replace({
      ...receipt,
      payload: {
        ...receipt.payload,
        exactInputs,
        inputs: {
          ...receipt.payload.inputs,
          manifest,
          fingerprint: actionInputDigest(manifest),
        },
      },
    })
    refused(name, intake.manifest.code, [changed])
  }
  return operands
}

function checkRawHistoryCases(input: MatrixSetup, operands: CiOperands) {
  const { box, intake, ref, history, op, receipt, binding, baseline, refused } = input
  const duplicate = encodeParts(
    { ...receipt, operationId: `${receipt.operationId}-duplicate` },
    'Duplicate receipt',
    65_536,
  )
  if (!duplicate.ok) throw new Error('duplicate-encode-failed')
  const original = baseline.prs['7']?.comments
  if (!original) throw new Error('matrix-comments-missing')
  const template = original[Number(op.parts[0]?.nativeId) - 1]
  if (!template) throw new Error('matrix-comment-template-missing')
  writeSim(box, (state) => {
    const pull = state.prs['7']
    if (!pull) throw new Error('matrix-pull-missing')
    pull.comments = [...original, ...duplicate.value.map((body, index) => ({ ...template, id: 910000 + index, body }))]
  })
  const duplicates = pullHistory(box)
  const matches = duplicates.operations.filter((item) => item.record?.recordId === receipt.recordId)
  expect(matches).toHaveLength(2)
  expect(matches.every((item) => item.record !== null && !accounted(duplicates, item.record))).toBe(true)
  // Duplicate and edited raw histories are refused before the D2 closure.
  refused('duplicate receipt id', intake.manifest.code, [ref], 'ambiguous')
  const bindingOp = history.operations.find((item) => item.recordId === binding.recordId)
  if (!bindingOp) throw new Error('binding-operation-missing')
  for (const [name, parts, expected] of [
    ['edited receipt', op.parts, 'cause-history-unconfirmed'],
    ['edited binding', bindingOp.parts, 'incomplete'],
  ] as const) {
    const indices = new Set(parts.map((part) => Number(part.nativeId) - 1))
    writeSim(box, (state) => {
      const pull = state.prs['7']
      if (!pull) throw new Error('matrix-pull-missing')
      pull.comments = original.map((comment, index) =>
        indices.has(index) ? { ...comment, updatedAt: '2099-01-01T00:00:00Z' } : comment,
      )
    })
    const changed = pullHistory(box)
    const target = name === 'edited receipt' ? receipt : binding
    expect(changed.operations.find((item) => item.recordId === target.recordId)?.status).toBe('invalid')
    expect(accounted(changed, target)).toBe(false)
    refused(name, intake.manifest.code, [ref], expected)
  }
  const duplicateBinding = encodeParts(
    { ...binding, operationId: `${binding.operationId}-duplicate` },
    'Duplicate binding',
    65_536,
  )
  if (!duplicateBinding.ok) throw new Error('duplicate-binding-encode-failed')
  const bindingTemplate = original[Number(bindingOp.parts[0]?.nativeId) - 1]
  if (!bindingTemplate) throw new Error('binding-comment-template-missing')
  writeSim(box, (state) => {
    const pull = state.prs['7']
    if (!pull) throw new Error('matrix-pull-missing')
    pull.comments = [
      ...original,
      ...duplicateBinding.value.map((body, index) => ({
        ...bindingTemplate,
        id: 920000 + index,
        body,
      })),
    ]
  })
  const bindingHistory = pullHistory(box)
  const bindingMatches = bindingHistory.operations.filter((item) => item.record?.recordId === binding.recordId)
  expect(bindingMatches).toHaveLength(2)
  expect(accounted(bindingHistory, binding)).toBe(false)
  refused('duplicate binding', intake.manifest.code, [ref], ['ambiguous', 'incomplete'])
  // The native CI schema itself rejects an inconsistent evidence digest. Preserve
  // the raw frame and the sealed operand/fingerprint agreement to isolate it.
  const invalidExact = { ...receipt.payload.exactInputs, evidenceDigest: '0'.repeat(64) }
  const invalidManifest = {
    ...receipt.payload.inputs.manifest,
    operands: { ...operands, exactInputs: invalidExact },
  }
  const invalidReceipt = {
    ...receipt,
    payload: {
      ...receipt.payload,
      exactInputs: invalidExact,
      inputs: {
        ...receipt.payload.inputs,
        manifest: invalidManifest,
        fingerprint: actionInputDigest(invalidManifest),
      },
    },
  }
  const invalidEncoded = encodeParts(invalidReceipt, 'Invalid evidence digest', 65_536)
  if (!invalidEncoded.ok) throw new Error('invalid-evidence-encode-failed')
  const receiptIndices = new Set(op.parts.map((part) => Number(part.nativeId) - 1))
  writeSim(box, (state) => {
    const pull = state.prs['7']
    if (!pull) throw new Error('matrix-pull-missing')
    pull.comments = [
      ...original.filter((_comment, index) => !receiptIndices.has(index)),
      ...invalidEncoded.value.map((body, index) => ({ ...template, id: 930000 + index, body })),
    ]
  })
  const invalidHistory = pullHistory(box)
  expect(invalidHistory.operations.find((item) => item.recordId === receipt.recordId)?.status).toBe('invalid')
  refused(
    'invalid evidence digest',
    intake.manifest.code,
    [{ ...ref, digest: canonicalValueDigest(invalidReceipt.payload) }],
    'cause-history-unconfirmed',
  )
}

it('refuses invalid CI stage evidence through installed prepare without publishing records', async () => {
  const input = await setupMatrix(roots)
  const operands = checkCanonicalCases(input)
  checkRawHistoryCases(input, operands)
}, 240_000)
