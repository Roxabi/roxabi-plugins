import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { featureMandate, pullHistory } from '../../testing/feature-ci-review-fixture.ts'
import { arrangeRecoveryReviewFixture } from '../../testing/fix-recovery-review-prelude.ts'
import { readSim } from '../../testing/sandbox/sandbox-repository.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = resolve(import.meta.dirname, '../../testing/fix-recovery-adoption-worker.ts')
const fault = resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts')
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('adopts the real unspent review decision and original request across physical SDK roots through final-head review', () => {
  const { box, cwd } = arrangeRecoveryReviewFixture('defect')
  roots.add(box.root)
  const branch = readSim(box).prs['7']?.headRefName
  if (!branch || !box.sha[branch]) throw new Error('adoption-fixture-branch-missing')
  const gh = join(box.root, 'bin', 'gh')
  unlinkSync(gh)
  symlinkSync(fault, gh)
  mkdirSync(join(box.root, 'gh-config'))
  const env: NodeJS.ProcessEnv = {
    ...box.env,
    HOME: box.root,
    GH_CONFIG_DIR: join(box.root, 'gh-config'),
    GH_SIM_STATE: box.stateFile,
    RECOVERY_TEST_CREDENTIAL: 'fixture-model-only',
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'])
    delete env[key]
  const invoke = (mode: 'prelude' | 'old' | 'new', extra: NodeJS.ProcessEnv = {}) => {
    const started = Date.now()
    const run = spawnSync(bun, [worker, mode, cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} })], {
      cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 240_000,
    })
    expect(
      run.status,
      run.status === 0
        ? ''
        : `${mode}: status=${run.status} signal=${run.signal} errorCode=${(run.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'} elapsedMs=${Date.now() - started} availableParallelism=${availableParallelism()} cpu=${cpus()[0]?.model ?? 'unknown'}\n${run.stderr}\n${run.stdout}`,
    ).toBe(0)
    const line = run.stdout
      .trim()
      .split('\n')
      .findLast((entry) => entry.startsWith(`{"mode":"${mode}"`))
    expect(line, `${mode}: ${run.stderr}\n${run.stdout}`).toBeDefined()
    if (line === undefined) throw new Error(`${mode}: output missing`)
    return JSON.parse(line)
  }
  const setup = invoke('prelude')
  expect(setup.review.review.payload.decisionId).toBe(setup.review.decisionId)
  expect(setup.review.decision.payload.judgment.purpose).toBe('review')
  expect(setup.review.children.length).toBeGreaterThan(0)
  expect(setup.review.childProbes.length).toBeGreaterThan(0)
  const marker = join(box.root, 'accepted-review-bound-request')
  const old = invoke('old', {
    FIX_RECOVERY_FAULT_KIND: 'fix-request',
    FIX_RECOVERY_FAULT_BEFORE: '0',
    FIX_RECOVERY_FAULT_MARKER: marker,
    FIX_RECOVERY_FAULT_RELEASE: join(box.root, 'release-request'),
    FIX_RECOVERY_FAIL_RECONCILE: '1',
    RECOVERY_GH_TRACE: join(box.root, 'review-bound-gh-operations.jsonl'),
    OMP_BUILD_TEST_RECOVERY_HOST_DIAGNOSTICS: '1',
  })
  expect(old).toMatchObject({ mode: 'old', held: true, released: true, nativeDispatches: [], children: [] })
  expect(existsSync(`${marker}.read-failed`)).toBe(true)
  expect(JSON.parse(readFileSync(`${marker}.read-failed`, 'utf8'))).toMatchObject({ operation: 'reconcile-page-one' })
  expect(old.settled.payload).toMatchObject({
    admissionSealed: true,
    witness: {
      kind: 'sealed-no-entry',
      nativeAdmission: 'not-entered',
      correctionPlan: 'not-entered',
      driver: 'joined',
      publications: 'joined',
      git: 'joined',
      hostCallbacks: 'joined',
    },
  })
  const before = pullHistory(box).operations.flatMap((entry) =>
    entry.status === 'complete' && entry.record ? [entry.record] : [],
  )
  const request = before.find((record) => record.kind === 'fix-request')
  if (request?.kind !== 'fix-request') throw new Error('adoption-original-request-missing')
  expect(request.payload.existingReviewId).toBe(setup.review.reviewId)
  expect(before.filter((record) => record.kind === 'fix-request')).toHaveLength(1)
  expect(before.filter((record) => record.kind === 'decision')).toHaveLength(1)
  expect(before.some((record) => record.kind === 'fix-result' || record.kind === 'correction-result')).toBe(false)
  const rawBefore = readSim(box).prs['7']?.comments.map((entry) => entry.body) ?? []
  const next = invoke('new', {
    RECOVERY_PRELUDE_REVIEW_ID: setup.review.reviewId,
    RECOVERY_ORIGINAL_REQUEST_ID: request.recordId,
    RECOVERY_ORIGINAL_DECISION_ID: setup.review.decisionId,
  })
  expect(next.pid).not.toBe(old.pid)
  expect(next.sessionId).not.toBe(old.sessionId)
  expect(next.recoveryCalled).toBe(true)
  expect(next.finalReviewRequested).toBe(true)
  expect(next.approvals).toBeGreaterThan(0)
  expect(next.confirmations).toBeGreaterThan(0)
  expect(next.nativeDispatches.length).toBeGreaterThan(0)
  expect(next.children.length).toBeGreaterThan(0)
  expect(next.code).toContain('return region')
  expect(next.head).not.toBe(box.sha[branch])
  const after = pullHistory(box).operations.flatMap((entry) =>
    entry.status === 'complete' && entry.record ? [entry.record] : [],
  )
  expect(after.filter((record) => record.kind === 'fix-request').map((record) => record.recordId)).toEqual([
    request.recordId,
  ])
  expect(
    after
      .filter((record) => record.kind === 'contribution' && record.payload.content === 'operator-request')
      .map((record) => record.recordId),
  ).toEqual(
    before
      .filter((record) => record.kind === 'contribution' && record.payload.content === 'operator-request')
      .map((record) => record.recordId),
  )
  const result = after.find((record) => record.kind === 'fix-result' && record.payload.requestId === request.recordId)
  expect(result).toMatchObject({
    runId: request.runId,
    payload: { requestId: request.recordId, decisionId: setup.review.decisionId, candidateGitSHA: next.head },
  })
  if (result?.kind !== 'fix-result') throw new Error('adoption-fix-result-missing')
  expect(result.payload.criterionReceipt?.criteria.length).toBeGreaterThan(0)
  const finalReview = after.find(
    (record) =>
      record.kind === 'review' &&
      record.recordId !== setup.review.reviewId &&
      record.payload.candidateGitSHA === next.head,
  )
  expect(finalReview).toBeDefined()
  if (finalReview?.kind !== 'review') throw new Error('adoption-final-review-missing')
  const finalDecision = after.find(
    (record) => record.kind === 'decision' && record.recordId === finalReview.payload.decisionId,
  )
  expect(finalDecision).toMatchObject({ payload: { judgment: { purpose: 'review', findings: [] } } })
  expect(next.replay).toMatchObject({ head: next.head, verdict: 'Approve (clean)' })
  const owners = featureMandate(box).history.operations.flatMap((entry) =>
    entry.status === 'complete' && entry.record ? [entry.record] : [],
  )
  const control = after.find((record) => record.kind === 'fix-recovery' && record.payload.phase === 'adopt-decision')
  expect(control).toMatchObject({
    repository: 'acme/app',
    target: 'acme/app#7',
    payload: {
      phase: 'adopt-decision',
      target: {
        kind: 'decided',
        request: { identity: { recordId: request.recordId } },
        decision: { identity: { recordId: setup.review.decisionId } },
      },
    },
  })
  const claimed = owners.find(
    (record) =>
      record.kind === 'fix-owner' && record.payload.phase === 'opened' && record.recordId !== old.opened.recordId,
  )
  expect(claimed).toBeDefined()
  expect(claimed?.runId).toBe(request.runId)
  expect(claimed?.recordId).not.toBe(old.opened.recordId)
  expect(readSim(box).prs['7']?.comments.map((entry) => entry.body)).toEqual(expect.arrayContaining(rawBefore))
}, 720_000)
