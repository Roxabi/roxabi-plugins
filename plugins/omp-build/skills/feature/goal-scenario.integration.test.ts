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
import { type CanonicalRecord, decodeHistory, encodeRecord } from '../../contracts.ts'
import { PROOF_PIN_PATHS } from '../../roxabi/workflow-config.ts'
import { encodedAdmissionReviewGraph, epicReviewGraph, TEST_PROJECTION_CONFIG } from '../../testing/records.ts'
import {
  childSnapshot,
  epicMandate,
  featureMandate,
  framedBodies,
  historyFrom,
  mandateRef,
} from '../../testing/workflow-records.ts'

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

function events(issue: number): Record<string, unknown>[] {
  const comments = readSim().issues[String(issue)]?.comments ?? []
  return decodeHistory({
    scope: { repository: 'acme/app', target: `acme/app#${issue}` },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: comments.map((comment, index) => ({
      locator: `acme/app#${issue}:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    diagnostics: [],
  }).operations.flatMap((operation) =>
    operation.record?.kind === 'epic-event' ? [operation.record.payload as Record<string, unknown>] : [],
  )
}

function seedEpicDecision(range: string): string {
  const head = range.slice(range.indexOf('..') + 2)
  const graph = epicReviewGraph({ prefix: `goal-${RUN_B}`, head, empty: true })
  const root = {
    ...graph.root,
    repository: 'acme/app',
    target: `acme/app#${EPIC}`,
    payload: { ...graph.root.payload, subject: { kind: 'epic-range' as const, range } },
  }
  const records = graph.records.map((record) =>
    record.recordId === root.recordId ? root : { ...record, repository: 'acme/app', target: `acme/app#${EPIC}` },
  ) as CanonicalRecord[]
  writeSim((state) => {
    const issue = state.issues[String(EPIC)]
    if (!issue) throw new Error('missing epic issue')
    for (const record of records) {
      const encoded = encodeRecord(
        record,
        {
          scope: { repository: 'acme/app', target: `acme/app#${EPIC}` },
          expectedAuthor: 'operator',
          stopAuthor: null,
          complete: true,
          comments: issue.comments.map((comment, index) => ({
            locator: `acme/app#${EPIC}:comment:${index + 1}`,
            nativeId: String(index + 1),
            body: comment.body,
            author: comment.author,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          })),
          diagnostics: [],
        },
        TEST_PROJECTION_CONFIG,
      )
      if (!encoded.ok) throw new Error(encoded.diagnostics.map((entry) => entry.code).join(', '))
      issue.comments.push(...encoded.value.map((body) => ({ author: 'operator', body })))
    }
  })
  return graph.decision.recordId
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

const CHILD_BODY = '## Acceptance criteria\n\n- [ ] lands\n'
const EPIC_BODY = '## Acceptance criteria\n\n- [ ] delivered\n'

/** Actual committed proof pins at origin/main tip — never catalogue/dummy defaults. */
function liveBaseProofPins(): { sourceCommit: string; path: string; blob: string | null }[] {
  if (!box) throw new Error('no sandbox')
  const origin = box.origin
  const sourceCommit = git(origin, ['rev-parse', 'refs/heads/main'])
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error(`origin/main tip unreadable: ${sourceCommit}`)
  return PROOF_PIN_PATHS.map((pinPath) => {
    try {
      const blob = git(origin, ['rev-parse', '--verify', '--quiet', `${sourceCommit}:${pinPath}`])
      return { sourceCommit, path: pinPath, blob: /^[0-9a-f]{40}$/.test(blob) ? blob : null }
    } catch {
      return { sourceCommit, path: pinPath, blob: null }
    }
  })
}

function epicRecord(): ReturnType<typeof epicMandate> {
  return epicMandate(
    { repository: 'acme/app', target: `acme/app#${EPIC}` },
    [A, B, C].map((number) => childSnapshot({ repository: 'acme/app', target: `acme/app#${number}` }, CHILD_BODY)),
    { run: RUN_A, body: EPIC_BODY },
  )
}

/** Epic mandate only. Child feature mandates bind at selection time (see ensureChildMandate). */
function ensureMandate(): void {
  if (!box) throw new Error('no sandbox')
  const state = readSim()
  const epicIssue = state.issues[String(EPIC)]
  if (epicIssue?.comments.some((comment) => comment.body.includes('kind=mandate'))) return
  const epic = epicRecord()
  const epicBodies = framedBodies([epic], 'operator')
  writeSim((sim) => {
    const issue = sim.issues[String(EPIC)]
    if (!issue) throw new Error('missing epic issue')
    issue.comments.push(...epicBodies.map((body) => ({ author: 'operator', body })))
  })
}

/**
 * Seed one child feature mandate against the committed base pins at selection time.
 * Never rewrite an already-accepted child mandate; never preseed all children before base advances.
 */
function ensureChildMandate(number: number, branch: string, id: string): void {
  if (!box) throw new Error('no sandbox')
  ensureMandate()
  const state = readSim()
  const childIssue = state.issues[String(number)]
  if (childIssue?.comments.some((comment) => comment.body.includes('kind=mandate'))) return
  const epic = epicRecord()
  const epicHistory = historyFrom([epic], 'operator')
  const mandate = featureMandate(
    { repository: 'acme/app', target: `acme/app#${number}` },
    {
      recordId: `mandate-feature-${id}`,
      operationId: `op-mandate-feature-${id}`,
      runId: RUN_A,
      body: CHILD_BODY,
      branch,
      base: 'main',
      lineageHead: null,
      proofPins: liveBaseProofPins(),
      parent: mandateRef(epic),
    },
  )
  const bodies = framedBodies([mandate], 'operator', [epicHistory])
  writeSim((sim) => {
    const child = sim.issues[String(number)]
    if (!child) throw new Error(`missing child issue #${number}`)
    // Guard again inside the write: never rewrite an accepted mandate.
    if (child.comments.some((comment) => comment.body.includes('kind=mandate'))) return
    child.comments.push(...bodies.map((body) => ({ author: 'operator', body })))
  })
}

function drive(args: string[], _run: string, cwd = box?.epic): { code: number | null; stdout: string; stderr: string } {
  if (!box || !cwd) throw new Error('no sandbox')
  ensureMandate()
  const out = spawnSync(REAL_BUN, [DRIVER, ...args, '--epic', String(EPIC)], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
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

/**
 * Seed a durable approval bound to the product captureReviewInput digest for the
 * selected Spec/config/no-producer pair — never null or an arbitrary dummy hash.
 */
function approve(pr: number, sha: string, cwd: string): void {
  const captured = callWorkflow<{ ok: boolean; input?: string | null; error?: string }>('captureReviewInput', cwd, {
    pr,
    head: sha,
  })
  if (!captured.ok || typeof captured.input !== 'string' || !/^[0-9a-f]{64}$/.test(captured.input)) {
    throw new Error(`approve #${pr}: captureReviewInput failed ${JSON.stringify(captured)}`)
  }
  const bodies = encodedAdmissionReviewGraph({
    scope: { repository: 'acme/app', target: `acme/app#${pr}` },
    head: sha,
    input: captured.input,
    prefix: `scenario-${pr}-${sha.slice(0, 8)}`,
  }).comments.map((comment) => comment.body)
  for (const body of bodies) {
    const review = gh(['pr', 'comment', String(pr), '--body', body])
    if (review.status !== 0) throw new Error(`approve #${pr}: ${review.stderr}`)
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
    ensureChildMandate(A, BRANCH_A, 'a')
    const openedA = callWorkflow<{ number: number; status: string }>('openPr', epic, {
      issue: A,
      branch: BRANCH_A,
      base: 'main',
      title: 'feat(a): child a',
    })
    expect(openedA.status).toBe('created')
    approve(openedA.number, shaA, epic)

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
    expect(landed, JSON.stringify(landed)).toMatchObject({ status: 'watching', mode: 'native' })
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
    ensureChildMandate(C, BRANCH_C, 'c')
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
    ensureChildMandate(B, BRANCH_B, 'b')
    const openedB = callWorkflow<{ number: number; status: string }>('openPr', epic, {
      issue: B,
      branch: BRANCH_B,
      base: 'main',
      title: 'feat(b): child b',
    })
    approve(openedB.number, shaB, epic)
    const landedB = callWorkflow<{ status: string; error?: string }>('landPr', epic, {
      pr: openedB.number,
    })
    // B is already green when auto-merge arms, so native landing may complete
    // synchronously instead of creating the watcher covered by A above.
    expect(landedB.status, landedB.error).toBe('merged')
    expect(prOf(BRANCH_B).state).toBe('MERGED')
    expect(prOf(BRANCH_B).autoMerge).toBeNull()
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

    // The documented launch consumes a confirmed Epic-scope decision.
    const decisionId = seedEpicDecision(range)
    const reviewed = drive(['review', '--decision-record', decisionId, '--range', range], RUN_B)
    expect(reviewed.stderr).toBe('')
    expect(reviewed.code).toBe(0)
    expect(events(EPIC)).toContainEqual(
      expect.objectContaining({ event: 'epic-review', run: RUN_A, decisionId, range }),
    )
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
    expect(events(EPIC)).toContainEqual(
      expect.objectContaining({
        event: 'goal-report',
        run: RUN_A,
        outcome: 'complete',
      }),
    )
    expect(events(EPIC)).toContainEqual(
      expect.objectContaining({
        event: 'post-merge',
        run: RUN_A,
        result: 'ok',
        sha: hookSha,
      }),
    )
    expect(events(C)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN_A, reason: 'review-bound' }),
    )
    expect(readSim().prs[String(openedA.number)]?.state).toBe('MERGED')
    expect(readSim().prs[String(openedB.number)]?.state).toBe('MERGED')
  })
})
