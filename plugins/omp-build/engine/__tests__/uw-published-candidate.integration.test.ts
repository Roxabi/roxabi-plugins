import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { defaultGit } from '../../roxabi/workflow-checkout.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { DecodedHistory, OperationRead } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { authenticateIntegrationPin } from '../review-integration-pin.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'

function encodeHistoricalPair(
  history: DecodedHistory,
  startOperation: OperationRead,
  resultOperation: OperationRead,
  changedStart: CanonicalRecord,
  changedResult: CanonicalRecord,
) {
  const startParts = encodeParts(changedStart, '# integration start', 65_536)
  const resultParts = encodeParts(changedResult, '# integration result', 65_536)
  if (
    !startParts.ok ||
    !resultParts.ok ||
    startParts.value.length > startOperation.parts.length ||
    resultParts.value.length > resultOperation.parts.length
  )
    throw new Error('Historical records exceed their actual native comment slots')
  const replacements = new Map<string, string | null>()
  for (const [index, part] of startOperation.parts.entries()) {
    const nativeId = part.nativeId
    if (nativeId === null) throw new Error('START native comment identity is missing')
    replacements.set(nativeId, startParts.value[index] ?? null)
  }
  for (const [index, part] of resultOperation.parts.entries()) {
    const nativeId = part.nativeId
    if (nativeId === null) throw new Error('RESULT native comment identity is missing')
    replacements.set(nativeId, resultParts.value[index] ?? null)
  }
  return decodeHistory({
    ...history.source,
    comments: history.source.comments.flatMap((comment) => {
      const nativeId = comment.nativeId
      if (nativeId === null || !replacements.has(nativeId)) return [comment]
      const body = replacements.get(nativeId)
      return body == null ? [] : [{ ...comment, body }]
    }),
  })
}

test('historical parent integration pin binds its published START candidate', async () => {
  const checkout = nativeImplementationGit()
  try {
    const [firstMerge, secondMerge, thirdMerge] = checkout.merges
    if (!firstMerge || !secondMerge || !thirdMerge) throw new Error('Expected three child merges')
    await checkout.publishBase(thirdMerge)
    const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
    await threeDeliveredChildren(
      {
        ...checkout,
        cwd: parentCheckout.cwd,
        trees: checkout.heads.map(checkout.tree),
        baseTrees: [checkout.p0, firstMerge, secondMerge].map(checkout.tree),
        mergeTrees: checkout.merges.map(checkout.tree),
        parentTree: checkout.tree(checkout.parentHead),
        diff: checkout.diff(thirdMerge, checkout.parentHead),
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'planned',
      async (world) => {
        const realWorld = { ...world, git: defaultGit() }
        await checkout.publishBase(checkout.parentHead)
        parentCheckout.checkout(checkout.parentHead)
        const published = parentCheckout.observe()
        const result = await produceParentIntegration(realWorld, parentCheckout, {
          initial: published,
          candidate: published,
          command: 'bun test parent.test.ts',
          output: 'PASS parent integration',
        })
        expect(result.code.head).toBe(checkout.parentHead)
        const history = result.beforeReview.histories.find(
          (item) => item.source.scope.target === world.parentScope.target,
        )
        if (!history) throw new Error('Actual parent integration history is missing')
        const startOperation = history.operations.find((item) => item.recordId === result.opened.start.recordId)
        const resultOperation = history.operations.find((item) => item.recordId === result.integrationRecordId)
        const start = startOperation?.record
        const receipt = resultOperation?.record
        if (
          !startOperation ||
          !resultOperation ||
          start?.kind !== 'action-receipt' ||
          start.payload.action !== 'integrate' ||
          start.payload.phase !== 'start' ||
          receipt?.kind !== 'action-receipt' ||
          receipt.payload.action !== 'integrate' ||
          receipt.payload.phase !== 'result'
        )
          throw new Error('Actual authenticated START/result pair is missing')
        const expected = {
          subject: receipt.payload.inputs.manifest.subject,
          spec: receipt.payload.inputs.manifest.spec,
          mandate: receipt.payload.mandate,
        }
        const authenticate = (selectedHistory: typeof history, pin = result.integrationPin) =>
          authenticateIntegrationPin(
            pin,
            expected,
            result.beforeReview.histories.map((item) => (item === history ? selectedHistory : item)),
          )
        expect(authenticate(history)).toMatchObject({ ok: true })

        // Retain the native author, record identities and sealed operands. Re-encode only
        // the candidate range so both historical cases have a canonical paired closure.
        const historical = (startHead: string) => {
          const manifest = {
            ...start.payload.inputs.manifest,
            code: {
              ...start.payload.inputs.manifest.code,
              base: thirdMerge,
              head: startHead,
              referenceCommit: startHead,
            },
          }
          const inputs = { ...start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
          const code = {
            ...result.output.code,
            base: thirdMerge,
            head: checkout.parentHead,
            referenceCommit: startHead,
          }
          const changedStart = parseRecord({ ...start, payload: { ...start.payload, inputs } })
          const changedResult = parseRecord({
            ...receipt,
            payload: {
              ...receipt.payload,
              inputs,
              structured: { ...result.output, code },
            },
          })
          if (!changedStart.ok || !changedResult.ok) throw new Error('Historical pair must be canonical')
          const changedHistory = encodeHistoricalPair(
            history,
            startOperation,
            resultOperation,
            changedStart.value,
            changedResult.value,
          )
          return {
            history: changedHistory,
            pin: { ...result.integrationPin, digest: canonicalValueDigest(code) },
          }
        }
        const genericRange = historical(checkout.parentHead)
        expect(authenticate(genericRange.history, genericRange.pin)).toMatchObject({ ok: true })
        const substituted = historical(thirdMerge)
        expect(authenticate(substituted.history, substituted.pin)).toMatchObject({
          ok: false,
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'integration-code-mismatch' })]),
        })
      },
    )
  } finally {
    checkout.cleanup()
  }
}, 60_000)
