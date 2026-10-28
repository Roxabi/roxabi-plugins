import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { epicReviewGraph, reviewGraph } from '../../testing/record-graphs.ts'
import { serveBoundEpic } from './testing/epic-driver/epic-driver-bound-fixture.ts'
import {
  type Comment,
  childNode,
  epicDecisionHistory,
  epicEvent,
  eventPayloads,
  framedRecords,
  issueComments,
  ME,
  prNode,
  RUN,
  serveComments,
  serveEpic,
  servePr,
  strictSpecBody,
} from './testing/epic-driver/epic-driver-records.ts'
import { cleanupSandbox, drive, git, sandbox, sandboxOf, writes } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)
describe('epic-driver — unframed child', () => {
  it('does not start a child that has no scope', () => {
    // The confirmed parent grant remains valid; the child itself deliberately
    // omits the required Spec framing and must never activate.
    const { epic } = sandbox()
    const unframed = {
      ...childNode(2, 'feat(x): first child'),
      body: '## Needs framing\n',
      specBody: strictSpecBody('feat(x): first child'),
    }
    serveEpic([unframed])
    const run = drive(['next'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('unsettled-child')
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(writes()).toEqual([])
  })

  it('refuses when live body drifts from the framed accepted Spec', () => {
    const { epic } = sandbox()
    const drifted = {
      ...childNode(2, 'feat(x): first child'),
      body: strictSpecBody('feat(x): changed child'),
      specBody: strictSpecBody('feat(x): first child'),
    }
    serveEpic([drifted])
    const run = drive(['next'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('changed-child')
    expect(git(epic, 'branch', '--show-current')).toBe('')
    expect(writes()).toEqual([])
  })
})

describe('epic-driver — review bound', () => {
  function reviewed(number: number, outcomes: { blocking: boolean; author?: string }[]): void {
    const comments = outcomes.flatMap((outcome, index) => {
      const graph = reviewGraph({ prefix: `bound-${number}-${index}`, empty: !outcome.blocking })
      return framedRecords(number, graph.records).map((comment) => ({ ...comment, author: outcome.author ?? ME }))
    })
    serveComments(number, [...issueComments(number), ...comments])
  }

  function openPrChild(): void {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    serveBoundEpic(
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip)] }),
      11,
      'feat/2-first-child',
    )
  }

  it('keeps a PR stopped once its third canonical review is blocking', () => {
    openPrChild()
    reviewed(11, [{ blocking: true }, { blocking: true }, { blocking: true }])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
    expect(run.json().step.report.stopped).toEqual([{ ticket: 2, reason: 'review-bound', sticky: true }])
  })

  it('does not lift the bound when a later canonical review is clean', () => {
    openPrChild()
    reviewed(11, [{ blocking: true }, { blocking: true }, { blocking: true }, { blocking: false }])
    const run = drive(['next', '--dry-run'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'no-progress' })
  })

  it('resumes a PR with a fix round left', () => {
    openPrChild()
    reviewed(11, [{ blocking: true }])
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'resume', ticket: 2, pr: { number: 11 } })
  })

  it('does not count canonical records posted by another login', () => {
    openPrChild()
    reviewed(11, [{ blocking: true, author: 'mallory' }, { blocking: true, author: 'mallory' }, { blocking: true }])
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'resume', ticket: 2, pr: { number: 11 } })
  })

  it('reads a canonical review graph after the first 100 REST comment records', () => {
    openPrChild()
    const padding: Comment[] = Array.from({ length: 100 }, (_, index) => ({
      author: ME,
      body: `ordinary historical comment ${index}`,
    }))
    const graph = reviewGraph({ prefix: 'pagination-review' })
    serveComments(11, [...padding, ...issueComments(11), ...framedRecords(11, graph.records)])

    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'resume', ticket: 2, pr: { number: 11 } })
  })
})

