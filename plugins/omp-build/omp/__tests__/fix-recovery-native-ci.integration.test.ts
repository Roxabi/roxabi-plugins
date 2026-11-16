import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { featureMandate, pullHistory } from '../../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture } from '../../testing/feature-review-fixture.ts'
import { arrangeRecoveryReviewFixture } from '../../testing/fix-recovery-review-prelude.ts'
import { readSim } from '../../testing/sandbox/sandbox-repository.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = resolve(import.meta.dirname, '../../testing/fix-recovery-ci-worker.ts')
const seedWorker = resolve(import.meta.dirname, '../../testing/fix-recovery-cold-worker.ts')
const fault = resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts')
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('neutrally closes pre-intake CI ownership before a fresh real native CI continuation', () => {
  const { box, cwd } = arrangeRecoveryReviewFixture('healthy')
  roots.add(box.root)
  const branch = readSim(box).prs['7']?.headRefName
  const head = branch === undefined ? undefined : box.sha[branch]
  if (head === undefined) throw new Error('fixture-pr-head-missing')
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
  const input = JSON.stringify({ ...box, env: {} })
  const invoke = (mode: string, extra: NodeJS.ProcessEnv = {}) => {
    const run = spawnSync(bun, [worker, mode, cwd, box.root, box.stateFile, input], {
      cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 180_000,
    })
    // This subprocess trace is diagnostic correlation only, not cohort provenance.
    const trace =
      extra.RECOVERY_GH_TRACE && existsSync(extra.RECOVERY_GH_TRACE)
        ? readFileSync(extra.RECOVERY_GH_TRACE, 'utf8')
        : null
    const diagnostic = `${mode}: ${run.stderr}\n${run.stdout}\nGitHub process trace: ${trace ?? '(unavailable)'}`
    expect(run.status, diagnostic).toBe(0)
    const line = run.stdout
      .trim()
      .split('\n')
      .findLast((item) => item.startsWith('{"mode"'))
    expect(line, diagnostic).toBeDefined()
    if (line === undefined) throw new Error('fixture-worker-output-missing')
    return { ...JSON.parse(line), stderr: run.stderr, stdout: run.stdout, trace }
  }
  const prelude = invoke('prelude')
  expect(prelude.qualityStatus).toBe(1)
  expect(prelude.review.review.payload.candidateGitSHA).toBe(head)
  expect(prelude.review.review.payload.decisionId).toBe(prelude.review.decisionId)
  expect(prelude.review.nativeDispatches.length).toBeGreaterThan(0)
  expect(prelude.review.children.length).toBeGreaterThan(0)
  expect(prelude.review.childProbes.length).toBeGreaterThan(0)

  // Produce attribution with a real child, then refuse its first correction owner before publication.
  const attribution = invoke('attribute', {
    FIX_RECOVERY_FAULT_KIND: 'fix-owner',
    FIX_RECOVERY_FAULT_BEFORE: '1',
    FIX_RECOVERY_FAULT_MARKER: join(box.root, 'attribution-owner-refused'),
  })
  expect(attribution.called).toBe(true)
  expect(attribution.nativeDispatches).toContain('held-native')
  expect(attribution.children.length).toBeGreaterThan(0)
  expect(attribution.receipt.payload).toMatchObject({
    action: 'attribute-ci',
    phase: 'result',
    exactInputs: { candidateGitSHA: head },
    structured: { attribution: 'change' },
  })
  const trace = join(box.root, 'ci-old-gh-trace.jsonl')
  const old = invoke('ci-old', {
    FIX_RECOVERY_FAULT_KIND: 'fix-request',
    FIX_RECOVERY_FAULT_BEFORE: '1',
    FIX_RECOVERY_FAULT_MARKER: join(box.root, 'ci-request-refused'),
    FIX_RECOVERY_FAULT_RELEASE: join(box.root, 'release-ci-request'),
    RECOVERY_GH_TRACE: trace,
  })
  expect(old).toMatchObject({
    mode: 'ci-old',
    leaseWasHeld: true,
    leaseReleased: true,
    nativeDispatches: [],
    children: [],
    marker: { kind: 'fix-request', before: true },
  })
  const uwHistory = featureMandate(box).history
  const prHistory = pullHistory(box)
  const settlement = uwHistory.operations.find(
    (item) =>
      item.status === 'complete' && item.record?.kind === 'fix-owner' && item.record.payload.phase === 'settled',
  )?.record
  const raw = readSim(box)
  expect(
    settlement?.payload,
    JSON.stringify({ old, uwHistory, prHistory, issue: raw.issues['42'], pullRequest: raw.prs['7'] }),
  ).toMatchObject({
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
  expect(pullHistory(box).operations.some((item) => item.record?.kind === 'fix-request')).toBe(false)
  const next = invoke('ci-continue')
  expect(next.pid).not.toBe(old.pid)
  expect(next.sessionId).not.toBe(old.sessionId)
  expect(next.called).toBe(true)
  expect(next.confirmationCount).toBeGreaterThan(0)
  expect(next.approvals).toBeGreaterThan(0)
  expect(next.nativeDispatches).toContain('held-native')
  expect(next.children.length).toBeGreaterThan(0)
  expect(next.probe).toContain('save')
  expect(
    pullHistory(box).operations.some((item) => item.status === 'complete' && item.record?.kind === 'fix-recovery'),
  ).toBe(true)
  const records = pullHistory(box).operations.flatMap((item) =>
    item.status === 'complete' && item.record ? [item.record] : [],
  )
  expect(records.some((record) => record.kind === 'fix-request')).toBe(true)
  expect(
    records.some(
      (record) =>
        record.kind === 'contribution' &&
        record.payload.rawAttempts.some(
          (attempt) =>
            JSON.stringify(attempt.raw).includes(attribution.receipt.recordId) &&
            JSON.stringify(attempt.raw).includes(head),
        ),
    ),
  ).toBe(true)
}, 600_000)

it('refuses public recovery when the originating process exited without a settlement witness', () => {
  const { box, cwd } = arrangeReviewFixture()
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
  const seed = spawnSync(bun, [seedWorker, 'seed', cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} })], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  expect(seed.status, `${seed.stderr}\n${seed.stdout}`).toBe(0)
  const gate = join(box.root, 'release-unjoined-request')
  const marker = join(box.root, 'unjoined-request')
  let origin: ReturnType<typeof spawnSync>
  try {
    origin = spawnSync(bun, [worker, 'no-witness', cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} })], {
      cwd,
      env: {
        ...env,
        FIX_RECOVERY_FAULT_KIND: 'fix-request',
        FIX_RECOVERY_FAULT_BEFORE: '1',
        FIX_RECOVERY_FAULT_MARKER: marker,
        FIX_RECOVERY_FAULT_RELEASE: gate,
      },
      encoding: 'utf8',
      timeout: 120_000,
    })
  } finally {
    // The separately running fault wrapper refuses before dispatch; let it exit.
    writeFileSync(gate, 'release\n')
  }
  expect(origin.status, `${origin.stderr}\n${origin.stdout}`).toBe(0)
  const line = String(origin.stdout)
    .trim()
    .split('\n')
    .findLast((item) => item.startsWith('{"mode"'))
  expect(line).toBeDefined()
  if (line === undefined) throw new Error('fixture-origin-output-missing')
  const previous = JSON.parse(line)
  expect(previous).toMatchObject({ mode: 'no-witness', leaseHeld: true, nativeDispatches: [], children: [] })
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ kind: 'fix-request', before: true })
  const history = featureMandate(box).history
  expect(
    history.operations.some(
      (item) =>
        item.status === 'complete' && item.record?.kind === 'fix-owner' && item.record.payload.phase === 'opened',
    ),
  ).toBe(true)
  expect(
    history.operations.some((item) => item.record?.kind === 'fix-owner' && item.record.payload.phase === 'settled'),
  ).toBe(false)
  const before = readSim(box)
  const recovery = spawnSync(
    bun,
    [worker, 'recover', cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} })],
    { cwd, env, encoding: 'utf8', timeout: 90_000 },
  )
  expect(recovery.status, `${recovery.stderr}\n${recovery.stdout}`).toBe(0)
  const result = recovery.stdout
    .trim()
    .split('\n')
    .findLast((item) => item.startsWith('{"mode"'))
  expect(result).toBeDefined()
  if (result === undefined) throw new Error('fixture-recovery-output-missing')
  const refused = JSON.parse(result)
  expect(refused.called).toBe(true)
  expect(refused.approvals).toBe(0)
  expect(refused.confirmationCount).toBe(0)
  expect(refused.nativeDispatches).toEqual([])
  expect(refused.children).toEqual([])
  expect(JSON.stringify(refused.messages)).toContain('fix-owner-admission-refused')
  const after = readSim(box)
  expect(after.issues['42']?.comments).toEqual(before.issues['42']?.comments)
  expect(after.prs['7']?.comments).toEqual(before.prs['7']?.comments)
}, 240_000)

