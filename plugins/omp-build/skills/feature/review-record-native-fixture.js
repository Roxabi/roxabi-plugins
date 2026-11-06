import { rawSource } from '../../adapters/github-native/uw-spec.ts'
import { nativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { readFixtureGit } from './review-record-git-fixture.js'

/** Produce the linked issue implementation from its actual fixture Git commits. */
export async function linkedImplementation({ scope, body, mandate, plan, author, base, head }) {
  const date = '2026-10-21T12:00:00Z'
  const nativeGraph = {
    status: 'complete',
    root: scope,
    observedAt: date,
    nodes: [
      {
        uw: scope,
        title: 'Save keeps the selected region',
        raw: rawSource(scope.target, body, date),
        updatedAt: date,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [],
        native: { state: 'OPEN', stateReason: null },
      },
    ],
  }
  const observeCommit = (sha) => {
    const [actual, ...parents] = readFixtureGit(['rev-list', '--parents', '-n1', sha]).split(' ')
    if (actual !== sha) throw new Error('Wrong review fixture commit')
    return {
      sha,
      parents,
      tree: readFixtureGit(['rev-parse', `${sha}^{tree}`]),
      subject: readFixtureGit(['show', '-s', '--format=%s', sha]),
      paths: readFixtureGit(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean),
      config: null,
    }
  }
  return nativeImplementationWorld({
    graph: nativeGraph,
    histories: [roxabiWorkflowFixtures().historyFrom(plan, author)],
    scope,
    mandate,
    startHead: base,
    head,
    branch: 'feat/save',
    author,
    baseTip: base,
    remoteTipBefore: base,
    remoteTipAfter: head,
    pullRequestsBefore: [],
    pullRequestsAfter: [],
    comparisons: [],
    commits: [observeCommit(base), observeCommit(head)],
    command: 'bun test review-record.test.ts',
    output: 'PASS review record',
  })
}
