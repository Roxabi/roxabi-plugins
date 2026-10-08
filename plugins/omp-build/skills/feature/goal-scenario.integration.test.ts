import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readMarker } from './epic'

/**
 * One continuous /goal through the real driver CLI and the real workflow.js
 * sinks, against a stateful fake `gh` (#654). Existing suites are not rewritten.
 */

const DRIVER = path.resolve(import.meta.dirname, 'epic-driver.ts')
const SIM = path.resolve(import.meta.dirname, 'gh-simulator.ts')
const WORKFLOW = path.resolve(import.meta.dirname, 'goal-scenario-workflow.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const RUN_A = 'run000a1'
const RUN_B = 'run000b2'
const EPIC = 1
const A = 2
const B = 3
const C = 4
const BRANCH_A = 'feat/2-child-a'
const BRANCH_B = 'feat/3-child-b'
const BRANCH_C = 'feat/4-child-c'

type DriverNext = {
  step: {
    action: string
    ticket?: number
    branch?: string
    range?: string
    stop?: string
    stage?: string
    report?: {
      stopped: { ticket: number; reason: string; sticky: boolean }[]
      skipped: { ticket: number; blockers: number[] }[]
    }
  }
  reconciled: { ticket: number; pr: number; disarmed: string }[]
  cleaned: string[]
}

type Comment = { author: string; body: string }
type Pull = {
  number: number
  state: string
  headRefName: string
  headRefOid: string
  labels: string[]
  autoMerge: unknown
  mergeCommit: { oid: string; parents: string[] } | null
  closes: number[]
}
type Issue = { number: number; state: string; comments: Comment[]; subIssues: number[] }
type SimState = {
  issues: Record<string, Issue>
  prs: Record<string, Pull>
  checks: Record<
    string,
    { name: string; status: string; conclusion: string; workflowName: string; startedAt: string }[]
  >
  calls: string[][]
  failedRuns?: Record<string, { databaseId: number; conclusion: string; log: string }[]>
}

type Box = { root: string; origin: string; epic: string; stateFile: string; env: NodeJS.ProcessEnv }

let box: Box | undefined
afterEach(() => {
  if (box) rmSync(box.root, { recursive: true, force: true })
  box = undefined
})

function git(cwd: string, args: string[]): string {
  if (!box) throw new Error('no sandbox')
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  }).trim()
}

function readSim(): SimState {
  if (!box) throw new Error('no sandbox')
  return JSON.parse(readFileSync(box.stateFile, 'utf8')) as SimState
}

function writeSim(mutate: (state: SimState) => void): void {
  if (!box) throw new Error('no sandbox')
  const state = readSim()
  mutate(state)
  writeFileSync(box.stateFile, JSON.stringify(state, null, 2))
}