it('refuses a confirmed recovery proposal if Git HEAD changes during the real operator dialog', () => {
  const { box, cwd } = arrangeReviewFixture()
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
  const input = JSON.stringify({ ...box, env: {} })
  const seed = spawnSync(bun, [seedWorker, 'seed', cwd, box.root, box.stateFile, input], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  expect(seed.status, `${seed.stderr}\n${seed.stdout}`).toBe(0)
  const old = spawnSync(bun, [seedWorker, 'old', cwd, box.root, box.stateFile, input], {
    cwd,
    env: {
      ...env,
      FIX_RECOVERY_FAULT_KIND: 'fix-request',
      FIX_RECOVERY_FAULT_BEFORE: '1',
      FIX_RECOVERY_FAULT_MARKER: join(box.root, 'stale-request'),
      FIX_RECOVERY_FAULT_RELEASE: join(box.root, 'release-stale-request'),
    },
    encoding: 'utf8',
    timeout: 120_000,
  })
  expect(old.status, `${old.stderr}\n${old.stdout}`).toBe(0)
  const settlement = featureMandate(box).history.operations.find(
    (item) =>
      item.status === 'complete' && item.record?.kind === 'fix-owner' && item.record.payload.phase === 'settled',
  )?.record
  expect(settlement?.payload).toMatchObject({ admissionSealed: true, witness: { kind: 'sealed-no-entry' } })
  const before = readSim(box)
  const recovery = spawnSync(bun, [worker, 'stale-confirmation', cwd, box.root, box.stateFile, input], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  expect(recovery.status, `${recovery.stderr}\n${recovery.stdout}`).toBe(0)
  const line = recovery.stdout
    .trim()
    .split('\n')
    .findLast((item) => item.startsWith('{"mode"'))
  expect(line).toBeDefined()
  if (line === undefined) throw new Error('fixture-recovery-output-missing')
  const refused = JSON.parse(line)
  expect(refused.called).toBe(true)
  expect(refused.confirmationCount).toBe(1)
  expect(refused.headBefore).toBe(readSim(box).prs['7']?.headRefOid)
  expect(refused.headAfter).not.toBe(refused.headBefore)
  expect(JSON.stringify(refused.messages)).toContain('fix-publish-local-head-mismatch')
  expect(refused.nativeDispatches).toEqual([])
  expect(refused.children).toEqual([])
  const after = readSim(box)
  expect(after.issues['42']?.comments).toEqual(before.issues['42']?.comments)
  expect(after.prs['7']?.comments).toEqual(before.prs['7']?.comments)
}, 300_000)

it('holds public recovery while an actual originating native intake child is running', async () => {
  const { box, cwd } = arrangeReviewFixture()
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
  const seed = spawnSync(bun, [seedWorker, 'seed', cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} })], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  expect(seed.status, `${seed.stderr}\n${seed.stdout}`).toBe(0)

  const ready = join(box.root, 'active-child-ready')
  const release = join(box.root, 'release-active-child')
  const origin = spawn(bun, [worker, 'origin', cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} })], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000,
  })
  let stdout = '',
    stderr = ''
  origin.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  origin.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    origin.once('error', reject)
    origin.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  try {
    const end = Date.now() + 90_000
    while (!existsSync(ready) && origin.exitCode === null && Date.now() < end) await delay(25)
    expect(existsSync(ready), `origin did not enter native intake: ${stderr}\n${stdout}`).toBe(true)
    const entered = JSON.parse(readFileSync(ready, 'utf8'))
    expect(entered).toMatchObject({ called: true, leaseHeld: true })
    expect(entered.nativeDispatches).toContain('held-native')
    expect(entered.children.length).toBeGreaterThan(0)
    expect(readFileSync(join(box.root, 'active-child-probe'), 'utf8')).toContain('save')

    const history = featureMandate(box).history
    expect(
      history.operations.some(
        (item) =>
          item.status === 'complete' && item.record?.kind === 'fix-owner' && item.record.payload.phase === 'opened',
      ),
    ).toBe(true)
    expect(
      history.operations.some((item) => item.record?.kind === 'fix-owner' && item.record.payload.phase === 'settled'),
    ).toBe(false)
    const before = readSim(box)
    const recovery = spawnSync(
      bun,
      [worker, 'recover', cwd, box.root, box.stateFile, JSON.stringify({ ...box, env: {} })],
      { cwd, env, encoding: 'utf8', timeout: 90_000 },
    )
    expect(recovery.status, `${recovery.stderr}\n${recovery.stdout}`).toBe(0)
    const line = recovery.stdout
      .trim()
      .split('\n')
      .findLast((item) => item.startsWith('{"mode"'))
    expect(line, `${recovery.stderr}\n${recovery.stdout}`).toBeDefined()
    if (line === undefined) throw new Error('fixture-recovery-output-missing')
    const refused = JSON.parse(line)
    expect(refused.called).toBe(true)
    expect(refused.approvals).toBe(0)
    expect(refused.confirmationCount).toBe(0)
    expect(refused.nativeDispatches).toEqual([])
    expect(refused.children).toEqual([])
    expect(JSON.stringify(refused.messages)).toContain('fix-owner-admission-refused')
    const after = readSim(box)
    expect(after.issues['42']?.comments).toEqual(before.issues['42']?.comments)
    expect(after.prs['7']?.comments).toEqual(before.prs['7']?.comments)
  } finally {
    writeFileSync(release, 'release\n')
    const result = await exited
    expect(result, `${stderr}\n${stdout}`).toEqual({ code: 0, signal: null })
  }
}, 360_000)
