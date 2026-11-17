import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')

afterEach(cleanupFeatureRecoveryRoots)

it.each(['negative', 'positive'] as const)(
  'settles an explicitly expanded %s successor and refuses a cold replay',
  (outcome) => {
    const { box, checkout } = featureFixture('plan')
    const run = (operation: string, actionFile = '') => {
      const child = spawnSync(
        BUN,
        [RUNNER, operation, checkout, JSON.stringify({ reference: '#42', control: 'continue', actionFile })],
        {
          cwd: checkout,
          env: box.env,
          encoding: 'utf8',
        },
      )
      if (child.status !== 0) throw new Error(`feature runner failed: ${child.stderr}\n${child.stdout}`)
      return JSON.parse(child.stdout) as {
        kind: string
        node?: string
        messages?: string[]
        preparation?: string[]
        operationId?: string | null
        admitted?: boolean
        activeAfterSettlement?: boolean
      }
    }
    const first = run('omp-context-initial-negative')
    expect(first).toMatchObject({ admitted: true, activeAfterSettlement: false })
    expect(first.messages?.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
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
    const start = history().operations.find(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.action === 'implement' &&
        operation.record.payload.phase === 'start',
    )?.record
    if (start?.kind !== 'action-receipt' || start.payload.action !== 'implement' || start.payload.phase !== 'start')
      throw new Error('implementation start missing')
    const inputs = start.payload.inputs
    const negative = history().operations.find(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.action === 'implement' &&
        operation.record.payload.phase === 'result' &&
        operation.record.payload.start.recordId === start.recordId,
    )?.record
    if (
      negative?.kind !== 'action-receipt' ||
      negative.payload.action !== 'implement' ||
      negative.payload.phase !== 'result'
    )
      throw new Error('native context negative missing')
    expect(negative.payload).toMatchObject({
      admission: null,
      native: {
        completion: 'completed',
        strict: 'valid',
        raw: {
          exitCode: 0,
          structuredOutput: { status: 'valid', data: { outcome: 'blocked', commitSHAs: [], commands: [] } },
        },
      },
    })
    const manifest = inputs.manifest
    const actionFile = path.join(box.root, 'expanded-action.json')
    writeFileSync(
      actionFile,
      JSON.stringify({
        request: {
          actionId: 'expanded-implementation',
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
    const foreignActionFile = path.join(box.root, 'foreign-action.json')
    writeFileSync(
      foreignActionFile,
      JSON.stringify({
        request: {
          actionId: 'foreign-implementation',
          purpose: manifest.purpose,
          subject: manifest.subject,
          code: manifest.code,
          ...(manifest.operands === undefined ? {} : { operands: manifest.operands }),
          stageSources: inputs.stageSources,
          expandedContext: [
            ...manifest.expandedContext,
            {
              source: 'record',
              record: { scope: SCOPE, kind: 'action-receipt', recordId: 'foreign-negative' },
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
    const beforeForeign = readSim(box).issues['42']?.comments.length
    const foreign = run('omp-context-negative', foreignActionFile)
    expect(foreign).toMatchObject({ admitted: false, operationId: null })
    expect(foreign.messages?.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(0)
    expect(readSim(box).issues['42']?.comments.length).toBe(beforeForeign)
    const dispatched = run(`omp-context-${outcome}`, actionFile)
    expect(dispatched).toMatchObject({ admitted: true })
    expect(dispatched.preparation?.some((message) => message.includes('uw-prepared:'))).toBe(true)
    expect(
      dispatched.messages?.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH')).length,
    ).toBeGreaterThanOrEqual(1)
    const retryStart = history().operations.find(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.action === 'implement' &&
        operation.record.payload.phase === 'start' &&
        operation.record.payload.actionId === 'expanded-implementation',
    )?.record
    if (
      retryStart?.kind !== 'action-receipt' ||
      retryStart.payload.action !== 'implement' ||
      retryStart.payload.phase !== 'start'
    )
      throw new Error('expanded implementation start missing')
    const second = history().operations.find(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.action === 'implement' &&
        operation.record.payload.phase === 'result' &&
        operation.record.payload.start.recordId === retryStart.recordId,
    )?.record
    if (outcome === 'negative') {
      expect(dispatched.activeAfterSettlement).toBe(false)
      expect(second).toMatchObject({
        payload: {
          actionId: 'expanded-implementation',
          native: { completion: 'completed', strict: 'valid' },
          structured: { outcome: 'missing-context', missing: [{ reason: 'confirmation is required' }] },
        },
      })
      expect(run('continue')).toMatchObject({ kind: 'blocked' })
    } else {
      expect(second, `Native positive result: ${JSON.stringify(second?.payload)}`).toMatchObject({
        payload: {
          actionId: 'expanded-implementation',
          native: {
            completion: 'completed',
            strict: 'valid',
            bashCalls: expect.arrayContaining([
              expect.objectContaining({ toolCallId: 'context-recovery-proof', exitCode: 0 }),
            ]),
          },
          structured: { outcome: 'implemented', criteria: [{ verification: 'evidence' }] },
          admission: { admitted: true, published: true, remoteTip: expect.stringMatching(/^[0-9a-f]{40}$/) },
        },
      })
      expect(run('continue')).not.toMatchObject({ kind: 'blocked', reason: 'action-context-missing' })
    }
    const afterNegative = readSim(box).issues['42']?.comments.length
    expect(run('recover-context', actionFile)).toMatchObject({ kind: 'blocked' })
    expect(readSim(box).issues['42']?.comments.length).toBe(afterNegative)
    const implementationStarts = history().operations.filter(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.action === 'implement' &&
        operation.record.payload.phase === 'start',
    )
    expect(implementationStarts).toHaveLength(2)
  },
)

it('retains a native implementation context negative across a cold continuation', () => {
  const { box, checkout } = featureFixture('plan')
  const run = (operation: string, negativeRecordId = '') => {
    const child = spawnSync(
      BUN,
      [RUNNER, operation, checkout, JSON.stringify({ reference: '#42', control: 'continue', negativeRecordId })],
      {
        cwd: checkout,
        env: box.env,
        encoding: 'utf8',
      },
    )
    if (child.status !== 0) throw new Error(`feature runner failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as { kind?: string; admitted?: boolean; messages?: string[] }
  }
  const settled = run('omp-context-initial-negative')
  expect(settled.admitted).toBe(true)
  expect(settled.messages?.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
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
  const results = history().operations.flatMap(({ record }) =>
    record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result'
      ? [record]
      : [],
  )
  expect(results).toHaveLength(1)
  expect(results[0]?.payload).toMatchObject({
    admission: null,
    native: {
      completion: 'completed',
      strict: 'valid',
      raw: {
        exitCode: 0,
        structuredOutput: { status: 'valid', data: { outcome: 'blocked', commitSHAs: [], commands: [] } },
      },
    },
  })
  const retained = JSON.stringify(results[0])
  const before = readSim(box).issues['42']?.comments.length
  expect(run('continue')).toMatchObject({ kind: 'blocked' })
  expect(readSim(box).issues['42']?.comments.length).toBe(before)
  expect(
    JSON.stringify(history().operations.find(({ record }) => record?.recordId === results[0]?.recordId)?.record),
  ).toBe(retained)
  expect(run('confirmed-abandon')).toMatchObject({ kind: 'abandoned', confirmed: true })
  const afterAbandon = readSim(box).issues['42']?.comments.length
  expect(run('confirmed-context-successor', 'foreign-negative')).toMatchObject({ kind: 'blocked' })
  expect(readSim(box).issues['42']?.comments.length).toBe(afterAbandon)
  const negative = results[0]
  if (!negative) throw new Error('Native negative missing')
  expect(run('confirmed-context-successor', negative.recordId)).toMatchObject({ kind: 'blocked' })
  expect(readSim(box).issues['42']?.comments.length).toBe(afterAbandon)
  expect(
    JSON.stringify(history().operations.find(({ record }) => record?.recordId === results[0]?.recordId)?.record),
  ).toBe(retained)
})

it('confirms a material handoff and starts fresh planning while retaining the native negative', () => {
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
    return JSON.parse(child.stdout) as {
      kind?: string
      node?: string
      admitted?: boolean
      before?: { version: string }
      after?: { version: string }
      messages?: string[]
      activeAfterSettlement?: boolean
      selected?: { kind: string; node: string }
    }
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
  const negative = history().operations.find(
    ({ record }) =>
      record?.kind === 'action-receipt' &&
      record.payload.action === 'implement' &&
      record.payload.phase === 'result' &&
      record.payload.admission === null,
  )?.record
  if (negative?.kind !== 'action-receipt') throw new Error('Native negative unavailable')
  const retained = JSON.stringify(negative)
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Fixture issue unavailable')
    issue.body = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone').body
  })
  const accepted = run('accept-context-material')
  expect(accepted.before?.version).toBeDefined()
  expect(accepted.after?.version).toBeDefined()
  expect(accepted.after?.version).not.toBe(accepted.before?.version)
  expect(run('confirmed-abandon')).toMatchObject({ kind: 'abandoned', confirmed: true })
  const planned = run('confirmed-context-successor-plan', negative.recordId)
  expect(planned.selected).toMatchObject({ kind: 'action', node: 'plan' })
  const after = history()
  const selection = after.operations.find(
    ({ record }) =>
      record?.kind === 'operator-control' &&
      record.payload.control === 'select-successor' &&
      record.payload.contextDisposition?.negative.record.recordId === negative.recordId,
  )?.record
  expect(selection).toMatchObject({
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      contextDisposition: {
        kind: 'superseded-not-delivered',
        negative: { record: { recordId: negative.recordId } },
      },
    },
  })
  expect(JSON.stringify(after.operations.find(({ record }) => record?.recordId === negative.recordId)?.record)).toBe(
    retained,
  )
  expect(
    after.operations.filter(
      ({ record }) =>
        record?.kind === 'action-receipt' &&
        record.payload.action === 'plan-review' &&
        record.payload.phase === 'result',
    ),
  ).toHaveLength(2)
  const implementation = run('omp-context-initial-positive')
  expect(implementation.admitted).toBe(true)
  // No agent_end is emitted by this driver: settlement itself must hand the
  // predecessor mask to the public review announcement without clearing it.
  expect(implementation.messages?.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(2)
  expect(implementation.activeAfterSettlement).toBe(true)
  const completed = history()
  const implementations = completed.operations.flatMap(({ record }) =>
    record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result'
      ? [record]
      : [],
  )
  expect(implementations).toHaveLength(2)
  expect(implementations[1]?.payload).toMatchObject({ admission: { admitted: true } })
  expect(JSON.stringify(implementations[0])).toBe(retained)
  writeFileSync(path.join(checkout, 'README.md'), 'unreconciled local effect\n')
  expect(run('continue')).toMatchObject({ kind: 'blocked' })
  expect(
    history().operations.filter(
      ({ record }) =>
        record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'start',
    ),
  ).toHaveLength(2)
  writeFileSync(path.join(checkout, 'README.md'), 'region preserved\ntimezone preserved\n')
  expect(run('continue')).not.toMatchObject({ kind: 'action', node: 'implement' })
  expect(
    history().operations.filter(
      ({ record }) =>
        record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'start',
    ),
  ).toHaveLength(2)
})

it.each(['plan', 'plan-review'] as const)(
  'starts fresh implementation after a material handoff from a native %s context negative',
  (action) => {
    const { box, checkout: originalCheckout } = featureFixture('mandate')
    const worktreeRoot = path.join(box.root, 'context-worktrees')
    const checkout = path.join(worktreeRoot, 'app', 'feat-42-save')
    mkdirSync(path.dirname(checkout), { recursive: true })
    git(box, box.principal, ['worktree', 'move', originalCheckout, checkout])
    const env = { ...box.env, OMP_WORKTREE_DIR: worktreeRoot }
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
        { cwd: checkout, env, encoding: 'utf8' },
      )
      if (child.status !== 0) throw new Error(`feature runner failed: ${child.stderr}\n${child.stdout}`)
      return JSON.parse(child.stdout)
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
      [
        path.resolve(import.meta.dirname, '../../testing/feature-planner-context-runner.ts'),
        checkout,
        action === 'plan' ? 'negative' : 'positive-then-negative',
      ],
      { cwd: checkout, env, encoding: 'utf8' },
    )
    if (planner.status !== 0) throw new Error(`Native planning failed: ${planner.stderr}\n${planner.stdout}`)
    expect(JSON.parse(planner.stdout).admitted).toBe(true)
    const negative = history().operations.find(
      ({ record }) =>
        record?.kind === 'action-receipt' &&
        record.payload.action === action &&
        record.payload.phase === 'result' &&
        record.payload.admission === null,
    )?.record
    if (negative?.kind !== 'action-receipt') throw new Error('Native planner negative unavailable')
    const retained = JSON.stringify(negative)
    writeSim(box, (state) => {
      const issue = state.issues['42']
      if (!issue) throw new Error('Fixture issue unavailable')
      issue.body = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone').body
    })
    const accepted = run('accept-context-material')
    expect(accepted.after?.version).not.toBe(accepted.before?.version)
    expect(run('confirmed-abandon')).toMatchObject({ kind: 'abandoned', confirmed: true })
    expect(run('confirmed-context-successor-plan', negative.recordId).selected).toMatchObject({
      kind: 'action',
      node: 'plan',
    })
    expect(run('omp-context-initial-positive')).toMatchObject({ admitted: true })
    const completed = history()
    expect(
      JSON.stringify(completed.operations.find(({ record }) => record?.recordId === negative.recordId)?.record),
    ).toBe(retained)
    expect(
      completed.operations.filter(
        ({ record }) =>
          record?.kind === 'action-receipt' &&
          record.payload.action === 'implement' &&
          record.payload.phase === 'start',
      ),
    ).toHaveLength(1)
    expect(
      completed.operations.some(
        ({ record }) =>
          record?.kind === 'action-receipt' &&
          record.payload.action === 'implement' &&
          record.payload.phase === 'result' &&
          record.payload.admission?.admitted === true,
      ),
    ).toBe(true)
  },
)
