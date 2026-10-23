import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github.ts'
import { type Box, git, readSim, sandbox, writeSim } from '../skills/feature/__fixtures__/proof/sandbox.ts'
import {
  clearPlanContribution,
  featureMandate,
  framedBodies,
  implementStart,
  planDraftRecords,
  planReviewRecord,
  planReviewStart,
  publishedPlanDigest,
} from '../testing/workflow-records.ts'

const RUNNER = path.resolve(import.meta.dirname, '../testing/feature-recovery-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
const BRANCH = 'feat/42-save'
const BODY = '## Acceptance criteria\n\n- [ ] preserves the region\n'

let roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function invoke<T>(box: Box, cwd: string, home: string, operation: string, payload: object): T {
  mkdirSync(home, { recursive: true })
  const run = spawnSync(BUN, [RUNNER, operation, cwd, JSON.stringify(payload)], {
    cwd,
    env: { ...box.env, HOME: home },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${operation} failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as T
}

function history(box: Box, number = 42) {
  const comments = readSim(box).issues[String(number)]?.comments ?? []
  return decodeHistory({
    scope: { repository: 'acme/app', target: `acme/app#${number}` },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: comments.map((comment, index) => ({
      locator: `acme/app#${number}:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    diagnostics: [],
  })
}

function effectCalls(box: Box, start: number): string[][] {
  return readSim(box)
    .calls.slice(start)
    .filter((args) => {
      const joined = args.join(' ')
      return joined.includes('--method') || /\b(comment|edit|merge)\b/.test(joined)
    })
}

function coldCheckout(box: Box, name: string, branch = BRANCH): string {
  const principal = path.join(box.root, `${name}-principal`)
  const checkout = path.join(box.root, `${name}-checkout`)
  git(box, box.root, ['clone', '-q', box.origin, principal])
  git(box, principal, ['worktree', 'add', '-q', '-b', branch, checkout, `origin/${branch}`])
  return checkout
}

function featureFixture(
  records: 'plan' | 'start',
  options: { malformedDisarmPr?: boolean } = {},
): { box: Box; checkout: string } {
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
    branches: [{ name: BRANCH, from: 'main', commits: [] }],
    issues: [{ number: 42, title: 'feat: preserve region' }],
    prs: options.malformedDisarmPr
      ? [{ number: 9, branch: BRANCH, title: 'unreadable pause gate', body: '', closes: [] }]
      : [],
  })
  roots.push(box.root)
  const checkout = path.join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', checkout, BRANCH])
  const mandate = featureMandate(SCOPE, { branch: BRANCH, body: BODY, lineageHead: box.sha.main })
  const accepted =
    records === 'plan'
      ? [
          mandate,
          ...planDraftRecords(mandate),
          planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
          planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
            clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
            clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
          ]),
        ]
      : [mandate, implementStart(mandate)]
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('missing feature issue')
    issue.body = BODY
    issue.comments.push(...framedBodies(accepted, 'operator').map((body) => ({ author: 'operator', body })))
  })
  if (options.malformedDisarmPr) {
    writeSim(box, (state) => {
      const pull = state.prs['9']
      if (!pull) throw new Error('missing disarm pull request')
      Object.assign(pull, { labels: [1] })
    })
  }
  return { box, checkout }
}

describe('proof sandbox construction', () => {
  it('removes its allocated root when a branch source is missing', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'omp-proof-construction-'))
    const inherited = process.env.TMPDIR
    process.env.TMPDIR = parent
    try {
      expect(() =>
        sandbox({
          base: { 'README.md': 'base\n' },
          branches: [{ name: 'feat/missing', from: 'missing-source', commits: [] }],
          issues: [],
          prs: [],
        }),
      ).toThrow()
      expect(readdirSync(parent)).toEqual([])
    } finally {
      if (inherited === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = inherited
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('feature recovery through the installed OMP bridge', () => {
  it('cold-recovers a confirmed plan as one implementation batch, confirms pause, then refuses a fresh continuation', () => {
    const { box, checkout } = featureFixture('plan')
    invoke<{ messages: string[] }>(box, checkout, path.join(box.root, 'home-live'), 'omp-pause', {})

    const liveHistory = history(box)
    expect(
      liveHistory.operations.some(
        (operation) =>
          operation.record?.kind === 'operator-control' && operation.record.payload.control === 'pause-confirmed',
      ),
    ).toBe(true)
    const implementStarts = liveHistory.operations.flatMap((operation) => {
      const record = operation.record
      return record?.kind === 'action-receipt' &&
        record.payload.phase === 'start' &&
        record.payload.action === 'implement'
        ? [record]
        : []
    })
    expect(implementStarts).toHaveLength(1)
    expect(implementStarts[0]?.payload).toMatchObject({
      mandate: { recordId: 'mandate-feature-1', kind: 'mandate' },
      exactInputs: { mandateId: 'mandate-feature-1', planActionId: 'act-plan-1' },
    })
    expect(
      liveHistory.operations.filter(
        (operation) => operation.record?.kind === 'action-receipt' && operation.record.payload.action === 'plan',
      ),
    ).toHaveLength(2)

    const cold = coldCheckout(box, 'paused')
    const commentCount = readSim(box).issues['42']?.comments.length
    const callsBefore = readSim(box).calls.length
    const resumed = invoke<{ kind: string; confirmed: boolean; reason: string }>(
      box,
      cold,
      path.join(box.root, 'home-cold'),
      'continue',
      { reference: '#42' },
    )

    expect(resumed).toEqual({ kind: 'paused', confirmed: true, reason: 'paused' })
    expect(readSim(box).issues['42']?.comments).toHaveLength(commentCount ?? 0)
    expect(effectCalls(box, callsBefore)).toEqual([])
    const resumeCheckout = coldCheckout(box, 'resume')
    const resumedAction = invoke<{ kind: string; reason: string }>(
      box,
      resumeCheckout,
      path.join(box.root, 'home-resume'),
      'continue',
      { reference: '#42', control: 'resume' },
    )
    expect(resumedAction).toMatchObject({ kind: 'blocked', reason: 'action-uncertain' })
    expect(
      history(box).operations.some(
        (operation) => operation.record?.kind === 'operator-control' && operation.record.payload.control === 'resume',
      ),
    ).toBe(true)

    const afterResume = coldCheckout(box, 'after-resume')
    const afterResumeCalls = readSim(box).calls.length
    expect(
      invoke<{ kind: string; reason: string }>(box, afterResume, path.join(box.root, 'home-after-resume'), 'continue', {
        reference: '#42',
      }),
    ).toMatchObject({ kind: 'blocked', reason: 'action-uncertain' })
    expect(effectCalls(box, afterResumeCalls)).toEqual([])
  })

  it('cold-refuses an unconfirmed remote pause before it can start implementation', () => {
    const { box, checkout } = featureFixture('plan', { malformedDisarmPr: true })
    const paused = invoke<{ result: { kind: string; confirmed: boolean; reason: string }; interrupts: number }>(
      box,
      checkout,
      path.join(box.root, 'home-pause-request'),
      'pause',
      { reference: '#42' },
    )
    expect(paused).toEqual({ result: { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }, interrupts: 1 })
    const requested = history(box)
    expect(
      requested.operations.some(
        (operation) =>
          operation.record?.kind === 'operator-control' && operation.record.payload.control === 'pause-requested',
      ),
    ).toBe(true)
    expect(
      requested.operations.some(
        (operation) =>
          operation.record?.kind === 'operator-control' && operation.record.payload.control === 'pause-confirmed',
      ),
    ).toBe(false)
    expect(
      requested.operations.some(
        (operation) => operation.record?.kind === 'action-receipt' && operation.record.payload.action === 'implement',
      ),
    ).toBe(false)

    writeSim(box, (state) => {
      const pull = state.prs['9']
      if (!pull) throw new Error('missing disarm pull request')
      Object.assign(pull, { labels: [] })
    })
    const cold = coldCheckout(box, 'pending-pause')
    const callsBefore = readSim(box).calls.length
    const result = invoke<{ kind: string; reason: string }>(
      box,
      cold,
      path.join(box.root, 'home-pending-pause'),
      'continue',
      {
        reference: '#42',
      },
    )

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'pause-unconfirmed',
      diagnostics: [{ code: 'pause-unconfirmed' }],
    })
    expect(
      history(box).operations.some(
        (operation) => operation.record?.kind === 'action-receipt' && operation.record.payload.action === 'implement',
      ),
    ).toBe(false)
    expect(effectCalls(box, callsBefore)).toEqual([])
  })
})

describe('feature recovery terminal and publication witnesses', () => {
  it('turns a CLOSED watch into stopped with no cold write effect; it does not witness MERGED landing', () => {
    const box = sandbox({
      base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
      branches: [{ name: 'feat/watch', from: 'main', commits: [] }],
      issues: [{ number: 7, title: 'feat: watch' }],
      prs: [{ number: 8, branch: 'feat/watch', title: 'feat: watch', body: 'Closes #7', closes: [7] }],
    })
    roots.push(box.root)
    writeSim(box, (state) => {
      const pull = state.prs['8']
      if (!pull) throw new Error('missing watch pull request')
      pull.state = 'CLOSED'
    })
    const checkout = coldCheckout(box, 'watch', 'feat/watch')
    const first = invoke<{ kind: string; reason: string }>(box, checkout, path.join(box.root, 'home-watch'), 'watch', {
      pr: 8,
      code: 4,
      reference: '#7',
    })
    expect(first).toEqual({ kind: 'terminal', reason: 'stopped' })

    const cold = coldCheckout(box, 'watch-cold', 'feat/watch')
    const callsBefore = readSim(box).calls.length
    const second = invoke<{ kind: string; reason: string }>(
      box,
      cold,
      path.join(box.root, 'home-watch-cold'),
      'watch',
      {
        pr: 8,
        code: 4,
        reference: '#7',
      },
    )
    expect(second).toEqual({ kind: 'terminal', reason: 'stopped' })
    expect(effectCalls(box, callsBefore)).toEqual([])
  })

  it('publishes a refused observed result against the live continuation batch and original start', () => {
    const { box, checkout } = featureFixture('plan')
    const observed = invoke<{
      agent: string
      start: { scope: typeof SCOPE; recordId: string; kind: string }
      operationId: string
      published: { published: boolean; reason: string }
    }>(box, checkout, path.join(box.root, 'home-publication'), 'continuation-publish', { reference: '#42' })

    expect(observed.agent).toBe('R-workflow-implement')
    expect(observed.published).toEqual({ published: false, reason: 'action-uncertain' })
    const results = history(box).operations.flatMap((operation) => {
      const record = operation.record
      return record?.kind === 'action-receipt' &&
        record.payload.phase === 'result' &&
        record.payload.action === 'implement'
        ? [record]
        : []
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.payload).toMatchObject({
      action: 'implement',
      actionId: observed.operationId,
      mandate: { recordId: 'mandate-feature-1', kind: 'mandate' },
      start: observed.start,
      exactInputs: { mandateId: 'mandate-feature-1', planActionId: 'act-plan-1' },
      admission: { admitted: false, published: false, reason: 'action-uncertain' },
    })
  })
})