function gh(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  if (!box) throw new Error('no sandbox')
  const out = spawnSync(path.join(box.root, 'bin', 'gh'), args, {
    cwd: box.epic,
    env: box.env,
    encoding: 'utf8',
    input,
  })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

function callWorkflow<T>(fn: string, cwd: string, payload: object): T {
  if (!box) throw new Error('no sandbox')
  const out = spawnSync(REAL_BUN, [WORKFLOW, fn, cwd, JSON.stringify(payload)], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (out.status !== 0) throw new Error(`${fn} failed (${out.status}): ${out.stderr}\n${out.stdout}`)
  return JSON.parse(out.stdout) as T
}

function objective(run: string): string {
  return `Deliver epic #${EPIC} (/feature #${EPIC} run=${run} base=main).`
}

function drive(args: string[], run: string, cwd = box?.epic): { code: number | null; stdout: string; stderr: string } {
  if (!box || !cwd) throw new Error('no sandbox')
  const file = path.join(box.root, `objective-${run}.txt`)
  writeFileSync(file, objective(run))
  const out = spawnSync(
    REAL_BUN,
    [DRIVER, ...args, '--epic', String(EPIC), '--goal-status', 'active', '--goal-objective-file', file],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
    },
  )
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}

function jsonOf(run: { code: number | null; stdout: string; stderr: string }): DriverNext {
  if (run.code !== 0) throw new Error(`driver ${run.code}: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as DriverNext
}

function child(number: number, title: string, blockedBy: number[] = []) {
  return {
    number,
    title,
    body: '## Acceptance criteria\n\n- [ ] lands\n',
    state: 'OPEN' as const,
    author: 'operator',
    labels: ['size:F-lite'],
    comments: [] as Comment[],
    subIssues: [] as number[],
    blockedBy,
  }
}

const FEATURE_DIR = path.resolve(import.meta.dirname)
const CI_WATCH = path.resolve(FEATURE_DIR, '../ci-watch/ci-watch.sh')
const LOG_SENTINEL = 'failed-job-stdout sentinel run-9001'
const FAIL_LOG = `job log for databaseId 9001\n${LOG_SENTINEL}\ncheck output stays on stdout\n`
const DEFAULT_STACK = [
  'landing:',
  '  mode: native',
  '  required_checks:',
  '    - ci',
  'release:',
  '  model: trunk',
  '  post_merge:',
  '    - ./scripts/post-merge.sh',
  '',
].join('\n')

function sandbox(stack = DEFAULT_STACK): Box {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-goal-scenario-')))
  const origin = path.join(root, 'origin.git')
  const principal = path.join(root, 'principal')
  const epic = path.join(root, 'epic')
  const bin = path.join(root, 'bin')
  const stateFile = path.join(root, 'gh-state.json')
  mkdirSync(bin)
  symlinkSync(SIM, path.join(bin, 'gh'))
  chmodSync(SIM, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    GH_SIM_STATE: stateFile,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key]
  }
  box = { root, origin, epic, stateFile, env }
  git(root, ['init', '-q', '-b', 'main', principal])
  git(root, ['init', '-q', '--bare', origin])
  mkdirSync(path.join(principal, '.dev'), { recursive: true })
  mkdirSync(path.join(principal, 'scripts'), { recursive: true })
  writeFileSync(path.join(principal, '.dev', 'stack.yml'), stack)
  writeFileSync(path.join(principal, 'scripts', 'post-merge.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(path.join(principal, 'scripts', 'post-merge.sh'), 0o755)
  writeFileSync(path.join(principal, 'README.md'), 'base\n')
  git(principal, ['add', '.'])
  git(principal, ['commit', '-qm', 'chore: base'])
  git(principal, ['remote', 'add', 'origin', origin])
  git(principal, ['push', '-q', '-u', 'origin', 'main'])
  git(principal, ['worktree', 'add', '-q', '--detach', epic, 'refs/remotes/origin/main'])
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        viewer: 'operator',
        owner: 'acme',
        name: 'app',
        defaultBranch: 'main',
        origin,
        requiredChecks: ['ci'],
        nextPr: 10,
        clock: 0,
        issues: {
          1: {
            number: 1,
            title: 'epic: goal',
            body: '## Acceptance criteria\n\n- [ ] delivered\n',
            state: 'OPEN',
            author: 'operator',
            labels: ['epic', 'size:F-lite'],
            comments: [],
            subIssues: [A, B, C],
            blockedBy: [],
          },
          2: child(A, 'feat(a): child a'),
          3: child(B, 'feat(b): child b', [A]),
          4: child(C, 'feat(c): child c'),
        },
        prs: {},
        checks: {},
        events: {},
        calls: [],
      },
      null,
      2,
    ),
  )
  return box
}

function commitAndPush(branch: string, message: string, file: string): string {
  if (!box) throw new Error('no sandbox')
  writeFileSync(path.join(box.epic, file), `${message}\n`)
  git(box.epic, ['add', file])
  git(box.epic, ['commit', '-qm', message])
  git(box.epic, ['push', '-q', '-u', 'origin', branch])
  return git(box.epic, ['rev-parse', 'HEAD'])
}

function markGreen(sha: string): void {
  writeSim((state) => {
    state.checks[sha] = [
      {
        name: 'ci',
        status: 'completed',
        conclusion: 'success',
        workflowName: 'ci',
        startedAt: '2026-01-01T00:00:00Z',
      },
    ]
  })
}

function reviewRecord(sha: string): string {
  return [
    '<!-- omp-build:code-review -->',
    `<!-- omp-build:review-head sha=${sha} -->`,
    '## Code Review',
    '',
    '**Verdict: Approve (clean)**',
    '',
  ].join('\n')
}

/** The column-0 javascript fence under feature `#### Completed watch`, verbatim. */
function completedWatchFence(): string {
  const text = readFileSync(path.join(FEATURE_DIR, 'SKILL.md'), 'utf8')
  const heading = text.indexOf('\n#### Completed watch\n')
  const open = text.indexOf('```javascript\n', heading)
  const close = text.indexOf('\n```', open)
  if (heading === -1 || open === -1 || close === -1) throw new Error('feature §6.7 has no completed-watch fence')
  return text.slice(open + '```javascript\n'.length, close)
}

function failCheck(sha: string, name: string, log = FAIL_LOG): void {
  writeSim((state) => {
    state.checks[sha] = [
      {
        name,
        status: 'completed',
        conclusion: 'failure',
        workflowName: name,
        startedAt: '2026-01-01T00:00:00Z',
      },
    ]
    state.failedRuns = {
      ...(state.failedRuns ?? {}),
      [sha]: [{ databaseId: 9001, conclusion: 'failure', log }],
    }
  })
}

function goalStopArgv(run: string, ticket: number): string[] {
  if (!box) throw new Error('no sandbox')
  const file = path.join(box.root, `objective-${run}.txt`)
  writeFileSync(file, objective(run))
  return [
    DRIVER,
    'stop',
    '--repo',
    box.epic,
    '--epic',
    String(EPIC),
    '--goal-status',
    'active',
    '--goal-objective-file',
    file,
    '--ticket',
    String(ticket),
  ]
}

function watchPr(pr: number, command?: string): { status: number; stdout: string; stderr: string } {
  if (!box) throw new Error('no sandbox')
  const ran = command
    ? spawnSync('bash', ['-lc', command], { cwd: box.epic, env: box.env, encoding: 'utf8' })
    : spawnSync('bash', [CI_WATCH, String(pr), '--merge-mode', 'native', '--base', 'main', '--timeout', '5'], {
        cwd: box.epic,
        env: box.env,
        encoding: 'utf8',
      })
  return { status: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr }
}

function runCompletedWatch(input: {
  pr: number
  watchExit: number
  watchStdout: string
  watchStderr: string
  mode: string
  goalStopArgv?: string[]
}): { status: number | null; stdout: string; stderr: string; outcome: Record<string, unknown>; detail: string } {
  if (!box) throw new Error('no sandbox')
  const detailDir = mkdtempSync(path.join(tmpdir(), 'omp-ci-detail-'))
  const detailFile = path.join(detailDir, 'detail.txt')
  const resultFile = path.join(box.root, 'fence-result.json')
  const script = path.join(box.root, 'completed-watch.mjs')
  writeFileSync(
    script,
    [
      `import { writeFileSync as writeResult } from 'node:fs'`,
      `const FEATURE_DIR = ${JSON.stringify(FEATURE_DIR)}`,
      `const cwd = ${JSON.stringify(box.epic)}`,
      `const pr = ${input.pr}`,
      `const watchExit = ${input.watchExit}`,
      `const watchStdout = ${JSON.stringify(input.watchStdout)}`,
      `const watchStderr = ${JSON.stringify(input.watchStderr)}`,
      `const mode = ${JSON.stringify(input.mode)}`,
      `const detailFile = ${JSON.stringify(detailFile)}`,
      `const goalStopArgv = ${input.goalStopArgv === undefined ? 'undefined' : JSON.stringify(input.goalStopArgv)}`,
      'const outcome = await (async () => {',
      completedWatchFence(),
      '})()',
      `writeResult(${JSON.stringify(resultFile)}, JSON.stringify(outcome ?? null))`,
    ].join('\n'),
  )
  const ran = spawnSync(REAL_BUN, [script], { cwd: box.epic, env: box.env, encoding: 'utf8' })
  if (ran.status !== 0) {
    throw new Error(`completed-watch fence failed (${ran.status}): ${ran.stderr}\n${ran.stdout}`)
  }
  return {
    status: ran.status,
    stdout: ran.stdout,
    stderr: ran.stderr,
    outcome: JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, unknown>,
    detail: existsSync(detailFile) ? readFileSync(detailFile, 'utf8') : '',
  }
}

function openApproved(run = RUN_A): { number: number; sha: string } {
  if (!box) throw new Error('no sandbox')
  const started = jsonOf(drive(['next'], run))
  expect(started.step).toMatchObject({ action: 'start', ticket: A, branch: BRANCH_A })
  const sha = commitAndPush(BRANCH_A, 'feat(a): land child (#2)', 'a.txt')
  const opened = callWorkflow<{ number: number; status: string }>('openPr', box.epic, {
    issue: A,
    branch: BRANCH_A,
    base: 'main',
    title: 'feat(a): child a',
  })
  expect(opened.status).toBe('created')
  approve(opened.number, sha)
  return { number: opened.number, sha }
}

function approve(pr: number, sha: string): void {
  const review = gh(['pr', 'comment', String(pr), '--body', reviewRecord(sha)])
  if (review.status !== 0) throw new Error(`approve #${pr}: ${review.stderr}`)
}

function prOf(head: string): Pull {
  const pr = Object.values(readSim().prs).find((item) => item.headRefName === head)
  if (!pr) throw new Error(`no PR for ${head}`)
  return pr
}

function assertStoppedDisarmed(): void {
  const stopped = readSim().prs
  const armed = Object.values(stopped).filter(
    (pr) =>
      pr.headRefName === BRANCH_C && pr.state === 'OPEN' && (pr.labels.includes('reviewed') || pr.autoMerge !== null),
  )
  expect(armed).toEqual([])
}

describe('stateful gh — one continuous goal', () => {
  it('lands, crashes, merges, stops, and completes without an armed stopped PR', () => {
    const { epic } = sandbox()

    const started = jsonOf(drive(['next'], RUN_A))
    expect(started.step).toMatchObject({ action: 'start', ticket: A, branch: BRANCH_A })
    expect(git(epic, ['branch', '--show-current'])).toBe(BRANCH_A)

    const shaA = commitAndPush(BRANCH_A, 'feat(a): land child (#2)', 'a.txt')
    const openedA = callWorkflow<{ number: number; status: string }>('openPr', epic, {
      issue: A,
      branch: BRANCH_A,
      base: 'main',
      title: 'feat(a): child a',
    })
    expect(openedA.status).toBe('created')
    approve(openedA.number, shaA)

    const wrong = 'a'.repeat(40)
    const pin = gh(['pr', 'merge', String(openedA.number), '--auto', '--merge', '--match-head-commit', wrong])
    expect(pin.status).not.toBe(0)
    expect(pin.stderr).toContain(wrong)
    expect(prOf(BRANCH_A).autoMerge).toBeNull()
    expect(prOf(BRANCH_A).state).toBe('OPEN')
    const pinned = gh(['pr', 'merge', String(openedA.number), '--auto', '--merge', '--match-head-commit', shaA])
    expect(pinned.status).toBe(0)
    const moved = commitAndPush(BRANCH_A, 'feat(a): move head (#2)', 'a-moved.txt')
    const refused = callWorkflow<{ status: string; reason?: string }>('landPr', epic, {
      pr: openedA.number,
    })
    expect(refused).toMatchObject({ status: 'not-approved', reason: 'head-moved' })
    expect(prOf(BRANCH_A).labels).not.toContain('reviewed')

    markGreen(moved)
    if (!box) throw new Error('no sandbox')
    const originBefore = git(box.origin, ['rev-parse', 'refs/heads/main'])
    const viewed = gh(['pr', 'view', String(openedA.number), '--json', 'state'])
    expect(JSON.parse(viewed.stdout).state).toBe('OPEN')
    expect(git(box.origin, ['rev-parse', 'refs/heads/main'])).toBe(originBefore)
    expect(gh(['pr', 'merge', String(openedA.number), '--disable-auto']).status).toBe(0)
    git(box.epic, ['reset', '--hard', shaA])
    git(box.epic, ['push', '--force', '-q', 'origin', BRANCH_A])

    const landed = callWorkflow<{ status: string; mode?: string; watch?: string }>('landPr', epic, {
      pr: openedA.number,
    })
    expect(landed).toMatchObject({ status: 'watching', mode: 'native' })
    expect(landed.watch).toContain('ci-watch.sh')
    expect(prOf(BRANCH_A).state).toBe('OPEN')
    expect(prOf(BRANCH_A).labels).toContain('reviewed')
    expect(prOf(BRANCH_A).autoMerge).not.toBeNull()
    writeSim((state) => {
      state.checks[shaA] = [
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:00:00Z',
        },
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:01:00Z',
        },
      ]
    })
    const red = gh(['pr', 'view', String(openedA.number), '--json', 'state'])
    expect(JSON.parse(red.stdout).state).toBe('OPEN')
    writeSim((state) => {
      state.checks[shaA] = [
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'other',
          startedAt: '2026-01-01T00:02:00Z',
        },
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:03:00Z',
        },
      ]
    })
    const otherRed = gh(['pr', 'view', String(openedA.number), '--json', 'state'])
    expect(JSON.parse(otherRed.stdout).state).toBe('OPEN')
    writeSim((state) => {
      state.checks[shaA] = [
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:05:00Z',
        },
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:04:00Z',
        },
      ]
    })
    const older = gh(['pr', 'view', String(openedA.number), '--json', 'state'])
    expect(JSON.parse(older.stdout).state).toBe('OPEN')
    writeSim((state) => {
      state.checks[shaA] = [
        {
          name: 'ci',
          status: 'in_progress',
          conclusion: '',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:06:00Z',
        },
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:07:00Z',
        },
      ]
    })
    const pending = gh(['pr', 'view', String(openedA.number), '--json', 'state'])
    expect(JSON.parse(pending.stdout).state).toBe('OPEN')

    writeSim((state) => {
      delete state.checks[shaA]
    })

    git(epic, ['switch', '-q', '-c', BRANCH_C])
    const shaC = commitAndPush(BRANCH_C, 'feat(c): abandoned (#4)', 'c.txt')
    const openedC = callWorkflow<{ number: number; status: string }>('openPr', epic, {
      issue: C,
      branch: BRANCH_C,
      base: 'main',
      title: 'feat(c): child c',
    })
    markGreen(shaC)
    if (!box) throw new Error('no sandbox')
    const originUnarmed = git(box.origin, ['rev-parse', 'refs/heads/main'])
    const unarmed = gh(['pr', 'view', String(openedC.number), '--json', 'state'])
    expect(JSON.parse(unarmed.stdout).state).toBe('OPEN')
    expect(git(box.origin, ['rev-parse', 'refs/heads/main'])).toBe(originUnarmed)
    writeSim((state) => {
      delete state.checks[shaC]
    })

    expect(gh(['pr', 'edit', String(openedC.number), '--add-label', 'reviewed']).status).toBe(0)
    git(epic, ['switch', '-q', BRANCH_A])
    const stopped = drive(['stop', '--ticket', String(C), '--reason', 'review-bound'], RUN_A)
    expect(stopped.code).toBe(0)
    expect(gh(['pr', 'edit', String(openedC.number), '--add-label', 'reviewed']).status).toBe(0)
    expect(prOf(BRANCH_C).labels).toContain('reviewed')

    const unknown = gh(['pr', 'diff', '1'])
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr).toContain('pr diff 1')

    const otherEpic = gh([
      'api',
      'graphql',
      '-f',
      'query=query($owner: String!, $name: String!, $epic: Int!) { repository(owner: $owner, name: $name) { issue(number: $epic) { subIssues(first: 1) { nodes { number } } } } }',
      '-f',
      'owner=acme',
      '-f',
      'name=app',
      '-F',
      'epic=999',
    ])
    expect(otherEpic.status).toBe(0)
    expect(JSON.parse(otherEpic.stdout).data.repository.issue).toBeNull()

    markGreen(shaA)
    const resumed = jsonOf(drive(['next'], RUN_B))
    expect(resumed.reconciled).toEqual([{ ticket: C, pr: openedC.number, disarmed: 'disarmed' }])
    assertStoppedDisarmed()
    expect(resumed.step).toMatchObject({ action: 'start', ticket: B, branch: BRANCH_B })
    const mergedA = prOf(BRANCH_A)
    expect(mergedA.state).toBe('MERGED')
    expect(mergedA.mergeCommit?.parents).toHaveLength(2)
    if (!box) throw new Error('no sandbox')
    const originMain = git(box.origin, ['rev-parse', 'refs/heads/main'])
    expect(originMain).toBe(mergedA.mergeCommit?.oid)
    expect(git(box.origin, ['rev-parse', `${originMain}^2`])).toBe(shaA)

    const rollupA = gh([
      'api',
      'graphql',
      '-f',
      'query=query($owner: String!, $name: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit { statusCheckRollup { contexts(first: 1) { nodes { name } } } } } } }',
      '-f',
      'owner=acme',
      '-f',
      'name=app',
      '-f',
      `sha=${shaA}`,
    ])
    const rollupMissing = gh([
      'api',
      'graphql',
      '-f',
      'query=query($owner: String!, $name: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit { statusCheckRollup { contexts(first: 1) { nodes { name } } } } } } }',
      '-f',
      'owner=acme',
      '-f',
      'name=app',
      '-f',
      `sha=${'b'.repeat(40)}`,
    ])
    expect(JSON.parse(rollupA.stdout).data.repository.object.statusCheckRollup.contexts.nodes[0].name).toBe('ci')
    expect(JSON.parse(rollupMissing.stdout).data.repository.object.statusCheckRollup.contexts.nodes).toEqual([])

    const shaB = commitAndPush(BRANCH_B, 'feat(b): land child (#3)', 'b.txt')
    markGreen(shaB)
    const openedB = callWorkflow<{ number: number; status: string }>('openPr', epic, {
      issue: B,
      branch: BRANCH_B,
      base: 'main',
      title: 'feat(b): child b',
    })
    approve(openedB.number, shaB)
    const landedB = callWorkflow<{ status: string; mode?: string; watch?: string }>('landPr', epic, {
      pr: openedB.number,
    })
    expect(landedB.status).toBe('watching')
    if (!landedB.watch) throw new Error('landPr returned no watch')
    const watched = spawnSync('bash', ['-lc', landedB.watch], { cwd: epic, env: box?.env, encoding: 'utf8' })
    expect(watched.status).toBe(0)
    const applied = callWorkflow<{ status: string }>('applyCiWatchExit', epic, {
      pr: openedB.number,
      code: watched.status ?? 1,
      mode: landedB.mode,
    })
    expect(applied.status).toBe('merged')
    expect(prOf(BRANCH_B).state).toBe('MERGED')
    expect(prOf(BRANCH_B).mergeCommit?.parents[1]).toBe(shaB)

    writeSim((state) => {
      const issue = state.issues[String(C)]
      if (issue) issue.state = 'CLOSED'
    })
    const afterStop = jsonOf(drive(['next'], RUN_B))
    assertStoppedDisarmed()
    expect(afterStop.step.action).toBe('final-review')
    expect(afterStop.step.stage).toBe('review')
    const range = afterStop.step.range ?? ''
    expect(range).toMatch(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/)

    const reviewed = drive(['review', '--verdict', 'clean', '--range', range], RUN_B)
    expect(reviewed.code).toBe(0)
    writeFileSync(path.join(epic, 'dirty.txt'), 'no\n')
    const dirty = jsonOf(drive(['next'], RUN_B))
    expect(dirty.step).toMatchObject({ action: 'drop', stop: 'dirty-tree' })
    assertStoppedDisarmed()
    rmSync(path.join(epic, 'dirty.txt'))
    const hookStep = jsonOf(drive(['next'], RUN_B))
    expect(hookStep.step.action).toBe('post-merge')
    assertStoppedDisarmed()

    const hooked = drive(['hook', '--repo', epic], RUN_B, box?.root)
    expect(hooked.code).toBe(0)
    const hookSha = git(epic, ['rev-parse', 'refs/remotes/origin/main'])
    expect(hooked.stdout).toContain(hookSha)

    const done = jsonOf(drive(['next'], RUN_B))
    assertStoppedDisarmed()
    expect(done.step.action).toBe('complete')
    const reported = drive(['report', '--outcome', 'complete'], RUN_B)
    expect(reported.code).toBe(0)
    const report = readSim().issues[String(EPIC)]?.comments.find(
      (comment) => readMarker(comment.body, 'goal-report')?.run === RUN_B,
    )
    expect(report).toBeTruthy()
    expect(readMarker(report?.body ?? '', 'goal-report')).toEqual({ run: RUN_B })
    expect(report?.body).toContain(`#${A}`)
    expect(report?.body).toContain(`#${B}`)
    expect(report?.body).toContain(`#${C}`)
    expect(report?.body).toContain(hookSha)
    const stop = readSim().issues[String(C)]?.comments.find((comment) => readMarker(comment.body, 'goal-stop'))
    expect(readMarker(stop?.body ?? '', 'goal-stop')).toEqual({ run: RUN_A, reason: 'review-bound' })
    expect(readSim().prs[String(openedA.number)]?.state).toBe('MERGED')
    expect(readSim().prs[String(openedB.number)]?.state).toBe('MERGED')
  })
})