describe('epic-driver — hook', () => {
  it('records canonical hook events without publishing hook output', () => {
    const { principal, epic, root } = sandbox()
    mkdirSync(path.join(principal, 'scripts'))
    writeFileSync(path.join(principal, 'scripts', 'post-merge.sh'), '#!/bin/sh\necho "token=s3cr3t-value"\n')
    chmodSync(path.join(principal, 'scripts', 'post-merge.sh'), 0o755)
    writeFileSync(
      path.join(principal, '.dev', 'stack.yml'),
      'release:\n  model: trunk\n  post_merge:\n    - ./scripts/post-merge.sh\n',
    )
    const base = git(principal, 'rev-parse', 'HEAD')
    git(principal, 'add', '.')
    git(principal, 'commit', '-qm', 'chore: hook (#2)')
    git(principal, 'push', '-q', 'origin', 'main')
    const merge = git(principal, 'rev-parse', 'HEAD')
    git(epic, 'fetch', '-q', 'origin')
    const merged = prNode(10, 'feat/2-first-child', 'c'.repeat(40), {
      state: 'MERGED',
      mergedAt: '2026-09-30T10:00:00Z',
      mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }] } },
    })
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      epicDecisionHistory(`${base}..${merge}`, false),
    )

    const run = drive(['hook', '--repo', epic], { cwd: root })

    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({ result: 'ok', sha: merge, output: expect.stringContaining('s3cr3t-value') })
    expect(eventPayloads(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'post-merge', run: RUN, result: 'started', sha: merge }),
        expect.objectContaining({ event: 'post-merge', run: RUN, result: 'ok', sha: merge }),
      ]),
    )
    expect(
      issueComments(1)
        .map((comment) => comment.body)
        .join('\n'),
    ).not.toContain('s3cr3t-value')
  })
})

describe('epic-driver — unreadable landing', () => {
  it('drops on it, disarms, and reports through one canonical event', () => {
    sandbox('release:\n  model: trunk\nlanding:\n  mode: squash\n')
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveBoundEpic(
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
      11,
      'feat/2-first-child',
    )
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })

    const next = drive(['next'])
    expect(next.code).toBe(0)
    expect(next.json().step).toMatchObject({ action: 'drop', stop: 'bad-landing' })

    const report = drive(['report', '--outcome', 'drop', '--reason', 'bad-landing'])
    expect(report.code).toBe(0)
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', run: RUN, outcome: 'drop', reason: 'bad-landing' }),
    )
  })
})

function landedEpic(files: Record<string, string> = {}): {
  range: string
  merged: Record<string, unknown>
  proof: string
} {
  const { principal, epic, root } = sandbox()
  const proof = path.join(root, 'hook-ran')
  mkdirSync(path.join(principal, 'scripts'))
  writeFileSync(path.join(principal, 'scripts', 'post-merge.sh'), `#!/bin/sh\ntouch '${proof}'\n`)
  chmodSync(path.join(principal, 'scripts', 'post-merge.sh'), 0o755)
  writeFileSync(
    path.join(principal, '.dev', 'stack.yml'),
    'release:\n  model: trunk\n  post_merge:\n    - ./scripts/post-merge.sh\n',
  )
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(principal, name), text)
  const base = git(principal, 'rev-parse', 'HEAD')
  git(principal, 'add', '.')
  git(principal, 'commit', '-qm', 'feat(x): first child (#2)')
  git(principal, 'push', '-q', 'origin', 'main')
  const merge = git(principal, 'rev-parse', 'HEAD')
  git(epic, 'fetch', '-q', 'origin')
  if (Object.keys(files).length) git(epic, 'checkout', '-q', '--detach', 'refs/remotes/origin/main')
  const merged = prNode(10, 'feat/2-first-child', 'c'.repeat(40), {
    state: 'MERGED',
    mergedAt: '2026-09-30T10:00:00Z',
    mergeCommit: { oid: merge, parents: { nodes: [{ oid: base }] } },
  })
  return { range: `${base}..${merge}`, merged, proof }
}

