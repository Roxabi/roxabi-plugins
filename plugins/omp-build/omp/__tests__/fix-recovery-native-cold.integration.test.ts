import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { featureMandate, pullHistory } from '../../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture } from '../../testing/feature-review-fixture.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = resolve(import.meta.dirname, '../../testing/fix-recovery-cold-worker.ts')
const fault = resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts')
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it.each([
  { scenario: 'confirmed C0 with no R', rejectBefore: true },
  { scenario: 'complete R with its POST response lost before confirmation', rejectBefore: false },
])(
  'cold-closes $scenario and starts fresh ordinary native work on the same PR',
  ({ rejectBefore }) => {
    const { box, cwd } = arrangeReviewFixture(`feat/42-save-${randomUUID()}`)
    roots.add(box.root)
    const wrapper = join(box.root, 'bin', 'gh')
    unlinkSync(wrapper)
    symlinkSync(fault, wrapper)
    const ghConfig = join(box.root, 'gh-config')
    mkdirSync(ghConfig)
    const env: NodeJS.ProcessEnv = {
      ...box.env,
      HOME: box.root,
      GH_CONFIG_DIR: ghConfig,
      GH_SIM_STATE: box.stateFile,
      RECOVERY_TEST_CREDENTIAL: 'fixture-model-only',
    }
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'])
      delete env[key]
    const invoke = (mode: 'seed' | 'old' | 'new', extra: NodeJS.ProcessEnv = {}) => {
      const input = JSON.stringify({ ...box, env: {} })
      const run = spawnSync(bun, [worker, mode, cwd, box.root, box.stateFile, input], {
        cwd,
        env: { ...env, ...extra },
        encoding: 'utf8',
        timeout: 120_000,
      })
      expect(run.status, `${mode}: ${run.stderr}\n${run.stdout}`).toBe(0)
      if (mode === 'seed') return null
      const line = run.stdout
        .trim()
        .split('\n')
        .findLast((item) => item.startsWith('{"mode"'))
      expect(line, `${mode}: ${run.stderr}\n${run.stdout}`).toBeDefined()
      if (line === undefined) throw new Error(`${mode}: output missing`)
      return { ...JSON.parse(line), workerStderr: run.stderr }
    }
    invoke('seed')
    const before = readSim(box)
    const marker = join(box.root, 'refused-request.json')
    const ghTrace = join(box.root, 'gh-operations.jsonl')
    const old = invoke('old', {
      FIX_RECOVERY_FAULT_KIND: 'fix-request',
      FIX_RECOVERY_FAULT_BEFORE: rejectBefore ? '1' : '0',
      FIX_RECOVERY_FAULT_MARKER: marker,
      FIX_RECOVERY_FAULT_RELEASE: join(box.root, 'release-request'),
      FIX_RECOVERY_FAIL_RECONCILE: rejectBefore ? '0' : '1',
      RECOVERY_GH_TRACE: ghTrace,
    })
    expect(old).toMatchObject({
      mode: 'old',
      leaseWasHeld: true,
      leaseReleased: true,
      nativeDispatches: [],
      children: [],
    })
    expect(old.marker).toMatchObject({ kind: 'fix-request', before: rejectBefore })
    if (!rejectBefore) {
      expect(existsSync(`${marker}.read-failed`), 'actual post-failure reconciliation GET must be refused once').toBe(
        true,
      )
      expect(JSON.parse(readFileSync(`${marker}.read-failed`, 'utf8'))).toMatchObject({
        operation: 'reconcile-page-one',
      })
    }
    const issue = featureMandate(box).history
    const settlement = issue.operations.find(
      (item) => item.record?.kind === 'fix-owner' && item.record.payload.phase === 'settled',
    )
    expect(
      settlement?.status,
      JSON.stringify({
        old,
        ghTrace: existsSync(ghTrace) ? readFileSync(ghTrace, 'utf8') : null,
        issueOperations: issue.operations,
        issueDiagnostics: issue.diagnostics,
        issueComments: issue.source.comments,
        pull: pullHistory(box),
      }),
    ).toBe('complete')
    expect(settlement?.record?.payload).toMatchObject({
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
    const interrupted = pullHistory(box)
    expect(
      interrupted.operations.some(
        (item) =>
          item.status === 'complete' &&
          item.record?.kind === 'contribution' &&
          item.record.payload.content === 'operator-request',
      ),
    ).toBe(true)
    expect(
      interrupted.operations.some((item) => item.status === 'complete' && item.record?.kind === 'fix-request'),
    ).toBe(!rejectBefore)
    const rawBefore = readSim(box).prs['7']?.comments.map((item) => item.body) ?? []
    if (rejectBefore) expect(rawBefore).not.toContain(old.marker.body)
    else expect(rawBefore).toContain(old.marker.body)
    const next = invoke('new')
    expect(next).toMatchObject({ mode: 'new', recoveryCalled: true, nativeCalled: true })
    expect(next.pid).not.toBe(old.pid)
    expect(next.sessionId).not.toBe(old.sessionId)
    expect(next.approvals).toBeGreaterThan(0)
    expect(next.confirmations).toBe(1)
    expect(next.dialogs.length).toBeGreaterThan(0)
    expect(next.nativeDispatches).toContain('cold-native')
    expect(
      pullHistory(box).operations.some(
        (item) =>
          item.status === 'complete' &&
          item.record?.kind === 'fix-recovery' &&
          item.record.repository === 'acme/app' &&
          item.record.target === 'acme/app#7',
      ),
    ).toBe(true)
    expect(next.children.length).toBeGreaterThan(0)
    expect(next.probe).toContain('save')
    const after = pullHistory(box)
    expect(after.operations.some((item) => item.record?.kind === 'fix-request')).toBe(true)
    const rawAfter = readSim(box).prs['7']?.comments.map((item) => item.body) ?? []
    expect(rawAfter).toEqual(expect.arrayContaining(rawBefore))
    expect(readSim(box).issues['42']?.comments.length).toBeGreaterThan(before.issues['42']?.comments.length ?? 0)
  },
  180_000,
)

it('retains an actual first C0 fragment at the default production limit with a real long push URL', () => {
  const branch = `feat/42-save-${randomUUID()}`
  const { box, cwd } = arrangeReviewFixture(branch)
  roots.add(box.root)
  const wrapper = join(box.root, 'bin', 'gh')
  unlinkSync(wrapper)
  symlinkSync(fault, wrapper)
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
  const invoke = (mode: 'seed' | 'old-torn' | 'new', extra: NodeJS.ProcessEnv = {}) => {
    const run = spawnSync(bun, [worker, mode, cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} })], {
      cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(run.status, `${mode}: ${run.stderr}\n${run.stdout}`).toBe(0)
    if (mode === 'seed') return null
    const line = run.stdout
      .trim()
      .split('\n')
      .findLast((item) => item.startsWith('{"mode"'))
    expect(line, `${mode}: ${run.stderr}\n${run.stdout}`).toBeDefined()
    if (line === undefined) throw new Error(`${mode}: output missing`)
    return { ...JSON.parse(line), workerStderr: run.stderr }
  }
  invoke('seed')
  const deep = join(box.root, ...Array.from({ length: 12 }, (_, index) => `${index}-${'x'.repeat(115)}`))
  mkdirSync(deep, { recursive: true })
  const pushUrl = join(deep, 'origin.git')
  symlinkSync(box.origin, pushUrl)
  git(box, cwd, ['remote', 'set-url', '--push', 'origin', pushUrl])
  writeSim(box, (state) => {
    state.repositoryUrls = { ...state.repositoryUrls, [pushUrl]: 'acme/app' }
  })
  expect(git(box, cwd, ['remote', 'get-url', '--push', 'origin'])).toBe(pushUrl)
  const head = box.sha[branch]
  if (!head) throw new Error('fixture-head-missing')
  expect(git(box, cwd, ['ls-remote', '--refs', pushUrl, `refs/heads/${branch}`])).toContain(head)
  const old = invoke('old-torn', {
    FIX_RECOVERY_FAULT_KIND: 'contribution',
    FIX_RECOVERY_FAULT_MARKER: join(box.root, 'accepted-source.json'),
    FIX_RECOVERY_FAULT_RELEASE: join(box.root, 'release-source'),
  })
  expect(old).toMatchObject({
    mode: 'old-torn',
    leaseWasHeld: true,
    leaseReleased: true,
    nativeDispatches: [],
    children: [],
  })
  expect(old.marker).toMatchObject({ kind: 'contribution', before: false })
  expect(old.marker.body).toMatch(/kind=contribution .*part=1\/[2-9]/)
  const issue = featureMandate(box).history
  const settlement = issue.operations.find(
    (item) => item.record?.kind === 'fix-owner' && item.record.payload.phase === 'settled',
  )
  expect(settlement?.status, JSON.stringify({ old, issue: issue.operations, pull: pullHistory(box) })).toBe('complete')
  expect(settlement?.record?.payload).toMatchObject({
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
  const interrupted = pullHistory(box)
  expect(interrupted.operations.some((item) => item.kind === 'contribution' && item.status === 'incomplete')).toBe(true)
  expect(interrupted.operations.some((item) => item.record?.kind === 'fix-request')).toBe(false)
  const rawBefore = readSim(box).prs['7']?.comments.map((item) => item.body) ?? []
  expect(rawBefore).toContain(old.marker.body)
  const next = invoke('new')
  expect(next).toMatchObject({ mode: 'new', recoveryCalled: true, nativeCalled: true })
  expect(next.pid).not.toBe(old.pid)
  expect(next.nativeDispatches).toContain('cold-native')
  expect(next.children.length).toBeGreaterThan(0)
  expect(next.probe).toContain('save')
  expect(
    pullHistory(box).operations.some(
      (item) =>
        item.status === 'complete' &&
        item.record?.kind === 'fix-recovery' &&
        item.record.repository === 'acme/app' &&
        item.record.target === 'acme/app#7',
    ),
  ).toBe(true)
  expect(readSim(box).prs['7']?.comments.map((item) => item.body)).toEqual(expect.arrayContaining(rawBefore))
}, 180_000)
