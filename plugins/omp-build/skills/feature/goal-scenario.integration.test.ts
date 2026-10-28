import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { A, B, BRANCH_A, BRANCH_B, BRANCH_C, C, EPIC, RUN_A, RUN_B } from './testing/goal/goal-scenario-domain.ts'
import {
  approve,
  drive,
  ensureChildMandate,
  events,
  jsonOf,
  seedEpicDecision,
} from './testing/goal/goal-scenario-records.ts'
import {
  callWorkflow,
  commitAndPush,
  dispose,
  gh,
  git,
  markGreen,
  prOf,
  readSim,
  sandbox,
  stoppedArms,
  writeSim,
} from './testing/goal/goal-scenario-sandbox.ts'

afterEach(dispose)

describe('stateful gh — one continuous goal', () => {
  it('lands, crashes, merges, stops, and completes without an armed stopped PR', () => {
    const { epic, origin, root } = sandbox()
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
    expect(gh(['pr', 'merge', String(openedA.number), '--auto', '--merge', '--match-head-commit', shaA]).status).toBe(0)
    const moved = commitAndPush(BRANCH_A, 'feat(a): move head (#2)', 'a-moved.txt')
    const refused = callWorkflow<{ status: string; reason?: string }>('landPr', epic, { pr: openedA.number })
    expect(refused).toMatchObject({ status: 'not-approved', reason: 'head-moved' })
    expect(prOf(BRANCH_A).labels).not.toContain('reviewed')

    markGreen(moved)
    const originBefore = git(origin, ['rev-parse', 'refs/heads/main'])
    expect(JSON.parse(gh(['pr', 'view', String(openedA.number), '--json', 'state']).stdout).state).toBe('OPEN')
    expect(git(origin, ['rev-parse', 'refs/heads/main'])).toBe(originBefore)
    expect(gh(['pr', 'merge', String(openedA.number), '--disable-auto']).status).toBe(0)
    git(epic, ['reset', '--hard', shaA])
    git(epic, ['push', '--force', '-q', 'origin', BRANCH_A])

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
    expect(JSON.parse(gh(['pr', 'view', String(openedA.number), '--json', 'state']).stdout).state).toBe('OPEN')
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
    expect(JSON.parse(gh(['pr', 'view', String(openedA.number), '--json', 'state']).stdout).state).toBe('OPEN')
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
    expect(JSON.parse(gh(['pr', 'view', String(openedA.number), '--json', 'state']).stdout).state).toBe('OPEN')
    writeSim((state) => {
      state.checks[shaA] = [
        { name: 'ci', status: 'in_progress', conclusion: '', workflowName: 'ci', startedAt: '2026-01-01T00:06:00Z' },
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:07:00Z',
        },
      ]
    })
    expect(JSON.parse(gh(['pr', 'view', String(openedA.number), '--json', 'state']).stdout).state).toBe('OPEN')
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
    const originUnarmed = git(origin, ['rev-parse', 'refs/heads/main'])
    expect(JSON.parse(gh(['pr', 'view', String(openedC.number), '--json', 'state']).stdout).state).toBe('OPEN')
    expect(git(origin, ['rev-parse', 'refs/heads/main'])).toBe(originUnarmed)
    writeSim((state) => {
      delete state.checks[shaC]
    })

    expect(gh(['pr', 'edit', String(openedC.number), '--add-label', 'reviewed']).status).toBe(0)
    git(epic, ['switch', '-q', BRANCH_A])
    expect(drive(['stop', '--ticket', String(C), '--reason', 'review-bound'], RUN_A).code).toBe(0)
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
    expect(stoppedArms()).toEqual([])
    expect(resumed.step).toMatchObject({ action: 'start', ticket: B, branch: BRANCH_B })
    const mergedA = prOf(BRANCH_A)
    expect(mergedA.state).toBe('MERGED')
    expect(mergedA.mergeCommit?.parents).toHaveLength(2)
    const originMain = git(origin, ['rev-parse', 'refs/heads/main'])
    expect(originMain).toBe(mergedA.mergeCommit?.oid)
    expect(git(origin, ['rev-parse', `${originMain}^2`])).toBe(shaA)

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
    const landedB = callWorkflow<{ status: string }>('landPr', epic, { pr: openedB.number })
    expect(landedB.status).toBe('merged')
    expect(prOf(BRANCH_B).state).toBe('MERGED')
    expect(prOf(BRANCH_B).autoMerge).toBeNull()
    expect(prOf(BRANCH_B).mergeCommit?.parents[1]).toBe(shaB)
    writeSim((state) => {
      const issue = state.issues[String(C)]
      if (issue) {
        issue.state = 'CLOSED'
        issue.stateReason = 'COMPLETED'
      }
    })
    const afterStop = jsonOf(drive(['next'], RUN_B))
    expect(stoppedArms()).toEqual([])
    expect(afterStop.step.action).toBe('final-review')
    expect(afterStop.step.stage).toBe('review')
    const range = afterStop.step.range ?? ''
    expect(range).toMatch(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/)

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
    expect(stoppedArms()).toEqual([])
    rmSync(path.join(epic, 'dirty.txt'))
    const hookStep = jsonOf(drive(['next'], RUN_B))
    expect(hookStep.step.action).toBe('post-merge')
    expect(stoppedArms()).toEqual([])

    const hooked = drive(['hook', '--repo', epic], RUN_B, root)
    expect(hooked.code).toBe(0)
    const hookSha = git(epic, ['rev-parse', 'refs/remotes/origin/main'])
    expect(hooked.stdout).toContain(hookSha)
    const done = jsonOf(drive(['next'], RUN_B))
    expect(stoppedArms()).toEqual([])
    expect(done.step.action).toBe('complete')
    expect(drive(['report', '--outcome', 'complete'], RUN_B).code).toBe(0)
    expect(events(EPIC)).toContainEqual(
      expect.objectContaining({ event: 'goal-report', run: RUN_A, outcome: 'complete' }),
    )
    expect(events(EPIC)).toContainEqual(
      expect.objectContaining({ event: 'post-merge', run: RUN_A, result: 'ok', sha: hookSha }),
    )
    expect(events(C)).toContainEqual(
      expect.objectContaining({ event: 'goal-stop', run: RUN_A, reason: 'review-bound' }),
    )
    expect(readSim().prs[String(openedA.number)]?.state).toBe('MERGED')
    expect(readSim().prs[String(openedB.number)]?.state).toBe('MERGED')
  })
})