describe('epic-driver — fresh parent admission at terminal effects', () => {
  function prepare(action: 'review' | 'hook' | 'complete') {
    const { range, merged, proof } = landedEpic()
    // Generate an independent native blocker through the same fixture builder;
    // it is not a child of the accepted Epic.
    serveEpic([childNode(3, 'fix(y): independent blocker')])
    const blockerPath = path.join(sandboxOf().state, 'uw-3.json')
    const blocker = JSON.parse(readFileSync(blockerPath, 'utf8'))
    blocker.data.repository.issue.parent = null
    writeFileSync(blockerPath, JSON.stringify(blocker))

    const history = epicDecisionHistory(range, false)
    const decision = epicReviewGraph({ prefix: `epic-${range.split('..')[1].slice(0, 8)}`, head: range.split('..')[1] })
    const hook = framedRecords(1, [
      epicEvent(1, 'terminal-hook-ok', {
        event: 'post-merge',
        run: RUN,
        result: 'ok',
        sha: range.split('..')[1],
        exitCode: 0,
      }),
    ])
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      action === 'review' ? history.slice(0, -1) : action === 'hook' ? history : [...history, ...hook],
    )
    return { range, proof, decisionId: decision.decision.recordId }
  }

  function changeParent(change: 'blocker' | 'tier'): void {
    const parentPath = path.join(sandboxOf().state, 'uw-1.json')
    const parent = JSON.parse(readFileSync(parentPath, 'utf8'))
    if (change === 'blocker') {
      parent.data.repository.issue.blockedBy.nodes = [{ number: 3, repository: { nameWithOwner: 'o/r' } }]
    } else {
      parent.data.repository.issue.labels.nodes = []
    }
    writeFileSync(parentPath, JSON.stringify(parent))
  }

  it.each<{ action: 'review' | 'hook' | 'complete'; change: 'blocker' | 'tier' }>([
    { action: 'review', change: 'blocker' },
    { action: 'review', change: 'tier' },
    { action: 'hook', change: 'blocker' },
    { action: 'hook', change: 'tier' },
    { action: 'complete', change: 'blocker' },
    { action: 'complete', change: 'tier' },
  ])('refuses $action when the accepted parent acquires a $change change', ({ action, change }) => {
    const { range, proof, decisionId } = prepare(action)
    changeParent(change)
    const args =
      action === 'review'
        ? ['review', '--decision-record', decisionId, '--range', range]
        : action === 'hook'
          ? ['hook']
          : ['report', '--outcome', 'complete']

    const { epic, root } = sandboxOf()
    const run = action === 'hook' ? drive([...args, '--repo', epic], { cwd: root }) : drive(args)

    expect(run.code, run.stderr).toBe(2)
    expect(run.stderr).toContain('native delivery admission refused')
    expect(writes()).toEqual([])
    expect(existsSync(proof)).toBe(false)
  })

  it('publishes an exact-range review when the parent remains deliverable', () => {
    const { range, decisionId } = prepare('review')
    const run = drive(['review', '--decision-record', decisionId, '--range', range])
    expect(run.code).toBe(0)
    expect(eventPayloads(1)).toContainEqual(expect.objectContaining({ event: 'epic-review', decisionId, range }))
  })

  it('runs the hook with the same unchanged parent fixture', () => {
    const { proof } = prepare('hook')
    const { epic, root } = sandboxOf()
    const run = drive(['hook', '--repo', epic], { cwd: root })
    expect(run.code, run.stderr).toBe(0)
    expect(run.json()).toMatchObject({ result: 'ok' })
    expect(existsSync(proof)).toBe(true)
    expect(eventPayloads(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'post-merge', result: 'started' }),
        expect.objectContaining({ event: 'post-merge', result: 'ok' }),
      ]),
    )
  })

  it('still permits a drop report when the parent loses its tier', () => {
    prepare('complete')
    changeParent('tier')
    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])
    expect(run.code).toBe(0)
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', outcome: 'drop', reason: 'driver-error' }),
    )
  })
})

