/**
 * All GraphQL query and mutation strings — single source of truth.
 *
 * Mock routing pattern (for tests):
 * Import constants and route via exact match: `if (query === MILESTONE_QUERY)`.
 * Throw explicit error on unexpected queries — no silent {} fallback.
 * This makes query refactors immediately visible in test output.
 */

/** Get parent issue number. */
export const PARENT_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { parent { number } }
  }
}`

export const ADD_BLOCKED_BY_MUTATION = `
mutation($issueId: ID!, $blockingId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingId }) {
    issue { number } blockingIssue { number }
  }
}`

export const REMOVE_BLOCKED_BY_MUTATION = `
mutation($issueId: ID!, $blockingId: ID!) {
  removeBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingId }) {
    issue { number } blockingIssue { number }
  }
}`

/** Open PRs with CI checks — used by dashboard. */
export const PRS_QUERY = `
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 50, states: OPEN) {
      nodes {
        number
        title
        headRefName
        state
        isDraft
        url
        author { login }
        updatedAt
        additions
        deletions
        reviewDecision
        labels(first: 10) { nodes { name } }
        mergeable
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 50) {
                  nodes {
                    ... on CheckRun {
                      __typename
                      name
                      status
                      conclusion
                      detailsUrl
                    }
                    ... on StatusContext {
                      __typename
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`

/** CI status for main/master and staging branches — used by dashboard. */
export const BRANCH_CI_QUERY = `
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    main: ref(qualifiedName: "refs/heads/main") { ...BranchCI }
    master: ref(qualifiedName: "refs/heads/master") { ...BranchCI }
    staging: ref(qualifiedName: "refs/heads/staging") { ...BranchCI }
  }
}
fragment BranchCI on Ref {
  name
  target {
    ... on Commit {
      oid
      messageHeadline
      committedDate
      statusCheckRollup {
        state
        contexts(first: 50) {
          nodes {
            ... on CheckRun {
              __typename name status conclusion detailsUrl
            }
            ... on StatusContext {
              __typename context state targetUrl
            }
          }
        }
      }
    }
  }
}`

export const ADD_SUB_ISSUE_MUTATION = `
mutation($parentId: ID!, $childId: ID!) {
  addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
    issue { number } subIssue { number }
  }
}`

export const REMOVE_SUB_ISSUE_MUTATION = `
mutation($parentId: ID!, $childId: ID!) {
  removeSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
    issue { number } subIssue { number }
  }
}`

/** Get repository node ID. */
export const REPO_ID_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id }
}`

/** Fetch milestones for a repository. */
export const MILESTONE_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      milestones(first: 50, states: OPEN) {
        nodes {
          id
          title
        }
      }
    }
  }
`

export const CREATE_ISSUE_TYPE_MUTATION = `
mutation($ownerId: ID!, $name: String!, $description: String, $color: IssueTypeColor!, $isEnabled: Boolean!) {
  createIssueType(input: { ownerId: $ownerId, name: $name, description: $description, color: $color, isEnabled: $isEnabled }) {
    issueType { id name color isEnabled }
  }
}`

export const UPDATE_ISSUE_TYPE_MUTATION = `
mutation($issueTypeId: ID!, $name: String, $description: String, $color: IssueTypeColor, $isEnabled: Boolean) {
  updateIssueType(input: { issueTypeId: $issueTypeId, name: $name, description: $description, color: $color, isEnabled: $isEnabled }) {
    issueType { id name color isEnabled }
  }
}`

export const UPDATE_ISSUE_ISSUE_TYPE_MUTATION = `
mutation($issueId: ID!, $issueTypeId: ID) {
  updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $issueTypeId }) {
    issue { id issueType { id name } }
  }
}`

export const ORG_ISSUE_TYPES_QUERY = `
query($login: String!) {
  organization(login: $login) {
    id
    issueTypes(first: 50) { nodes { id name color isEnabled } }
  }
}`
