'use strict'

const BLOB_QUERY =
  'query($owner:String!,$name:String!,$expression:String!){repository(owner:$owner,name:$name){object(expression:$expression){... on Blob{oid}}}}'
const PULLS_QUERY =
  'query($owner:String!,$name:String!,$cursor:String,$branch:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED],headRefName:$branch){pageInfo{hasNextPage endCursor}nodes{number headRefName baseRefName repository{nameWithOwner}}}}}'
const AUTH_COMMENT_QUERY =
  'query($id: ID!) { node(id: $id) { ... on IssueComment { id fullDatabaseId lastEditedAt repository { fullDatabaseId } pullRequest { fullDatabaseId number } } } }'
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

module.exports = { BLOB_QUERY, PULLS_QUERY, AUTH_COMMENT_QUERY, CI_ROLLUP_QUERY }