describe('epic-driver — canonical final review history', () => {
  it('uses the exact epic range, complete decision graph, and no free verdict', () => {
    const { range, merged } = landedEpic()
    const history = epicDecisionHistory(range, true)
    serveEpic([childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })], history)

    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({
        event: 'epic-review',
        run: RUN,
        range,
        inventoryIds: expect.any(Array),
        decisionId: expect.any(String),
      }),
    )
    expect(eventPayloads(1)[0]).not.toHaveProperty('verdict')
    expect(drive(['next', '--dry-run']).json().step).toMatchObject({ action: 'final-review', stage: 'fix-ticket' })
    expect(drive(['mark-fix', '--ticket', '999']).code).toBe(2)
    const marked = drive(['mark-fix', '--ticket', '2'])
    expect(marked.code).toBe(0)
    expect(eventPayloads(2)).toContainEqual(expect.objectContaining({ event: 'epic-fix', run: RUN }))
    expect(eventPayloads(1)).not.toContainEqual(expect.objectContaining({ event: 'epic-fix', run: RUN }))
    expect(drive(['review', '--range', range]).code).toBe(2)
  })

  it('refuses to resume a historically stopped child from canonical history', () => {
    sandbox()
    const historical = {
      ...epicEvent(2, 'historic-stop', { event: 'goal-stop', run: 'run00000', reason: 'review-bound', detail: '' }),
      runId: 'run00000',
    }
    serveEpic([
      childNode(2, 'feat(x): first child', { comments: framedRecords(2, [historical]) }),
      childNode(3, 'fix(y): independent child'),
    ])

    const next = drive(['next', '--dry-run'])
    expect(next.json().step).toMatchObject({ action: 'start', ticket: 3 })
    expect(next.json().step.report.stopped).toEqual([{ ticket: 2, reason: 'review-bound', sticky: true }])
  })
})

describe('epic-driver — fork PRs', () => {
  it('ignores a fork PR carrying the child branch name, found through a cross-reference', () => {
    const { epic } = sandbox()
    const fork = prNode(66, 'feat/2-first-child', 'e'.repeat(40), {
      isCrossRepository: true,
      labels: { nodes: [{ name: 'reviewed' }] },
    })
    const node = childNode(2, 'feat(x): first child')
    node.timelineItems = { nodes: [{ source: fork }] } as typeof node.timelineItems
    serveEpic([node])

    const run = drive(['next'])
    expect(run.code).toBe(0)
    expect(run.json().recorded).toEqual([])
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 2, branch: 'feat/2-first-child' })
    expect(git(epic, 'branch', '--show-current')).toBe('feat/2-first-child')
  })
})

describe('epic-driver — disarm modes', () => {
  function child2Pr(armed: Record<string, unknown>): void {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    serveBoundEpic(
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', tip, armed)] }),
      11,
      'feat/2-first-child',
    )
  }

  it('removes a merge-on-green label with no auto-merge to disable', () => {
    child2Pr({ labels: { nodes: [{ name: 'reviewed' }] } })
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: false })
    const run = drive(['stop', '--ticket', '2', '--reason', 'ci-blocked'])
    expect(run.code).toBe(0)
    expect(writes()).toEqual([
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 2 <!-- omp-build-record /),
    ])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'ci-blocked' }),
    )
  })

  it('touches nothing on a PR that was never armed', () => {
    child2Pr({})
    servePr(11, { state: 'OPEN', labels: [], autoMerge: false })
    drive(['stop', '--ticket', '2', '--reason', 'base-blocked'])
    expect(writes()).toEqual([expect.stringMatching(/^comment 2 <!-- omp-build-record /)])
    expect(eventPayloads(2)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN, reason: 'base-blocked' }),
    )
  })
})

describe('epic-driver — report', () => {
  it('reports the hook result that completed the goal, even from an earlier run', () => {
    const { range, merged } = landedEpic()
    const merge = range.split('..')[1] ?? ''
    const earlier = framedRecords(1, [
      {
        ...epicEvent(1, 'earlier-hook', {
          event: 'post-merge',
          run: 'run00000',
          result: 'ok',
          sha: merge,
          exitCode: 0,
        }),
        runId: 'run00000',
      },
    ])
    serveEpic(
      [childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] })],
      [...epicDecisionHistory(range, false), ...earlier],
    )

    const run = drive(['report', '--outcome', 'complete'])

    expect(run.code).toBe(0)
    expect(run.stdout).toContain(`| Post-merge hook | ok at \`${merge}\` (run \`run00000\`) |`)
  })
})

