import { diagnostic, GitHubHistoryReadError, type GitHubOptions } from '../github/types.ts'
import { graphql, splitRepository } from '../github-workflow/client.ts'
import { readNativePullRequestFacts } from '../github-workflow/native-facts.ts'
import type { IssueParentAssociation, LinkedIssueAssociation } from '../github-workflow/types.ts'
import { issueParentAssociation, linkedIssueAssociation } from './association-validation.ts'

const CLOSING_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefName
      baseRefName
      headRefOid
      baseRefOid
      closingIssuesReferences(first: 25) { totalCount nodes { number } }
    }
  }
}`
const PARENT_ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number parent { number repository { nameWithOwner } } }
  }
}`

/** Observe native PR→issue association from closingIssuesReferences only. */
export async function readLinkedIssueAssociation(
  repository: string,
  pr: number,
  options: GitHubOptions,
): Promise<LinkedIssueAssociation> {
  try {
    const { owner, name } = splitRepository(repository)
    const pullFacts = await readNativePullRequestFacts(repository, pr, options)
    const data = await graphql(options, CLOSING_ISSUES_QUERY, { owner, name, number: pr })
    return linkedIssueAssociation(data, pullFacts, repository, pr)
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      return { status: 'unreadable', diagnostics: error.diagnostics }
    }
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))],
    }
  }
}

/** Observe native issue parent association for root/child mandate binding. */
export async function readIssueParentAssociation(
  repository: string,
  number: number,
  options: GitHubOptions,
): Promise<IssueParentAssociation> {
  try {
    const { owner, name } = splitRepository(repository)
    const data = await graphql(options, PARENT_ISSUE_QUERY, { owner, name, number })
    return issueParentAssociation(data, number)
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      return { status: 'unreadable', diagnostics: error.diagnostics }
    }
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))],
    }
  }
}
