import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { git, readSim, sandbox, writeSim } from '../../skills/feature/__fixtures__/proof/sandbox-repository.ts'
import type { Box } from '../../skills/feature/__fixtures__/proof/sandbox-types.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'

const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
const BRANCH = 'feat/42-save'
const BODY = '## Acceptance criteria\n\n- [ ] preserves the region\n'

const INCOMPLETE_NATIVE_TERMINAL = {
  index: 0,
  id: 'R-workflow-implement',
  agent: 'R-workflow-implement',
  exitCode: 1,
  structuredOutput: { status: 'invalid', data: { refusal: 'incomplete-native' } },
}
const {
  clearPlanContribution,
  featureMandate,
  framedBodies,
  planDraftRecords,
  planReviewRecord,
  planReviewStart,
  publishedPlanDigest,
} = roxabiWorkflowFixtures()

const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function invoke<T>(box: Box, cwd: string, home: string, operation: string, payload: object = {}): T {
  mkdirSync(home, { recursive: true })
  const run = spawnSync(BUN, [RUNNER, operation, cwd, JSON.stringify(payload)], {
    cwd,
    env: { ...box.env, HOME: home },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${operation} failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as T
}

function history(box: Box) {
  const comments = readSim(box).issues['42']?.comments ?? []
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: comments.map((comment, index) => ({
      locator: `acme/app#42:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    diagnostics: [],
  })
}

function liveFeatureFixture(): { box: Box; checkout: string } {
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
    branches: [{ name: BRANCH, from: 'main', commits: [] }],
    issues: [{ number: 42, title: 'feat: preserve region' }],
    prs: [],
  })
  roots.add(box.root)
  const checkout = path.join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', checkout, BRANCH])
  const mandate = featureMandate(SCOPE, { branch: BRANCH, body: BODY, lineageHead: box.sha.main })
  const records = [
    mandate,
    ...planDraftRecords(mandate),
    planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
    planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ]),
  ]
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('feature fixture is missing issue #42')
    issue.body = BODY
    issue.comments.push(...framedBodies(records, 'operator').map((body) => ({ author: 'operator', body })))
  })
  return { box, checkout }
}

function implementationRecords(box: Box, phase: 'start' | 'result') {
  return history(box).operations.flatMap((operation) => {
    const record = operation.record
    return record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === phase
      ? [record]
      : []
  })
}

describe('feature native lifecycle through the installed OMP extension', () => {
  it('retains the original captured implementation result when a confirmed public pause interleaves at authorize-push', () => {
    const { box, checkout } = liveFeatureFixture()
    const remoteBefore = git(box, box.root, ['--git-dir', box.origin, 'rev-parse', `refs/heads/${BRANCH}`])
    const observed = invoke<{
      operationId: string
      cloneRetained: boolean
      activeAfterCompletion: boolean
      pushAttempted: boolean
      messages: string[]
      completionError: string | null
      captures: { red: { toolCallId: string; exitCode: number }; green: { toolCallId: string; exitCode: number } }
    }>(box, checkout, path.join(box.root, 'home-confirmed-live'), 'omp-live-interleave')

    expect(observed.cloneRetained).toBe(true)
    expect(observed.completionError).toBeNull()
    expect(observed.activeAfterCompletion).toBe(false)
    expect(observed.pushAttempted).toBe(false)
    expect(git(box, box.root, ['--git-dir', box.origin, 'rev-parse', `refs/heads/${BRANCH}`])).toBe(remoteBefore)
    expect(observed.messages).toContain('pause-confirmed: pause-confirmed')
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
    expect(observed.captures).toEqual({
      red: { toolCallId: 'implementation-proof-red', exitCode: 1 },
      green: { toolCallId: 'implementation-proof-green', exitCode: 0 },
    })

    const starts = implementationRecords(box, 'start')
    const results = implementationRecords(box, 'result')
    expect(starts).toHaveLength(1)
    expect(results).toHaveLength(1)
    const start = starts[0]
    expect(start).toBeDefined()
    expect(results[0]?.payload).toMatchObject({
      actionId: observed.operationId,
      mandate: { scope: SCOPE, recordId: 'mandate-feature-1', kind: 'mandate' },
      exactInputs: { mandateId: 'mandate-feature-1', planActionId: 'act-plan-1' },
      start: { scope: SCOPE, recordId: start?.recordId, kind: 'action-receipt' },
      native: {
        completion: 'completed',
        strict: 'valid',
        raw: {
          id: 'R-workflow-implement',
          agent: 'R-workflow-implement',
          exitCode: 0,
          structuredOutput: { status: 'valid' },
        },
        bashCalls: expect.arrayContaining([
          expect.objectContaining({ toolCallId: 'implementation-proof-red', exitCode: 1, effectiveCwd: checkout }),
          expect.objectContaining({ toolCallId: 'implementation-proof-green', exitCode: 0, effectiveCwd: checkout }),
        ]),
      },
      admission: { admitted: false, published: false, reason: 'implementation-admission-refused' },
    })
  })

  it('persists an unconfirmed public pause and prevents a later repaired disarm from redispatching work', () => {
    const { box, checkout } = liveFeatureFixture()
    const observed = invoke<{ messages: string[]; pausePr: number }>(
      box,
      checkout,
      path.join(box.root, 'home-unconfirmed-live'),
      'omp-unconfirmed-pause',
    )

    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
    expect(
      history(box).operations.some(
        (operation) =>
          operation.record?.kind === 'operator-control' && operation.record.payload.control === 'pause-requested',
      ),
    ).toBe(true)
    expect(
      history(box).operations.some(
        (operation) =>
          operation.record?.kind === 'operator-control' && operation.record.payload.control === 'pause-confirmed',
      ),
    ).toBe(false)

    writeSim(box, (state) => {
      const pull = state.prs[String(observed.pausePr)]
      if (pull === undefined) throw new Error('feature fixture is missing pause disarm pull request')
      Object.assign(pull, { labels: [] })
    })
    const cold = path.join(box.root, 'cold-after-unconfirmed')
    git(box, box.root, ['clone', '-q', '--branch', BRANCH, box.origin, cold])
    const callsBefore = readSim(box).calls.length
    const resumed = invoke<{ kind: string; reason: string }>(
      box,
      cold,
      path.join(box.root, 'home-cold-after-unconfirmed'),
      'continue',
      { reference: '#42' },
    )

    expect(resumed).toMatchObject({ kind: 'blocked', reason: 'pause-unconfirmed' })
    expect(
      readSim(box)
        .calls.slice(callsBefore)
        .filter((args) => args.includes('--method')),
    ).toEqual([])
    expect(implementationRecords(box, 'start')).toHaveLength(1)
  })

  it('durably retains an incomplete native child before the Feature host stops without continuation or approval', () => {
    const { box, checkout } = liveFeatureFixture()
    const localHeadBefore = git(box, checkout, ['rev-parse', 'HEAD'])
    expect(localHeadBefore).toBe(box.sha.main)
    const remoteBefore = git(box, box.root, ['--git-dir', box.origin, 'rev-parse', `refs/heads/${BRANCH}`])
    const observed = invoke<{
      operationId: string
      activeAfterSettlement: boolean
      messages: string[]
    }>(box, checkout, path.join(box.root, 'home-incomplete-native'), 'omp-incomplete-native')

    expect(observed.activeAfterSettlement).toBe(false)
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
    expect(git(box, checkout, ['rev-parse', 'HEAD'])).toBe(localHeadBefore)
    expect(git(box, box.root, ['--git-dir', box.origin, 'rev-parse', `refs/heads/${BRANCH}`])).toBe(remoteBefore)
    const starts = implementationRecords(box, 'start')
    const start = starts[0]
    expect(starts).toHaveLength(1)
    expect(start).toBeDefined()
    const results = implementationRecords(box, 'result')
    expect(results).toHaveLength(1)
    expect(results[0]?.payload).toMatchObject({
      action: 'implement',
      actionId: observed.operationId,
      start: { scope: SCOPE, recordId: start?.recordId, kind: 'action-receipt' },
      exactInputs: { mandateId: 'mandate-feature-1', planActionId: 'act-plan-1' },
      native: {
        completion: 'incomplete',
        strict: 'invalid',
        raw: INCOMPLETE_NATIVE_TERMINAL,
      },
      admission: { admitted: false, published: false, reason: 'action-uncertain' },
    })
  })
})
