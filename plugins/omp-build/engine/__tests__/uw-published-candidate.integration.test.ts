import { execFileSync } from 'node:child_process'
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
import { recordsOf } from '../workflow-control.ts'
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

type CheckoutSnapshot = {
  head: string
  tracking: string
  remote: string | undefined
  branch: string
  status: string
}

function publishedTransition<T extends { cwd: string; checkout(commit: string): void; tree(commit: string): string }>(
  checkout: { cwd: string; originUrl: string; parentHead: string },
  parentCheckout: T,
  thirdMerge: string,
) {
  const state: {
    checkouts: number
    beforeStart?: CheckoutSnapshot
    beforePublication?: CheckoutSnapshot
    afterPublication?: CheckoutSnapshot
  } = { checkouts: 0 }
  const inspect = () => {
    const git = (args: string[]) =>
      execFileSync('git', ['-C', parentCheckout.cwd, ...args], { encoding: 'utf8' }).trim()
    return {
      head: git(['rev-parse', 'HEAD']),
      tracking: git(['rev-parse', 'refs/remotes/origin/main']),
      remote: git(['ls-remote', checkout.originUrl, 'refs/heads/main']).split(/\s+/)[0],
      branch: git(['branch', '--show-current']),
      status: git(['status', '--porcelain']),
    }
  }
  const transition = {
    ...parentCheckout,
    checkout(commit: string) {
      state.checkouts++
      if (state.checkouts === 2) {
        const before = inspect()
        state.beforePublication = before
        if (
          before.head !== thirdMerge ||
          before.remote !== thirdMerge ||
          before.tracking !== thirdMerge ||
          commit !== checkout.parentHead
        )
          throw new Error(`Invalid pre-publication world: ${JSON.stringify(before)}`)
        execFileSync('git', ['-C', checkout.cwd, 'push', '--quiet', checkout.originUrl, `${commit}:refs/heads/main`])
        // Restore the observed M after Git updates its shared tracking ref during push.
        execFileSync('git', ['-C', parentCheckout.cwd, 'update-ref', 'refs/remotes/origin/main', before.tracking])
      }
      parentCheckout.checkout(commit)
      if (state.checkouts === 1) state.beforeStart = inspect()
      if (state.checkouts === 2) state.afterPublication = inspect()
    },
  }
  return { transition, state }
}

