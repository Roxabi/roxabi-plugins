import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-context-assessment-runner.ts')
const CONTINUATION = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')

afterEach(cleanupFeatureRecoveryRoots)

it('recovers a native assessment negative with pinned context and consumes the positive result', () => {
  const { box, checkout } = featureFixture('mandate')
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('fixture issue unavailable')
    issue.body = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone').body
  })
  const invoke = (actionFile = '') => {
    const child = spawnSync(BUN, [RUNNER, checkout, actionFile], { cwd: checkout, env: box.env, encoding: 'utf8' })
    if (child.status !== 0) throw new Error(`assessment runner failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as { admitted: boolean; messages: string[]; activeAfterSettlement?: boolean }
  }
  const history = () =>
    decodeHistory({
      scope: SCOPE,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
        locator: `${SCOPE.target}:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
  const initial = invoke()
  expect(initial.admitted, JSON.stringify(initial)).toBe(true)
  const negative = history().operations.find(
    ({ record }) =>
      record?.kind === 'action-receipt' && record.payload.action === 'assess-spec' && record.payload.phase === 'result',
  )?.record
  if (
    negative?.kind !== 'action-receipt' ||
    negative.payload.action !== 'assess-spec' ||
    negative.payload.phase !== 'result'
  )
    throw new Error('native assessment negative unavailable')
  expect(negative.payload).toMatchObject({
    native: { completion: 'completed', strict: 'valid', raw: expect.anything() },
    structured: { outcome: 'missing-context' },
    admission: null,
  })
  const retained = JSON.stringify(negative)
  const { inputs } = negative.payload
  const manifest = inputs.manifest
  const actionFile = path.join(box.root, 'assessment-expansion.json')
  writeFileSync(
    actionFile,
    JSON.stringify({
      request: {
        actionId: 'expanded-assessment',
        purpose: manifest.purpose,
        subject: manifest.subject,
        code: manifest.code,
        ...(manifest.operands === undefined ? {} : { operands: manifest.operands }),
        stageSources: inputs.stageSources,
        expandedContext: [
          ...manifest.expandedContext,
          {
            source: 'record',
            record: { scope: SCOPE, kind: 'action-receipt', recordId: negative.recordId },
            selector: '/payload',
            digest: canonicalValueDigest(negative.payload),
          },
          {
            source: 'git-file',
            repository: SCOPE.repository,
            commit: manifest.code.head,
            path: 'README.md',
            digest: createHash('sha256').update('base\n').digest('hex'),
          },
        ],
      },
    }),
  )
  const dispatched = invoke(actionFile)
  expect(dispatched, JSON.stringify(dispatched)).toMatchObject({ admitted: true, activeAfterSettlement: false })
  expect(dispatched.messages.some((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toBe(true)
  const after = history()
  const successor = after.operations.find(
    ({ record }) =>
      record?.kind === 'action-receipt' &&
      record.payload.action === 'assess-spec' &&
      record.payload.phase === 'result' &&
      record.payload.actionId === 'expanded-assessment',
  )?.record
  expect(successor).toMatchObject({
    payload: {
      native: { completion: 'completed', strict: 'valid', raw: expect.anything() },
      structured: { classification: 'material' },
      admission: null,
    },
  })
  expect(JSON.stringify(after.operations.find(({ record }) => record?.recordId === negative.recordId)?.record)).toBe(
    retained,
  )
  const continuation = spawnSync(
    BUN,
    [CONTINUATION, 'continue', checkout, JSON.stringify({ reference: '#42', control: 'continue' })],
    { cwd: checkout, env: box.env, encoding: 'utf8' },
  )
  if (continuation.status !== 0) throw new Error(`continuation failed: ${continuation.stderr}\n${continuation.stdout}`)
  expect(JSON.parse(continuation.stdout)).toMatchObject({ kind: 'operator-decision', reason: 'material-spec' })
  const beforeReplay = readSim(box).issues['42']?.comments.length
  expect(invoke(actionFile).admitted).toBe(false)
  expect(readSim(box).issues['42']?.comments.length).toBe(beforeReplay)
})
