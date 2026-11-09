import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { scopeKey } from '../../engine/uw-graph.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { operatorDialogUi } from '../../testing/operator-dialog-ui.ts'
import authorization from './head-authorization.cjs'
import {
  acceptGoalCoverage,
  integrateGoalParent,
  publishGoalParentReview,
} from './testing/goal/goal-native-assessment.ts'
import { approve } from './testing/goal/goal-scenario-approval.ts'
import { A, B, BRANCH_A, BRANCH_B, BRANCH_C, C, EPIC, RUN_A, RUN_B } from './testing/goal/goal-scenario-domain.ts'
import {
  drive,
  ensureChildMandate,
  events,
  frameGoalChildren,
  jsonOf,
  seedGoalParentPlan,
} from './testing/goal/goal-scenario-records.ts'
import {
  callWorkflow,
  commitAndPush,
  dispose,
  gh,
  git,
  markGreen,
  moduleGh,
  prOf,
  readSim,
  sandbox,
  stoppedArms,
  writeSim,
} from './testing/goal/goal-scenario-sandbox.ts'

afterEach(dispose)

describe('stateful gh — one continuous goal', () => {
  // This continuous world now produces authenticated Parent coverage, plan, integration and review.
  // This case has a dedicated lifecycle budget; global integration defaults are unchanged.
  it('lands, crashes, merges, stops, and completes without an armed stopped PR', async () => {
    const { epic, origin, root } = sandbox()
    expect(git(epic, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
    expect(git(epic, ['branch', '--list', 'feature/1-parent'])).toBe('')
    expect(git(origin, ['branch', '--list', 'feature/1-parent'])).toBe('')
    frameGoalChildren([
      { number: A, branch: BRANCH_A, id: 'a' },
      { number: B, branch: BRANCH_B, id: 'b' },
      { number: C, branch: BRANCH_C, id: 'c' },
    ])
    const started = jsonOf(drive(['next'], RUN_A))
    expect(started.step, JSON.stringify(started, null, 2)).toMatchObject({
      action: 'start',
      ticket: A,
      branch: BRANCH_A,
    })
    expect(git(epic, ['branch', '--show-current'])).toBe(BRANCH_A)

    const shaA = await ensureChildMandate(A, BRANCH_A, 'a', () =>
      commitAndPush(BRANCH_A, 'feat(a): land child (#2)', 'a.txt'),
    )
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
    const baseline = callWorkflow<{ status: string; mode?: string }>('landPr', epic, { pr: openedA.number })
    expect(baseline).toMatchObject({ status: 'watching', mode: 'native' })
    expect(prOf(BRANCH_A).autoMerge).toMatchObject({ matchHeadCommit: shaA })
    const moved = commitAndPush(BRANCH_A, 'feat(a): move head (#2)', 'a-moved.txt')
    const refused = callWorkflow<{ status: string; reason?: string }>('landPr', epic, { pr: openedA.number })
    expect(refused).toMatchObject({ status: 'not-approved' })
    expect(prOf(BRANCH_A).labels).not.toContain('reviewed')
    expect(prOf(BRANCH_A).autoMerge).toBeNull()

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
    const shaC = await ensureChildMandate(C, BRANCH_C, 'c', () =>
      commitAndPush(BRANCH_C, 'feat(c): abandoned (#4)', 'c.txt'),
    )
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
    const stoppedC = drive(['stop', '--ticket', String(C), '--reason', 'review-bound'], RUN_A)
    expect(stoppedC.code, stoppedC.stderr).toBe(0)
    expect(gh(['pr', 'edit', String(openedC.number), '--add-label', 'reviewed']).status).toBe(0)
    const transport = async (_cwd: string, args: string[]) => {
      const result = gh(args)
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    const policy = authorization.policyFromEnv({
      HEAD_AUTH_REPOSITORY_ID: '1',
      HEAD_AUTH_OPERATOR_IDS: '[101]',
      HEAD_AUTH_APP_ID: '200',
      HEAD_AUTH_BOT_USER_ID: '201',
    })
    const auth = { cwd: epic, gh: transport, prNumber: openedC.number, policy }
    const snapshot = await authorization.captureAuthorization(auth)
    await authorization.issueAuthorization({
      ...auth,
      snapshot,
      lane: 'reviewed',
      source: 'native',
      evidence: 'fixture:stale-child-review',
      operationId: 'stale-child-grant',
    })
    expect((await authorization.readAuthorization(auth)).allowed).toBe(true)
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
    expect((await authorization.readAuthorization(auth)).allowed).toBe(false)
    expect(stoppedArms()).toEqual([])
    expect(resumed.step).toMatchObject({ action: 'start', ticket: B, branch: BRANCH_B })
    const childA = { repository: 'acme/app', target: `acme/app#${A}` }
    const reader = await createInstalledUwOperations({
      cwd: epic,
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        const result = moduleGh([...args])
        if (result.status !== 0) throw new Error(`Goal native read failed: ${result.stderr}`)
        return result.stdout
      },
      operator: {
        async executeConfirmed() {
          throw new Error('Read-only goal observation')
        },
      },
    })
    const observedA = await reader.readUw(childA)
    expect(observedA.observation.status).toBe('complete')
    expect(observedA.completion.completions.get(scopeKey(childA))?.state).toBe('complete')
    expect(observedA.graph.nodes.find((node) => node.uw.target === childA.target)?.native.state).toBe('OPEN')
    const mergedA = prOf(BRANCH_A)
    expect(mergedA.state).toBe('MERGED')
    expect(mergedA.mergeCommit?.parents).toHaveLength(2)
    const originMain = git(origin, ['rev-parse', 'refs/heads/main'])
    expect(originMain).toBe(mergedA.mergeCommit?.oid)
    expect(git(origin, ['rev-parse', `${originMain}^2`])).toBe(shaA)
    expect(readSim().issues[String(A)]?.state).toBe('OPEN')
    expect(stoppedArms()).toEqual([])

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

    const shaB = await ensureChildMandate(B, BRANCH_B, 'b', () =>
      commitAndPush(BRANCH_B, 'feat(b): land child (#3)', 'b.txt'),
    )
    markGreen(shaB)
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
    expect(readSim().issues[String(B)]?.state).toBe('OPEN')
    writeSim((state) => {
      const issueB = state.issues[String(B)]
      if (!issueB) throw new Error('missing child B')
      issueB.state = 'CLOSED'
      issueB.stateReason = 'COMPLETED'
      const issue = state.issues[String(C)]
      if (issue) {
        issue.state = 'CLOSED'
        issue.stateReason = 'COMPLETED'
      }
    })
    git(epic, ['fetch', '-q', 'origin', 'main'])
    git(epic, ['switch', '-q', '--detach', 'refs/remotes/origin/main'])
    const parentCwd = epic
    expect(git(parentCwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
    expect(git(origin, ['branch', '--list', 'feature/1-parent'])).toBe('')
    let confirmations = 0
    const makeOperator = () =>
      createOperatorConfirmation({
        agent: { kind: 'main', depth: 0 },
        hasUI: true,
        mode: 'tui',
        ui: operatorDialogUi(async () => {
          confirmations++
          return 'confirm'
        }),
        localProtocolOptions: { getArtifactsDir: () => root },
      } as unknown as ExtensionContext)
    const operations = await createInstalledUwOperations({
      cwd: parentCwd,
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        const result = moduleGh([...args])
        if (result.status !== 0) throw new Error(`Goal native read failed: ${result.stderr}`)
        return result.stdout
      },
      operator: makeOperator(),
    })
    const parent = { repository: 'acme/app', target: `acme/app#${EPIC}` }
    const observedClosed = await operations.readUw(parent)
    expect(observedClosed.observation.status).toBe('complete')
    expect(observedClosed.accepted.status).toBe('accepted')
    const closedChild = observedClosed.graph.nodes.find((node) => node.uw.target === `acme/app#${C}`)
    expect(closedChild?.native).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
    const completion = observedClosed.completion.completions.get(scopeKey(parent))
    expect(completion).toBeDefined()
    expect(completion?.state).not.toBe('complete')
    const abandoned = await operations.abandon({ repository: 'acme/app', target: `acme/app#${C}` })
    expect(abandoned, JSON.stringify(abandoned)).toMatchObject({ status: 'abandoned' })
    expect(confirmations).toBe(1)
    // A separate, explicitly observed GitHub relation change does not itself amend the mandate.
    writeSim((state) => {
      const issue = state.issues[String(EPIC)]
      if (!issue?.subIssues.includes(C)) throw new Error('Missing native child relation to remove')
      issue.subIssues = issue.subIssues.filter((child) => child !== C)
    })
    const detached = await operations.readUw(parent)
    expect(detached.observation.status).toBe('complete')
    expect(detached.graph.nodes.find((node) => node.uw.target === parent.target)?.children).not.toContainEqual({
      repository: parent.repository,
      target: `acme/app#${C}`,
    })
    const detachedCompletion = detached.completion.completions.get(scopeKey(parent))
    expect(detachedCompletion).toBeDefined()
    expect(detachedCompletion?.state).not.toBe('complete')
    // Each confirmed operator command owns a fresh, single-use root command context.
    const coverageOperations = await createInstalledUwOperations({
      cwd: parentCwd,
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        const result = moduleGh([...args])
        if (result.status !== 0) throw new Error(`Goal native read failed: ${result.stderr}`)
        return result.stdout
      },
      operator: makeOperator(),
    })
    const acceptedCoverage = await acceptGoalCoverage(parentCwd, coverageOperations, parent, [
      { repository: parent.repository, target: `acme/app#${A}` },
      { repository: parent.repository, target: `acme/app#${B}` },
    ])
    expect(confirmations).toBe(2)
    expect(acceptedCoverage.accepted.accepted.status).toBe('accepted')
    if (acceptedCoverage.accepted.accepted.status !== 'accepted' || detached.accepted.status !== 'accepted')
      throw new Error('Expected accepted parent material states')
    expect(acceptedCoverage.accepted.accepted.value.ref).toEqual(detached.accepted.value.ref)
    expect(acceptedCoverage.accepted.accepted.value.chain.at(-1)?.source).not.toEqual(
      detached.accepted.value.chain.at(-1)?.source,
    )
    expect(acceptedCoverage.accepted.accepted.value.coverage).toEqual(acceptedCoverage.coverage)
    await seedGoalParentPlan(acceptedCoverage.operations, parentCwd)
    const produced = await integrateGoalParent(
      parentCwd,
      parent,
      [
        { repository: parent.repository, target: `acme/app#${A}` },
        { repository: parent.repository, target: `acme/app#${B}` },
      ],
      acceptedCoverage,
    )
    expect(produced.output.code.base).toBe(produced.output.code.head)
    expect(produced.beforeReview.completion.completions.get(scopeKey(parent))?.state).not.toBe('complete')
    const afterStop = jsonOf(drive(['next'], RUN_B))
    expect(stoppedArms()).toEqual([])
    expect(afterStop.step.action).toBe('final-review')
    expect(afterStop.step.stage).toBe('review')
    const range = `${produced.output.code.base}..${produced.output.code.head}`
    expect(afterStop.step.range).toBe(range)
    expect(range).toMatch(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/)
    expect(range.split('..')[1]).toBe(prOf(BRANCH_B).mergeCommit?.oid)

    const finalReview = await publishGoalParentReview(parent, produced, acceptedCoverage)
    expect(finalReview.range).toBe(range)
    const decisionId = finalReview.decisionId
    const reviewed = drive(['review', '--decision-record', decisionId, '--range', range], RUN_B)
    expect(reviewed.stderr).toBe('')
    expect(reviewed.code).toBe(0)
    expect(events(EPIC)).toContainEqual(
      expect.objectContaining({ event: 'epic-review', run: RUN_A, decisionId, range }),
    )
    const reviewedParent = await acceptedCoverage.operations.readUw(parent)
    expect(reviewedParent.observation.status).toBe('complete')
    expect(reviewedParent.completion.completions.get(scopeKey(parent))?.state).toBe('complete')
    const readyForHook = jsonOf(drive(['next', '--dry-run'], RUN_B))
    expect(readyForHook.step.action).toBe('post-merge')
    expect(stoppedArms()).toEqual([])
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
  }, 180_000)
})