describe('completed watch — ci-failed stops through the skill fence', () => {
  it('stops a required-check failure, keeps both streams, and advances the independent child', () => {
    const { epic } = sandbox()
    const opened = openApproved()
    const landed = callWorkflow<{ status: string; mode?: string; watch?: string }>('landPr', epic, {
      pr: opened.number,
    })
    expect(landed).toMatchObject({ status: 'watching', mode: 'native' })
    if (!landed.watch) throw new Error('landPr returned no watch')
    failCheck(opened.sha, 'ci')
    const watched = watchPr(opened.number, landed.watch)
    expect(watched.status).toBe(1)
    expect(watched.stdout).toContain(LOG_SENTINEL)
    expect(watched.stderr).toContain('ci=failure')
    expect(watched.stdout).not.toContain('ci=failure')

    const fenced = runCompletedWatch({
      pr: opened.number,
      watchExit: watched.status,
      watchStdout: watched.stdout,
      watchStderr: watched.stderr,
      mode: landed.mode ?? 'native',
      goalStopArgv: goalStopArgv(RUN_A, A),
    })
    expect(fenced.stdout).toContain(LOG_SENTINEL)
    expect(fenced.stderr).toContain('ci=failure')
    expect(fenced.detail).toContain(LOG_SENTINEL)
    expect(fenced.detail).toContain('ci=failure')
    expect(fenced.outcome).toMatchObject({ status: 'ci-failed', stop: 'ci-failed' })
    expect(String(fenced.outcome.receipt)).toContain('"sticky": false')
    const marker = readSim().issues[String(A)]?.comments.find((comment) => readMarker(comment.body, 'goal-stop'))
    expect(readMarker(marker?.body ?? '', 'goal-stop')).toEqual({ run: RUN_A, reason: 'ci-failed' })
    expect(marker?.body).toContain(LOG_SENTINEL)
    expect(marker?.body).toContain('ci=failure')
    expect(readSim().prs[String(opened.number)]?.state).toBe('OPEN')
    expect(Object.keys(readSim().prs)).toEqual([String(opened.number)])

    const next = jsonOf(drive(['next'], RUN_A))
    expect(next.step).toMatchObject({ action: 'start', ticket: C })
    expect(next.step.report?.stopped).toEqual([{ ticket: A, reason: 'ci-failed', sticky: false }])
    expect(next.step.report?.skipped).toEqual([{ ticket: B, blockers: [A] }])
  })

  it('retries a ci-failed ticket in a later run and stops again when the check fails again', () => {
    sandbox()
    const opened = openApproved()
    failCheck(opened.sha, 'ci')
    const firstWatch = watchPr(opened.number)
    expect(firstWatch.status).toBe(1)
    expect(firstWatch.stdout).toContain(LOG_SENTINEL)
    const first = runCompletedWatch({
      pr: opened.number,
      watchExit: firstWatch.status,
      watchStdout: firstWatch.stdout,
      watchStderr: firstWatch.stderr,
      mode: 'native',
      goalStopArgv: goalStopArgv(RUN_A, A),
    })
    expect(first.outcome).toMatchObject({ stop: 'ci-failed' })

    const retried = jsonOf(drive(['next'], RUN_B))
    expect(retried.step.ticket).toBe(A)
    expect(['start', 'resume']).toContain(retried.step.action)

    const again = watchPr(opened.number)
    expect(again.status).toBe(1)
    expect(again.stdout).toContain(LOG_SENTINEL)
    expect(again.stderr).toContain('ci=failure')
    const second = runCompletedWatch({
      pr: opened.number,
      watchExit: again.status,
      watchStdout: again.stdout,
      watchStderr: again.stderr,
      mode: 'native',
      goalStopArgv: goalStopArgv(RUN_B, A),
    })
    expect(second.outcome).toMatchObject({ status: 'ci-failed', stop: 'ci-failed' })
    expect(String(second.outcome.receipt)).toContain('"sticky": false')
    const after = jsonOf(drive(['next'], RUN_B))
    expect(after.step.ticket).not.toBe(A)
    expect(after.step.report?.stopped).toContainEqual({ ticket: A, reason: 'ci-failed', sticky: false })
  })

  it('stops an optional-check failure from the real watcher without arming an empty required list', () => {
    const { epic } = sandbox(
      ['landing:', '  mode: native', '  required_checks: []', 'release:', '  model: trunk', ''].join('\n'),
    )
    const opened = openApproved()
    const refused = callWorkflow<{ status: string }>('landPr', epic, { pr: opened.number })
    expect(refused.status).toBe('no-required-checks')
    failCheck(opened.sha, 'lint')
    const watched = watchPr(opened.number)
    expect(watched.status).toBe(1)
    expect(watched.stdout).toContain(LOG_SENTINEL)
    expect(watched.stderr).toContain('lint=failure')
    const fenced = runCompletedWatch({
      pr: opened.number,
      watchExit: watched.status,
      watchStdout: watched.stdout,
      watchStderr: watched.stderr,
      mode: 'native',
      goalStopArgv: goalStopArgv(RUN_A, A),
    })
    expect(fenced.detail).toContain(LOG_SENTINEL)
    expect(fenced.detail).toContain('lint=failure')
    expect(fenced.outcome).toMatchObject({ status: 'ci-failed', stop: 'ci-failed' })
    const marker = readSim().issues[String(A)]?.comments.find((comment) => readMarker(comment.body, 'goal-stop'))
    expect(readMarker(marker?.body ?? '', 'goal-stop')).toEqual({ run: RUN_A, reason: 'ci-failed' })
    expect(readSim().prs[String(opened.number)]?.state).toBe('OPEN')
  })

  it('displays both streams outside a goal and does not call the driver', () => {
    const { epic } = sandbox()
    const opened = openApproved()
    failCheck(opened.sha, 'ci')
    const watched = watchPr(opened.number)
    expect(watched.status).toBe(1)
    const head = git(epic, ['rev-parse', 'HEAD'])
    const fenced = runCompletedWatch({
      pr: opened.number,
      watchExit: watched.status,
      watchStdout: watched.stdout,
      watchStderr: watched.stderr,
      mode: 'native',
    })
    expect(fenced.stdout).toContain(LOG_SENTINEL)
    expect(fenced.stderr).toContain('ci=failure')
    expect(fenced.detail).toContain(LOG_SENTINEL)
    expect(fenced.detail).toContain('ci=failure')
    expect(fenced.outcome).toMatchObject({ status: 'ci-failed' })
    expect(fenced.outcome).not.toHaveProperty('stop')
    expect(fenced.outcome).not.toHaveProperty('receipt')
    expect(readSim().issues[String(A)]?.comments.some((comment) => readMarker(comment.body, 'goal-stop'))).toBe(false)
    expect(git(epic, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(epic, ['status', '--porcelain'])).toBe('')
  })

  it('still stops when the diagnostics are empty or unparseable', () => {
    sandbox()
    const opened = openApproved()
    const empty = runCompletedWatch({
      pr: opened.number,
      watchExit: 1,
      watchStdout: '',
      watchStderr: '',
      mode: 'native',
      goalStopArgv: goalStopArgv(RUN_A, A),
    })
    expect(empty.outcome).toMatchObject({ status: 'ci-failed', stop: 'ci-failed' })
    const emptyMarker = readSim().issues[String(A)]?.comments.find((comment) => readMarker(comment.body, 'goal-stop'))
    expect(readMarker(emptyMarker?.body ?? '', 'goal-stop')).toEqual({ run: RUN_A, reason: 'ci-failed' })

    const garbageOut = 'not-a-log {'
    const garbageErr = '<<<unparseable diagnostic>>>'
    const garbage = runCompletedWatch({
      pr: opened.number,
      watchExit: 1,
      watchStdout: garbageOut,
      watchStderr: garbageErr,
      mode: 'native',
      goalStopArgv: goalStopArgv(RUN_B, A),
    })
    expect(garbage.outcome).toMatchObject({ status: 'ci-failed', stop: 'ci-failed' })
    expect(garbage.detail).toBe(garbageOut + garbageErr)
    const later = readSim().issues[String(A)]?.comments.filter(
      (comment) => readMarker(comment.body, 'goal-stop')?.run === RUN_B,
    )
    expect(later).toHaveLength(1)
    expect(later?.[0]?.body).toContain(garbageOut)
    expect(later?.[0]?.body).toContain(garbageErr)
  })

  it('does not manufacture ci-failed when the PR has already merged or closed', () => {
    sandbox()
    const opened = openApproved()
    writeSim((state) => {
      const pr = state.prs[String(opened.number)]
      if (!pr) throw new Error('missing PR')
      pr.state = 'MERGED'
    })
    const merged = runCompletedWatch({
      pr: opened.number,
      watchExit: 1,
      watchStdout: FAIL_LOG,
      watchStderr: 'ci=failure\n',
      mode: 'native',
      goalStopArgv: goalStopArgv(RUN_A, A),
    })
    expect(merged.outcome).toEqual({ status: 'merged' })
    expect(merged.detail).toBe('')
    expect(readSim().issues[String(A)]?.comments.some((comment) => readMarker(comment.body, 'goal-stop'))).toBe(false)

    writeSim((state) => {
      const pr = state.prs[String(opened.number)]
      if (!pr) throw new Error('missing PR')
      pr.state = 'CLOSED'
    })
    const closed = runCompletedWatch({
      pr: opened.number,
      watchExit: 1,
      watchStdout: FAIL_LOG,
      watchStderr: 'ci=failure\n',
      mode: 'native',
      goalStopArgv: goalStopArgv(RUN_A, A),
    })
    expect(closed.outcome).toEqual({ status: 'stopped' })
    expect(closed.detail).toBe('')
    expect(readSim().issues[String(A)]?.comments.some((comment) => readMarker(comment.body, 'goal-stop'))).toBe(false)
  })

  it('returns driver-error on a dirty tree and does not commit', () => {
    const { epic } = sandbox()
    const opened = openApproved()
    const head = git(epic, ['rev-parse', 'HEAD'])
    writeFileSync(path.join(epic, 'dirty.txt'), 'dirty\n')
    const fenced = runCompletedWatch({
      pr: opened.number,
      watchExit: 1,
      watchStdout: FAIL_LOG,
      watchStderr: 'ci=failure\n',
      mode: 'native',
      goalStopArgv: goalStopArgv(RUN_A, A),
    })
    expect(fenced.outcome).toMatchObject({ status: 'driver-error', class: 'shared' })
    expect(fenced.outcome.exitCode).not.toBe(0)
    expect(git(epic, ['status', '--porcelain'])).toContain('dirty.txt')
    expect(git(epic, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(epic, ['log', '-1', '--format=%s'])).not.toContain('wip: goal-stop')
    expect(readSim().issues[String(A)]?.comments.some((comment) => readMarker(comment.body, 'goal-stop'))).toBe(false)
  })
})
