// Embedded in the fake gh process so graph reads share its state and failure handling.
export const reviewGateGraphProgram = `
function graphConnection(nodes) {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } }
}
function graphVariable(name) {
  const entry = argv.find((value) => value.startsWith(name + '='))
  return entry === undefined ? undefined : entry.slice(name.length + 1)
}
function nativeGraphIssue(number) {
  const issue = issueOf(number)
  return {
    number: Number(number),
    title: number === '7' ? 'Feature' : 'Save selected region',
    body: issue.body,
    updatedAt: issue.updatedAt,
    state: issue.state,
    stateReason: null,
    repository: { nameWithOwner: 'acme/app' },
    parent: null,
    labels: graphConnection(issue.labels.map((label) => ({ name: label.name }))),
    subIssues: graphConnection([]),
    blockedBy: graphConnection([]),
  }
}
function isNativeGraphQuery(query) {
  return (
    query.includes('number title body updatedAt state stateReason repository') &&
    query.includes('labels(first: 100, after: $labelsCursor)') &&
    query.includes('subIssues(first: 100, after: $childrenCursor)') &&
    query.includes('blockedBy(first: 100, after: $blockersCursor)')
  )
}
`
