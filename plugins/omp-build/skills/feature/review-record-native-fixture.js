import { renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../../engine/uw-spec-schema.ts'

export function nativeFeatureSpec(criterion) {
  const canonical = canonicalSpec({
    format: SPEC_CONTENT_FORMAT,
    criteria: [{ id: 'C1', statement: criterion }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
  return renderIssueSpecBody(canonical.value)
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
