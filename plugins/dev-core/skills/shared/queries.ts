/**
 * All GraphQL query and mutation strings — single source of truth.
 *
 * Mock routing pattern (for tests):
 * Import constants and route via exact match: `if (query === MILESTONE_QUERY)`.
 * Throw explicit error on unexpected queries — no silent {} fallback.
 * This makes query refactors immediately visible in test output.
 */

/** Full issue query with dependencies, sub-issues, and URL (issues dashboard + CLI). */
export const ISSUES_QUERY = `
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            ... on Issue {
              number
              title
              state
              url
              subIssues(first: 50) { nodes { number state title } }
              parent { number state }
              blockedBy(first: 20) { nodes { number state } }
              blocking(first: 20) { nodes { number state } }
            }
          }
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  }
}`

/** Lightweight query for triage — includes item id and body, no deps. */
export const TRIAGE_QUERY = `
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on Issue { number title body state labels(first: 10) { nodes { name } } }
          }
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  }
}`

/** Full list query — includes hierarchy (subIssues, parent) and triage fields. */
export const LIST_QUERY = `
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on Issue {
              number title body state url
              labels(first: 10) { nodes { name } }
              subIssues(first: 50) { nodes { number state title } }
              parent { number state }
            }
          }
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  }
}`

/** Get project item ID for an issue. */
export const ITEM_ID_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 10) {
        nodes { id project { id } }
      }
    }
  }
}`

/** Get parent issue number. */
export const PARENT_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { parent { number } }
  }
}`

export const UPDATE_FIELD_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: {singleSelectOptionId: $optionId}
  }) { projectV2Item { id } }
}`

export const CLEAR_FIELD_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId
  }) { projectV2Item { id } }
}`

export const ADD_TO_PROJECT_MUTATION = `
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}`

export const DELETE_PROJECT_ITEM_MUTATION = `
mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
    deletedItemId
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

/** List all built-in workflows on a project board. */
export const PROJECT_WORKFLOWS_QUERY = `
query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      workflows(first: 20) {
        nodes { id name enabled }
      }
    }
  }
}`

/**
 * Replace single-select options on an existing field.
 * Used to overwrite GitHub's default Status options (Todo/In Progress/Done)
 * with our standard set after project creation.
 */
export const UPDATE_FIELD_OPTIONS_MUTATION = `
mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField { id name options { id name } }
    }
  }
}`

/**
 * Build a batched multi-project query with N aliased node() lookups.
 * Response shape: data.project0, data.project1, ...
 * Variables shape: { project0Id: "PVT_...", project1Id: "PVT_..." }
 *
 * NOTE: Fetches up to 100 items per project. Projects with >100 issues will be
 * silently truncated. Full cursor-based pagination per alias is tracked in issue S5.
 */
export function buildBatchedQuery(projectIds: string[]): string {
  if (projectIds.length === 0) return ''
  const params = projectIds.map((_, i) => `$project${i}Id: ID!`).join(', ')
  const aliases = projectIds
    .map(
      (_, i) => `
    project${i}: node(id: $project${i}Id) {
      ... on ProjectV2 {
        items(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content {
              ... on Issue {
                number title state url
                subIssues(first: 50) { nodes { number state title } }
                parent { number state }
                blockedBy(first: 20) { nodes { number state } }
                blocking(first: 20) { nodes { number state } }
              }
            }
            fieldValues(first: 10) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
              }
            }
          }
        }
      }
    }`,
    )
    .join('')
  return `query(${params}) {${aliases}\n}`
}

/** Link a GitHub Project V2 to a repository (makes it visible via repository.projectsV2). */
export const LINK_PROJECT_TO_REPO_MUTATION = `
mutation($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
    repository { id }
  }
}`

/** Get repository node ID. */
export const REPO_ID_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id }
}`

/** Get a project's title by node ID. */
export const PROJECT_TITLE_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 { title }
  }
}`

/** Build variables object for buildBatchedQuery: { project0Id: "PVT_...", ... } */
export function buildBatchedVariables(projectIds: string[]): Record<string, string> {
  return Object.fromEntries(projectIds.map((id, i) => [`project${i}Id`, id]))
}

/** Fetch all fields (including Status options) for a ProjectV2 node. */
export const PROJECT_FIELDS_QUERY = `
  # projectV2 fields query
  query($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        fields(first: 20) {
          nodes {
            ... on ProjectV2FieldCommon {
              id
              name
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              dataType
              options {
                id
                name
              }
            }
          }
        }
      }
    }
  }
`

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

/** Fetch a repository's default branch name. */
export const REPO_DEFAULT_BRANCH_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef { name }
    }
  }
`

/** Lightweight probe: fetch first item of a ProjectV2 node. */
export const VERIFY_PROJECT_ITEMS_QUERY = `
  # projectV2 item probe
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 1) {
          nodes {
            id
          }
        }
      }
    }
  }
`

export const CREATE_PROJECT_V2_MUTATION = `
mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title }) {
    projectV2 { id number title }
  }
}`

export const CREATE_PROJECT_V2_FIELD_MUTATION = `
mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]) {
  createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType, singleSelectOptions: $singleSelectOptions }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField { id name options { id name } }
      ... on ProjectV2Field { id name }
    }
  }
}`

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

export const ORG_PROJECTS_QUERY = `
query($login: String!, $first: Int!) {
  organization(login: $login) {
    id
    projectsV2(first: $first) { nodes { id number title } }
  }
}`
