import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { type MandateRecord, recordsOf } from '../engine/workflow-control.ts'
import { graphFromSimulatedIssues } from './criterion-dispositions.ts'
import { produceNativeImplementation } from './native-implementation-producer.ts'
import { withNativeImplementationWorld } from './native-implementation-world.ts'
import { produceNativePlan } from './native-plan-producer.ts'
import { git, type ReviewGateFixture } from './review-gate-fixture.ts'
import { AUTOMATION, PR_EDITED, SCOPE } from './review-gate-gh.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

const ISSUE_SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
const { historyFrom } = roxabiWorkflowFixtures()

export async function nativeMandateRecords(
  fixture: ReviewGateFixture,
  spec: string,
  mandate: MandateRecord,
  plugin: ActionInputs['manifest']['plugin'],
  pullHistory: DecodedHistory,
) {
  const observe = (sha: string) => {
    const [actual, ...parents] = git(fixture.candidate, ['rev-list', '--parents', '-n1', sha]).split(' ')
    if (actual !== sha) throw new Error('Wrong review gate commit')
    return {
      sha,
      parents,
      tree: git(fixture.candidate, ['rev-parse', `${sha}^{tree}`]),
      subject: git(fixture.candidate, ['show', '-s', '--format=%s', sha]),
      paths: git(fixture.candidate, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
        .split('\n')
        .filter(Boolean),
      config: null,
    }
  }
  const graph = graphFromSimulatedIssues(ISSUE_SCOPE, [
    {
      number: 42,
      title: 'Fixture UW',
      body: spec,
      updatedAt: PR_EDITED,
      state: 'OPEN',
      stateReason: null,
      labels: ['size:S'],
      subIssues: [],
      blockedBy: [],
    },
  ])
  const rangeCommits = git(fixture.candidate, ['rev-list', '--reverse', `${fixture.base}..${fixture.head}`])
    .split('\n')
    .filter(Boolean)
  const beforePull = {
    scope: SCOPE,
    branch: 'feat/7-fixture',
    base: 'main',
    head: fixture.base,
    baseTip: fixture.base,
    state: 'OPEN' as const,
    mergeCommit: null,
    author: AUTOMATION,
  }
  const afterPull = { ...beforePull, head: fixture.head }
  const initial = {
    branch: 'feat/7-fixture',
    head: fixture.base,
    base: 'main',
    baseTip: fixture.base,
    remoteTip: fixture.base,
  }
  return withNativeImplementationWorld(
    {
      anchor: ISSUE_SCOPE,
      graph,
      histories: [historyFrom([mandate], AUTOMATION), pullHistory],
      plugin,
      author: AUTOMATION,
      checkout: initial,
      diffs: [],
      pullRequests: [beforePull],
      commits: [observe(fixture.base), ...rangeCommits.map(observe)],
      comparisons: [
        { base: fixture.base, head: fixture.base, status: 'identical', commits: [] },
        {
          base: fixture.base,
          head: fixture.head,
          status: rangeCommits.length ? 'ahead' : 'identical',
          commits: rangeCommits,
        },
      ],
    },
    async (world) => {
      const tree = git(fixture.candidate, ['rev-parse', `${fixture.base}^{tree}`])
      const plan = await produceNativePlan({
        world,
        scope: ISSUE_SCOPE,
        mandate,
        parentScopes: [],
        git: { repository: ISSUE_SCOPE.repository, commit: fixture.base, tree },
        output: {
          steps: [
            {
              id: 'step-1',
              change: 'persist the selected region',
              doneWhen: 'the region survives a reload',
              criterionIds: ['C1'],
              evidence: 'the save test passes',
              paths: ['src/save.ts'],
            },
          ],
          resolutions: [],
        },
        reviews: [
          { outcome: 'clear', blockers: [] },
          { outcome: 'clear', blockers: [] },
        ],
      })
      const headTree = git(fixture.candidate, ['rev-parse', `${fixture.head}^{tree}`])
      const produced = await produceNativeImplementation({
        cwd: world.cwd,
        gh: world.gh,
        git: world.git,
        operations: world.operations,
        read: plan.read,
        scope: ISSUE_SCOPE,
        mandate,
        parents: [],
        startHead: fixture.base,
        command: 'bun test fixture.test.ts',
        output: 'PASS fixture',
        advance() {
          world.checkout({ ...initial, head: fixture.head, remoteTip: fixture.head })
          world.observePullRequest(afterPull)
          return { head: fixture.head, tree: headTree }
        },
      })
      if (!produced.history) throw new Error('Native gate implementation history is unavailable')
      return recordsOf(produced.history)
    },
  )
}
