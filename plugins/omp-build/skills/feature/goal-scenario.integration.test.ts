import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
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
  step: { action: string; ticket?: number; branch?: string; range?: string; stop?: string; stage?: string }
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

function sandbox(): Box {
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
  writeFileSync(
    path.join(principal, '.dev', 'stack.yml'),
    [
      'landing:',
      '  mode: native',
      '  required_checks:',
      '    - ci',
      'release:',
      '  model: trunk',
      '  post_merge:',
      '    - ./scripts/post-merge.sh',
      '',
    ].join('\n'),
  )
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

function roundsRecord(): string {
  return '<!-- omp-build:review-rounds reviews=1 fixes=0 -->\nReview bound.'
}

function approve(pr: number, sha: string): void {
  const review = gh(['pr', 'comment', String(pr), '--body', reviewRecord(sha)])
  const rounds = gh(['pr', 'comment', String(pr), '--body', roundsRecord()])
  if (review.status !== 0 || rounds.status !== 0) {
    throw new Error(`approve #${pr}: ${review.stderr}${rounds.stderr}`)
  }
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

    git(epic, ['switch', '-q', '-c', BRANCH_C])
    commitAndPush(BRANCH_C, 'feat(c): abandoned (#4)', 'c.txt')
    const openedC = callWorkflow<{ number: number; status: string }>('openPr', epic, {
      issue: C,
      branch: BRANCH_C,
      base: 'main',
      title: 'feat(c): child c',
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
    expect(git(box.origin, ['merge-base', '--is-ancestor', shaA, originMain])).toBe('')

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
    expect(readSim().issues[String(C)]?.state).toBe('CLOSED')
  })
})
