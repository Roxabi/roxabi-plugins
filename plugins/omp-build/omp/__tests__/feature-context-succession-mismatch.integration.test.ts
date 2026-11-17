import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import { inspectContextNegativeReceipt } from '../../engine/workflow-context-negative-inspection.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
afterEach(cleanupFeatureRecoveryRoots)

it('refuses a projected context negative whose conserved native output actually claimed implementation', () => {
  const { box, checkout: originalCheckout } = featureFixture('mandate')
  const worktreeRoot = path.join(box.root, 'context-worktrees')
  const checkout = path.join(worktreeRoot, 'app', 'feat-42-save')
  mkdirSync(path.dirname(checkout), { recursive: true })
  git(box, box.principal, ['worktree', 'move', originalCheckout, checkout])
  const run = (operation: string, negativeRecordId = '') => {
    const child = spawnSync(
      BUN,
      [
        RUNNER,
        operation,
        checkout,
        JSON.stringify({
          reference: '#42',
          control: 'continue',
          negativeRecordId,
        }),
      ],
      { cwd: checkout, env: { ...box.env, OMP_WORKTREE_DIR: worktreeRoot }, encoding: 'utf8' },
    )
    if (child.status !== 0) throw new Error(`feature runner failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as { kind?: string; reason?: string; admitted?: boolean }
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
  const planner = spawnSync(
    BUN,
    [path.resolve(import.meta.dirname, '../../testing/feature-planner-context-runner.ts'), checkout, 'positive-both'],
    {
      cwd: checkout,
      env: { ...box.env, OMP_WORKTREE_DIR: worktreeRoot },
      encoding: 'utf8',
    },
  )
  if (planner.status !== 0) throw new Error(`Native planning failed: ${planner.stderr}\n${planner.stdout}`)
  expect(JSON.parse(planner.stdout).selected).toMatchObject({ kind: 'action', node: 'plan' })
  expect(run('omp-context-initial-negative').admitted).toBe(true)
  const operation = history().operations.find(
    ({ record }) =>
      record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )
  const negative = operation?.record
  if (
    !operation ||
    negative?.kind !== 'action-receipt' ||
    negative.payload.action !== 'implement' ||
    negative.payload.phase !== 'result'
  )
    throw new Error('Native implementation negative unavailable')
  const mandateId = negative.payload.mandate.recordId
  const predecessor = history().operations.find(
    (entry) => entry.record?.kind === 'mandate' && entry.record.recordId === mandateId,
  )?.record
  if (predecessor?.kind !== 'mandate') throw new Error('Native predecessor unavailable')
  const pin = (payload: typeof negative.payload) => ({
    source: 'record' as const,
    record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: negative.recordId },
    selector: '/payload' as const,
    digest: canonicalValueDigest(payload),
  })
  expect(
    inspectContextNegativeReceipt({ mandate: predecessor, negative: pin(negative.payload), histories: [history()] }).ok,
  ).toBe(true)
  expect(
    inspectContextNegativeReceipt({
      mandate: predecessor,
      negative: { ...pin(negative.payload), digest: '0'.repeat(64) },
      histories: [history()],
    }).ok,
  ).toBe(false)
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Fixture issue unavailable')
    issue.body = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone').body
  })

  // Model #899 as an internally framed external history: the raw producer claimed success,
  // while the persisted projection still claims a blocked context negative. No success is admitted.
  const forged = parseRecord({
    ...negative,
    payload: {
      ...negative.payload,
      native: {
        ...negative.payload.native,
        raw: {
          id: 'R-workflow-implement',
          agent: 'R-workflow-implement',
          exitCode: 0,
          structuredOutput: {
            status: 'valid',
            data: {
              outcome: 'implemented',
              commitSHAs: ['b'.repeat(40)],
              commands: [],
              criteria: [],
              reason: 'The producer claimed implementation.',
            },
          },
        },
      },
    },
  })
  if (!forged.ok) throw new Error('Fictional mismatched receipt failed to parse')
  const frames = encodeParts(forged.value, '# implementation result', 65536)
  if (!frames.ok) throw new Error('Fictional mismatched receipt failed to encode')
  const oldBodies = new Set(operation.parts.map((part) => part.body))
  const originalComments = readSim(box).issues['42']?.comments.filter((comment) => oldBodies.has(comment.body))
  if (!originalComments || originalComments.length !== operation.parts.length)
    throw new Error('Native negative comments unavailable')
  writeSim(box, (state) => {
    const comments = state.issues['42']?.comments
    if (!comments) throw new Error('Fixture comments unavailable')
    const index = comments.findIndex((comment) => oldBodies.has(comment.body))
    if (index < 0 || comments.filter((comment) => oldBodies.has(comment.body)).length !== operation.parts.length)
      throw new Error('Native negative frames unavailable')
    const original = comments[index]
    if (!original) throw new Error('Native negative frame missing')
    comments.splice(index, operation.parts.length, ...frames.value.map((body) => ({ ...original, body })))
  })
  if (forged.value.kind !== 'action-receipt') throw new Error('Forged receipt missing')
  expect(
    inspectContextNegativeReceipt({
      mandate: predecessor,
      negative: pin(forged.value.payload as typeof negative.payload),
      histories: [history()],
    }).ok,
  ).toBe(false)
  const beforeAssessment = readSim(box).issues['42']?.comments.length
  const refused = spawnSync(
    BUN,
    [
      RUNNER,
      'accept-context-material',
      checkout,
      JSON.stringify({
        reference: '#42',
        control: 'continue',
      }),
    ],
    { cwd: checkout, env: { ...box.env, OMP_WORKTREE_DIR: worktreeRoot }, encoding: 'utf8' },
  )
  expect(refused.status).not.toBe(0)
  expect(refused.stderr).toContain('Material assessment did not start')
  expect(readSim(box).issues['42']?.comments.length).toBe(beforeAssessment)
  const forgedBodies = new Set(frames.value)
  writeSim(box, (state) => {
    const comments = state.issues['42']?.comments
    if (!comments) throw new Error('Fixture comments unavailable')
    const index = comments.findIndex((comment) => forgedBodies.has(comment.body))
    if (index < 0 || comments.filter((comment) => forgedBodies.has(comment.body)).length !== frames.value.length)
      throw new Error('Forged negative frames unavailable')
    comments.splice(index, frames.value.length, ...originalComments)
  })
  writeSim(box, (state) => {
    const comments = state.issues['42']?.comments
    if (!comments) throw new Error('Fixture comments unavailable')
    const index = comments.findIndex((comment) => oldBodies.has(comment.body))
    if (index < 0) throw new Error('Native negative frames unavailable')
    comments.splice(index, operation.parts.length)
  })
  const beforeUnpaired = readSim(box).issues['42']?.comments.length
  const unpaired = spawnSync(
    BUN,
    [
      RUNNER,
      'accept-context-material',
      checkout,
      JSON.stringify({
        reference: '#42',
        control: 'continue',
      }),
    ],
    { cwd: checkout, env: { ...box.env, OMP_WORKTREE_DIR: worktreeRoot }, encoding: 'utf8' },
  )
  expect(unpaired.status).not.toBe(0)
  expect(unpaired.stderr).toContain('Material assessment did not start')
  expect(readSim(box).issues['42']?.comments.length).toBe(beforeUnpaired)
  writeSim(box, (state) => {
    const comments = state.issues['42']?.comments
    if (!comments) throw new Error('Fixture comments unavailable')
    comments.push(...originalComments)
  })
  const competing = parseRecord({
    ...negative,
    recordId: 'competing-context-negative',
    operationId: 'competing-context-op',
  })
  if (!competing.ok) throw new Error('Competing negative failed to parse')
  const competingFrames = encodeParts(competing.value, '# competing implementation result', 65536)
  if (!competingFrames.ok) throw new Error('Competing negative failed to encode')
  writeSim(box, (state) => {
    const comments = state.issues['42']?.comments
    const original = comments?.find((comment) => oldBodies.has(comment.body))
    if (!comments || !original) throw new Error('Native negative comments unavailable')
    comments.push(...competingFrames.value.map((body) => ({ ...original, body })))
  })
  expect(
    inspectContextNegativeReceipt({ mandate: predecessor, negative: pin(negative.payload), histories: [history()] }).ok,
  ).toBe(false)
  const beforeCompeting = readSim(box).issues['42']?.comments.length
  const competingAssessment = spawnSync(
    BUN,
    [
      RUNNER,
      'accept-context-material',
      checkout,
      JSON.stringify({
        reference: '#42',
        control: 'continue',
      }),
    ],
    { cwd: checkout, env: { ...box.env, OMP_WORKTREE_DIR: worktreeRoot }, encoding: 'utf8' },
  )
  expect(competingAssessment.status).not.toBe(0)
  expect(competingAssessment.stderr).toContain('Material assessment did not start')
  expect(readSim(box).issues['42']?.comments.length).toBe(beforeCompeting)
  writeSim(box, (state) => {
    const comments = state.issues['42']?.comments
    if (!comments) throw new Error('Fixture comments unavailable')
    const bodies = new Set(competingFrames.value)
    const index = comments.findIndex((comment) => bodies.has(comment.body))
    if (index < 0) throw new Error('Competing negative frames unavailable')
    comments.splice(index, competingFrames.value.length)
  })
  run('accept-context-material')
  expect(run('confirmed-abandon')).toMatchObject({ kind: 'abandoned', confirmed: true })
  writeSim(box, (state) => {
    const comments = state.issues['42']?.comments
    if (!comments) throw new Error('Fixture comments unavailable')
    const index = comments.findIndex((comment) => oldBodies.has(comment.body))
    if (index < 0 || comments.filter((comment) => oldBodies.has(comment.body)).length !== operation.parts.length)
      throw new Error('Native negative frames unavailable')
    const original = comments[index]
    if (!original) throw new Error('Native negative frame missing')
    comments.splice(index, operation.parts.length, ...frames.value.map((body) => ({ ...original, body })))
  })
  const before = readSim(box).issues['42']?.comments.length
  expect(run('confirmed-context-successor', negative.recordId)).toMatchObject({
    kind: 'blocked',
    reason: 'context-handoff-reconciliation-unconfirmed',
  })
  expect(readSim(box).issues['42']?.comments.length).toBe(before)
  expect(
    history().operations.some(
      ({ record }) => record?.kind === 'operator-control' && record.payload.control === 'select-successor',
    ),
  ).toBe(false)
})
