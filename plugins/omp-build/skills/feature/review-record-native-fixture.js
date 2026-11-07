import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../../engine/uw-spec-schema.ts'
import { nativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { readFixtureGit } from './review-record-git-fixture.js'

export function nativeFeatureSpec(scope, criterion) {
  const canonical = canonicalSpec({
    format: SPEC_CONTENT_FORMAT,
    criteria: [{ id: 'C1', statement: criterion }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
  const body = renderIssueSpecBody(canonical.value)
  const parsed = parseIssueSpecBody({
    uw: scope,
    raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error('review record fixture Spec is not conformant')
  return { body, ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(scope, parsed.snapshot) }
}

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

function graphConnection(nodes) {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } }
}

export function nativeGraphResponse(args, fixture) {
  const query = args.find((arg) => String(arg).startsWith('query='))
  if (
    typeof query !== 'string' ||
    !query.includes('number title body updatedAt state stateReason repository') ||
    !query.includes('labels(first: 100, after: $labelsCursor)') ||
    !query.includes('subIssues(first: 100, after: $childrenCursor)') ||
    !query.includes('blockedBy(first: 100, after: $blockersCursor)')
  )
    return null
  const number = args.find((arg) => String(arg).startsWith('number='))
  if (number !== `number=${fixture.issue}`) throw new Error(`unexpected native graph issue: ${number}`)
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number: fixture.issue,
          title: 'Save selected region',
          body: fixture.spec,
          updatedAt: '2026-10-21T12:00:00Z',
          state: 'OPEN',
          stateReason: null,
          repository: { nameWithOwner: fixture.repository },
          parent: null,
          labels: graphConnection([{ name: 'size:S' }]),
          subIssues: graphConnection([]),
          blockedBy: graphConnection([]),
        },
      },
    },
  })
}
