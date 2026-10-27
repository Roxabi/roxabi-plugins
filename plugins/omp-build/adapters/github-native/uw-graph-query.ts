export const UW_GRAPH_QUERY = `query(
  $owner: String!, $name: String!, $number: Int!,
  $labelsCursor: String, $childrenCursor: String, $blockersCursor: String
) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title body updatedAt state stateReason repository { nameWithOwner }
      parent { number repository { nameWithOwner } }
      labels(first: 100, after: $labelsCursor) { nodes { name } pageInfo { hasNextPage endCursor } }
      subIssues(first: 100, after: $childrenCursor) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage endCursor } }
      blockedBy(first: 100, after: $blockersCursor) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage endCursor } }
    }
  }
}`