test.each(['published-before-start', 'published-after-start', 'unpublished-until-after-start'] as const)(
  'parent integration binds its published START candidate: %s',
  async (scenario) => {
    const checkout = nativeImplementationGit()
    try {
      const [firstMerge, secondMerge, thirdMerge] = checkout.merges
      if (!firstMerge || !secondMerge || !thirdMerge) throw new Error('Expected three child merges')
      await checkout.publishBase(thirdMerge)
      const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
      const initial = parentCheckout.observe()
      parentCheckout.checkout(checkout.parentHead)
      const unpublished = parentCheckout.observe()
      parentCheckout.checkout(thirdMerge)
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
          async function assertUnpublishedStart() {
            let checkouts = 0
            let beforeStart:
              | { head: string; tracking: string; remote: string | undefined; branch: string; status: string }
              | undefined
            const transition = {
              ...parentCheckout,
              checkout(commit: string) {
                checkouts++
                if (checkouts === 2) {
                  execFileSync('git', [
                    '-C',
                    checkout.cwd,
                    'push',
                    '--quiet',
                    checkout.originUrl,
                    `${commit}:refs/heads/main`,
                  ])
                  execFileSync('git', ['-C', parentCheckout.cwd, 'update-ref', 'refs/remotes/origin/main', thirdMerge])
                }
                parentCheckout.checkout(commit)
                if (checkouts === 1) {
                  const git = (args: string[]) =>
                    execFileSync('git', ['-C', parentCheckout.cwd, ...args], { encoding: 'utf8' }).trim()
                  beforeStart = {
                    head: git(['rev-parse', 'HEAD']),
                    tracking: git(['rev-parse', 'refs/remotes/origin/main']),
                    remote: git(['ls-remote', checkout.originUrl, 'refs/heads/main']).split(/\s+/)[0],
                    branch: git(['branch', '--show-current']),
                    status: git(['status', '--porcelain']),
                  }
                }
              },
            }
            let blocked: unknown
            try {
              await produceParentIntegration(realWorld, transition, {
                initial: unpublished,
                candidate: { ...unpublished, remoteTip: checkout.parentHead },
                command: 'bun test parent.test.ts',
                output: 'PASS parent integration',
                observeStart: (opened) => {
                  blocked = opened
                },
              })
            } catch {
              // The producer preserves its usual failure behavior after observing START.
            }
            const read = await world.operations.readUw(world.parentScope)
            const history = read.histories.find((item) => item.source.scope.target === world.parentScope.target)
            if (!history) throw new Error('Parent integration history is missing')
            const starts = recordsOf(history).filter(
              (record) =>
                record.kind === 'action-receipt' &&
                record.payload.action === 'integrate' &&
                record.payload.phase === 'start',
            )
            expect({ starts: starts.length, checkouts, beforeStart, blocked }).toMatchObject({
              beforeStart: {
                head: checkout.parentHead,
                tracking: thirdMerge,
                remote: thirdMerge,
                branch: '',
                status: '',
              },
              starts: 0,
              checkouts: 1,
              blocked: { kind: 'blocked', reason: 'integration-base-not-published' },
            })
            return
          }
          async function assertPublishedStart() {
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
            return
          }

          async function assertPublishedAfterStart() {
            const { transition, state } = publishedTransition(checkout, parentCheckout, thirdMerge)
            let producerFailure: unknown
            try {
              await produceParentIntegration(realWorld, transition, {
                initial,
                candidate: { ...unpublished, remoteTip: checkout.parentHead },
                command: 'bun test parent.test.ts',
                output: 'PASS parent integration',
              })
            } catch (error) {
              producerFailure = error
            }
            const read = await world.operations.readUw(world.parentScope)
            const history = read.histories.find((item) => item.source.scope.target === world.parentScope.target)
            if (!history) throw new Error('Parent integration history is missing')
            const records = recordsOf(history)
            const start = records.find(
              (record) =>
                record.kind === 'action-receipt' &&
                record.payload.action === 'integrate' &&
                record.payload.phase === 'start',
            )
            const result = records.find(
              (record) =>
                record.kind === 'action-receipt' &&
                record.payload.action === 'integrate' &&
                record.payload.phase === 'result',
            )
            if (
              start?.kind !== 'action-receipt' ||
              start.payload.action !== 'integrate' ||
              start.payload.phase !== 'start' ||
              result?.kind !== 'action-receipt' ||
              result.payload.action !== 'integrate' ||
              result.payload.phase !== 'result'
            )
              throw new Error(
                `Actual integration START/result pair missing: ${JSON.stringify({ ...state, producerFailure: String(producerFailure), records })}`,
              )
            expect({
              ...state,
              startHead: start.payload.inputs.manifest.code.head,
              pairedStart: result.payload.start.recordId === start.recordId,
              structured: result.payload.structured,
              admission: result.payload.admission,
              producerFailed: producerFailure instanceof Error,
            }).toMatchObject({
              checkouts: 2,
              beforeStart: { head: thirdMerge, remote: thirdMerge, tracking: thirdMerge, branch: '', status: '' },
              beforePublication: { head: thirdMerge, remote: thirdMerge, tracking: thirdMerge, branch: '', status: '' },
              afterPublication: {
                head: checkout.parentHead,
                remote: checkout.parentHead,
                tracking: thirdMerge,
                branch: '',
                status: '',
              },
              startHead: thirdMerge,
              pairedStart: true,
              structured: { outcome: 'integrated', code: { head: checkout.parentHead } },
              admission: { admitted: false, reason: 'integration-code-unbound' },
              producerFailed: true,
            })
          }
          if (scenario === 'unpublished-until-after-start') await assertUnpublishedStart()
          else if (scenario === 'published-before-start') await assertPublishedStart()
          else await assertPublishedAfterStart()
        },
      )
    } finally {
      checkout.cleanup()
    }
  },
  60_000,
)