describe('epic-driver — base CI', () => {
  function serveRollup(nodes: unknown[]): void {
    const data = { data: { repository: { object: { statusCheckRollup: { contexts: { nodes } } } } } }
    writeFileSync(path.join(sandboxOf().state, 'rollup.json'), JSON.stringify(data))
  }
  const check = (name: string, conclusion: string) => ({
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    startedAt: '2026-09-30T09:00:00Z',
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
  })

  it('drops on a red base before switching to any child', () => {
    const { epic } = sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    serveRollup([check('test', 'FAILURE'), check('lint', 'SUCCESS')])
    const run = drive(['next'])
    expect(run.json().step).toMatchObject({ action: 'drop', stop: 'base-ci-red' })
    expect(run.json().step.report.baseCi).toMatchObject({ state: 'red', failed: ['test'] })
    expect(git(epic, 'branch', '--show-current')).toBe('')
  })

  it('reads only the check set the landing declares', () => {
    const { epic } = sandbox('release:\n  model: trunk\nlanding:\n  required_checks: [lint]\n')
    serveEpic([childNode(2, 'feat(x): first child')])
    serveRollup([check('test', 'FAILURE'), check('lint', 'SUCCESS')])
    const run = drive(['next'])
    expect(run.json().step).toMatchObject({ action: 'start', ticket: 2 })
    expect(run.json().step.report.baseCi).toMatchObject({ state: 'green', failed: [] })
    expect(git(epic, 'branch', '--show-current')).toBe('feat/2-first-child')
  })
})

describe('epic-driver — remaining branches', () => {
  it('resumes a branch that exists only on origin, tracking it', () => {
    const { epic } = sandbox()
    git(epic, 'switch', '-q', '-c', 'feat/2-first-child', 'refs/remotes/origin/main')
    writeFileSync(path.join(epic, 'one.txt'), 'one\n')
    git(epic, 'add', 'one.txt')
    git(epic, 'commit', '-qm', 'feat(x): first child (#2)')
    git(epic, 'push', '-q', 'origin', 'feat/2-first-child')
    const tip = git(epic, 'rev-parse', 'HEAD')
    git(epic, 'switch', '-q', '--detach', 'refs/remotes/origin/main')
    git(epic, 'branch', '-q', '-D', 'feat/2-first-child')
    serveEpic([childNode(2, 'feat(x): first child')])

    const run = drive(['next'])

    expect(run.json().step).toMatchObject({ action: 'resume', ticket: 2, branch: 'feat/2-first-child' })
    expect(git(epic, 'rev-parse', 'HEAD')).toBe(tip)
    expect(git(epic, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feat/2-first-child')
  })

  it('refuses to stop a ticket that is not a sub-issue', () => {
    sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    expect(drive(['stop', '--ticket', '7', '--reason', 'timeout']).code).toBe(2)
    expect(writes()).toEqual([])
  })

  it.each([
    ['stop', '--ticket', '2', '--reason', 'timeout'],
    ['review', '--decision-record', 'decision', '--range', `${'a'.repeat(40)}..${'b'.repeat(40)}`],
    ['hook'],
    ['report', '--outcome', 'drop', '--reason', 'x'],
  ])('refuses %s on the Principal', (...args) => {
    const { principal } = sandbox()
    serveEpic([childNode(2, 'feat(x): first child')])
    const run = drive(args, { cwd: principal })
    expect(run.code).toBe(2)
    expect(writes()).toEqual([])
  })
})

describe('epic-driver — drop disarms without the dashboard', () => {
  it('disarms every armed PR when the base-CI rollup query fails and records the report event', () => {
    sandbox()
    const armed = { labels: { nodes: [{ name: 'reviewed' }] }, autoMergeRequest: { enabledAt: 'x' } }
    serveBoundEpic(
      childNode(2, 'feat(x): first child', { prs: [prNode(11, 'feat/2-first-child', 'c'.repeat(40), armed)] }),
      11,
      'feat/2-first-child',
    )
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: true })
    writeFileSync(
      path.join(sandboxOf().state, 'rollup.json'),
      JSON.stringify({ data: null, errors: [{ message: 'statusCheckRollup failed' }] }),
    )

    const run = drive(['report', '--outcome', 'drop', '--reason', 'driver-error'])

    expect(run.code).toBe(0)
    expect(writes()).toEqual([
      'merge 11 --disable-auto',
      'edit 11 --remove-label reviewed',
      expect.stringMatching(/^comment 1 <!-- omp-build-record /),
    ])
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', run: RUN, outcome: 'drop', reason: 'driver-error' }),
    )
  })
})
