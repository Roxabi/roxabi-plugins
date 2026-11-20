'use strict'

const BLOB_QUERY =
  'query($owner:String!,$name:String!,$expression:String!){repository(owner:$owner,name:$name){object(expression:$expression){... on Blob{oid}}}}'
const PULLS_QUERY =
  'query($owner:String!,$name:String!,$cursor:String,$branch:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED],headRefName:$branch){pageInfo{hasNextPage endCursor}nodes{number headRefName baseRefName repository{nameWithOwner}}}}}'
const AUTH_COMMENT_QUERY =
  'query($id: ID!) { node(id: $id) { ... on IssueComment { id fullDatabaseId lastEditedAt repository { fullDatabaseId } pullRequest { fullDatabaseId number } } } }'
const PR_BODY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { body lastEditedAt }
  }
}`
const CI_ROLLUP_QUERY = `query($owner: String!, $name: String!, $sha: GitObjectID!, $after: String = null) {
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun { id name status conclusion }
              ... on StatusContext { id context state }
            }
          }
        }
      }
    }
  }
}`

function catalogueQuery(count) {
  const variables = Array.from({ length: count }, (_, index) => `$e${index}:String!`).join(',')
  const fields = Array.from(
    { length: count },
    (_, index) => `f${index}:object(expression:$e${index}){... on Blob{oid byteSize isBinary isTruncated text}}`,
  ).join(' ')
  return `query($owner:String!,$name:String!,${variables}){repository(owner:$owner,name:$name){${fields}}}`
}

const PIN_VECTOR_LIMIT = 32
function pinVectorQuery(count) {
  const variables = Array.from({ length: count }, (_, index) => `$e${index}:String!`).join(',')
  const fields = Array.from(
    { length: count },
    (_, index) => `f${index}:object(expression:$e${index}){... on Blob{oid}}`,
  ).join(' ')
  return `query($owner:String!,$name:String!,${variables}){repository(owner:$owner,name:$name){${fields}}}`
}

module.exports = {
  BLOB_QUERY,
  PULLS_QUERY,
  AUTH_COMMENT_QUERY,
  PR_BODY_QUERY,
  CI_ROLLUP_QUERY,
  catalogueQuery,
  PIN_VECTOR_LIMIT,
  pinVectorQuery,
}
