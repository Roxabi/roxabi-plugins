import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { criterionImplementationRecords, criterionReviewGraph } from '../testing/criterion-approval.ts'
import {
  BRANCH,
  cleanupFeatureRecoveryRoots,
  featureFixture,
  OBSERVED_INCOMPLETE_NATIVE_TERMINAL,
  SCOPE,
  trackFeatureRecoveryRoot,
} from '../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../testing/feature-review-fixture.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { git, readSim, sandbox, WORKFLOW, worktree, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'

const RUNNER = path.resolve(import.meta.dirname, '../testing/feature-recovery-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

function plainSpec() {
  return {
    base: {
      '.dev/stack.yml': 'landing:\n  mode: merge-on-green\n',
      'src/a.ts': 'export const add = (a, b) => a + b\n',
    },
    branches: [
      {
        name: 'fix/5-plain',
        from: 'main',
        commits: [
          {
            message: 'fix: plain (#5)',
            files: { 'src/a.ts': 'export const add = (a, b) => a + b\nexport const plain = true\n' },
          },
        ],
      },
    ],
    issues: [{ number: 5, title: 'fix: plain', issueType: 'fix', labels: ['size:S'] }],
    prs: [{ number: 30, branch: 'fix/5-plain', title: 'fix: plain', body: 'Closes #5\n', closes: [5] }],
  }
}

const { projection } = roxabiRecordFixtures()
const { framedBodies, linkedLandingAuthority } = roxabiWorkflowFixtures()

afterEach(cleanupFeatureRecoveryRoots)

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
  git(box, principal, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'])
  git(box, principal, ['config', `url.${box.origin}.insteadOf`, 'https://github.com/acme/app.git'])
  git(box, principal, ['worktree', 'add', '-q', '-b', branch, checkout, `origin/${branch}`])
  return checkout
}

function workflowRead(box: Box, cwd: string, pr: number, head: string) {
  const run = spawnSync(BUN, [WORKFLOW, 'captureReviewInput', cwd, JSON.stringify({ pr, head })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`captureReviewInput failed: ${run.stderr}`)
  return JSON.parse(run.stdout) as { ok: boolean; input?: string | null; inputs?: ActionInputs; reason?: string }
}

function land(box: Box, cwd: string, pr: number): { status: string } {
  const run = spawnSync(
    BUN,
    [WORKFLOW, 'landPr', cwd, JSON.stringify({ pr, landing: { mode: 'native', required_checks: ['ci'] } })],
    { cwd, env: box.env, encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`landPr failed: ${run.stderr}`)
  return JSON.parse(run.stdout) as { status: string }
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

  it('keeps the original live native batch through clone refusal and public session pause', () => {
    const { box, checkout } = featureFixture('plan')
    const observed = invoke<{
      activeBeforePause: boolean
      cloneRetained: boolean
      activeAfterPause: boolean
      messages: string[]
    }>(box, checkout, path.join(box.root, 'home-live-identity'), 'omp-lifetime', {})

    expect(observed.activeBeforePause).toBe(true)
    expect(observed.cloneRetained).toBe(true)
    expect(observed.activeAfterPause).toBe(true)
    expect(observed.messages.join('\n')).toContain('pause-confirmed:')
    const paused = history(box)
    expect(
      paused.operations.some(
        (operation) =>
          operation.record?.kind === 'operator-control' && operation.record.payload.control === 'pause-confirmed',
      ),
    ).toBe(true)
    const starts = paused.operations.filter(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.phase === 'start' &&
        operation.record.payload.action === 'implement',
    )
    expect(starts).toHaveLength(1)
  })

  it('refuses the original START-bound implementation when public pause reaches the authorize-push gate', () => {
    const { box, checkout } = featureFixture('plan')
    const remoteBefore = git(box, box.root, ['--git-dir', box.origin, 'rev-parse', `refs/heads/${BRANCH}`])
    const observed = invoke<{
      operationId: string
      activeAfterCompletion: boolean
      pushAttempted: boolean
      messages: string[]
      completionError: string | null
    }>(box, checkout, path.join(box.root, 'home-live-interleave'), 'omp-live-interleave', {})

    expect(observed.completionError).toBeNull()
    expect(observed.activeAfterCompletion).toBe(false)
    expect(observed.pushAttempted).toBe(false)
    expect(git(box, box.root, ['--git-dir', box.origin, 'rev-parse', `refs/heads/${BRANCH}`])).toBe(remoteBefore)
    expect(observed.messages).toContain('pause-confirmed: pause-confirmed')
    expect(observed.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)

    const paused = history(box)
    const starts = paused.operations.flatMap((operation) => {
      const record = operation.record
      return record?.kind === 'action-receipt' &&
        record.payload.phase === 'start' &&
        record.payload.action === 'implement'
        ? [record]
        : []
    })
    const results = paused.operations.flatMap((operation) => {
      const record = operation.record
      return record?.kind === 'action-receipt' &&
        record.payload.phase === 'result' &&
        record.payload.action === 'implement'
        ? [record]
        : []
    })
    expect(starts).toHaveLength(1)
    expect(results).toHaveLength(1)
    const start = starts[0]
    expect(start).toBeDefined()
    expect(results[0]?.payload).toMatchObject({
      actionId: observed.operationId,
      start: { scope: SCOPE, recordId: start?.recordId, kind: 'action-receipt' },
      admission: { admitted: false, published: false, reason: 'implementation-admission-refused' },
    })
  })
})

describe('feature recovery terminal and publication witnesses', () => {
  it('turns a CLOSED watch into stopped with no cold write effect; it does not witness MERGED landing', () => {
    const box = sandbox({
      base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
      branches: [{ name: 'feat/watch', from: 'main', commits: [] }],
      issues: [{ number: 7, title: 'feat: watch', labels: ['size:S'] }],
      prs: [{ number: 8, branch: 'feat/watch', title: 'feat: watch', body: 'Closes #7', closes: [7] }],
    })
    trackFeatureRecoveryRoot(box.root)
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

  it('cold-observes a real MERGED native landing without new effects', () => {
    const box = sandbox(plainSpec())
    trackFeatureRecoveryRoot(box.root)
    const pr = 30
    const issueNumber = 5
    const branch = 'fix/5-plain'
    const head = box.sha[branch]
    const baseTip = box.sha.main
    if (head === undefined || baseTip === undefined) throw new Error('plain landing fixture missing commit')
    const checkout = worktree(box, 'merged-landing', head)
    const issue = readSim(box).issues[String(issueNumber)]
    if (issue === undefined) throw new Error('plain landing fixture missing issue')
    const landingScope = { repository: 'acme/app', target: `acme/app#${issueNumber}` }
    const landingSpec = nativeFeatureSpec(landingScope, 'lands')
    writeSim(box, (state) => {
      const linkedIssue = state.issues[String(issueNumber)]
      if (linkedIssue === undefined) throw new Error('plain landing fixture missing issue')
      linkedIssue.body = landingSpec.body
    })
    const authority = linkedLandingAuthority({
      repository: 'acme/app',
      issueNumber,
      prNumber: pr,
      branch,
      base: 'main',
      issueBody: landingSpec.body,
      ownSpec: landingSpec.ownSpec,
      lineageHead: head,
      author: 'operator',
    })
    const issueRecords = criterionImplementationRecords(authority.mandate, head)
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      const linkedIssue = state.issues[String(issueNumber)]
      if (pull === undefined || linkedIssue === undefined) throw new Error('plain landing authority endpoints missing')
      pull.comments = authority.bindingBodies.map((body) => ({ author: 'operator', body }))
      linkedIssue.comments = framedBodies(issueRecords, 'operator').map((body) => ({ author: 'operator', body }))
    })
    const captured = workflowRead(box, checkout, pr, head)
    if (captured.ok !== true || typeof captured.input !== 'string' || captured.inputs === undefined) {
      throw new Error(`captureReviewInput refused: ${JSON.stringify(captured)}`)
    }
    const inputs = captured.inputs
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (pull === undefined) throw new Error('plain landing PR missing')
      pull.comments.push(
        ...criterionReviewGraph({
          mandate: authority.mandate,
          issueRecords,
          scope: { repository: 'acme/app', target: 'acme/app#30' },
          head,
          inputs,
          projection,
          author: 'operator',
          verdict: 'Approve (clean)',
          prefix: 'feature-recovery-merged',
        }).comments.map(({ body }) => ({ author: 'operator', body })),
      )
      state.checks[head] = [
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:00:00Z',
        },
      ]
    })
    expect(land(box, checkout, pr)).toEqual({ status: 'merged' })
    const merged = readSim(box).prs[String(pr)]
    expect(merged?.state).toBe('MERGED')
    expect(merged?.mergeCommit?.parents).toEqual([baseTip, head])
    expect(git(box, box.root, ['--git-dir', box.origin, 'rev-parse', 'refs/heads/main'])).toBe(merged?.mergeCommit?.oid)

    const cold = coldCheckout(box, 'merged-cold', branch)
    const callsBefore = readSim(box).calls.length
    expect(
      invoke<{ kind: string; reason: string }>(box, cold, path.join(box.root, 'home-merged-cold'), 'watch', {
        pr,
        code: 0,
        reference: '#5',
      }),
    ).toMatchObject({ kind: 'terminal', reason: 'done' })
    expect(effectCalls(box, callsBefore)).toEqual([])
  })

  it('continues a cold command UW through simulated publication into a fresh review', () => {
    const { box } = featureFixture('confirmed-implementation')
    const cold = coldCheckout(box, 'publication-command')

    const observed = invoke<{ kind: string; pr: number }>(
      box,
      cold,
      path.join(box.root, 'home-publication-command'),
      'cold-publish-uw',
      { reference: '#42' },
    )

    const pulls = Object.values(readSim(box).prs)
    const published = pulls.find((pull) => pull.headRefName === BRANCH)
    expect(published, JSON.stringify(pulls)).toBeDefined()
    if (published === undefined) throw new Error('published pull request missing')
    const pullHistory = decodeHistory({
      scope: { repository: 'acme/app', target: `acme/app#${published.number}` },
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: published.comments.map((comment, index) => ({
        locator: `acme/app#${published.number}:comment:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
    expect(
      pullHistory.operations.some(
        (operation) =>
          operation.record?.kind === 'workflow-binding' &&
          operation.record.payload.mandate.recordId === 'mandate-feature-1' &&
          operation.record.payload.mandate.scope.target === SCOPE.target &&
          operation.record.payload.branch === BRANCH,
      ),
    ).toBe(true)
    expect(observed, JSON.stringify(observed)).toMatchObject({ kind: 'review', pr: published.number })
  })

  it('publishes a refused observed result against the live continuation batch and original start', () => {
    const { box, checkout } = featureFixture('plan')
    const observed = invoke<{
      agent: string
      start: { scope: typeof SCOPE; recordId: string; kind: string }
      operationId: string
      published: { published: boolean; retained: boolean; reason: string }
    }>(box, checkout, path.join(box.root, 'home-publication'), 'continuation-publish', { reference: '#42' })

    expect(observed.agent).toBe('R-workflow-implement')
    expect(observed.published).toEqual({ published: false, retained: true, reason: 'action-uncertain' })
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
      native: {
        completion: 'incomplete',
        strict: 'invalid',
        raw: OBSERVED_INCOMPLETE_NATIVE_TERMINAL,
      },
      admission: { admitted: false, published: false, reason: 'action-uncertain' },
    })
  })
})
