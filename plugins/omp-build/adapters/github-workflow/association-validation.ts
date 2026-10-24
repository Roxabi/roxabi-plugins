import { githubScope } from '../github/transport.ts'
import { diagnostic, RECORD_REPOSITORY } from '../github/types.ts'
import { type IssueParentAssociation, type LinkedIssueAssociation, object } from './types.ts'

type PullRequestFacts = { branch: string; base: string; head: string; baseTip: string }

function completeClosingIssueNodes(data: unknown, facts: PullRequestFacts): unknown[] | null {
  const repo = object(object(data)?.repository)
  const pull = object(repo?.pullRequest)
  const closing = object(pull?.closingIssuesReferences)
  const nodes = Array.isArray(closing?.nodes) ? closing.nodes : null
  const totalCount = closing?.totalCount
  if (
    pull === null ||
    closing === null ||
    nodes === null ||
    typeof totalCount !== 'number' ||
    !Number.isSafeInteger(totalCount) ||
    totalCount !== nodes.length ||
    pull.headRefName !== facts.branch ||
    pull.baseRefName !== facts.base ||
    pull.headRefOid !== facts.head ||
    pull.baseRefOid !== facts.baseTip
  ) {
    return null
  }
  return nodes
}

function closingIssueNumbers(nodes: readonly unknown[]): number[] | null {
  const numbers: number[] = []
  for (const node of nodes) {
    const entry = object(node)
    if (entry === null || typeof entry.number !== 'number' || !Number.isSafeInteger(entry.number) || entry.number < 1) {
      return null
    }
    numbers.push(entry.number)
  }
  return numbers
}

export function linkedIssueAssociation(
  data: unknown,
  facts: PullRequestFacts,
  repository: string,
  pr: number,
): LinkedIssueAssociation {
  const nodes = completeClosingIssueNodes(data, facts)
  if (nodes === null) {
    return {
      status: 'incomplete',
      diagnostics: [
        diagnostic('incomplete', `PR #${pr} closing-issue association is incomplete or conflicts with head/base facts`),
      ],
    }
  }
  if (nodes.length > 25) {
    return {
      status: 'incomplete',
      diagnostics: [diagnostic('incomplete', `PR #${pr} has more closing issues than one page can prove`)],
    }
  }
  const numbers = closingIssueNumbers(nodes)
  if (numbers === null) {
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('unreadable', `PR #${pr} closing-issue node is unreadable`)],
    }
  }
  const unique = [...new Set(numbers)]
  if (unique.length === 0) return { status: 'none' }
  if (unique.length > 1) {
    return {
      status: 'ambiguous',
      diagnostics: [diagnostic('ambiguous', `PR #${pr} closes multiple issues`, { numbers: unique })],
    }
  }
  const linked = unique[0]
  return linked === undefined
    ? { status: 'none' }
    : { status: 'linked', scope: githubScope(repository, linked), number: linked }
}

export function issueParentAssociation(data: unknown, number: number): IssueParentAssociation {
  const repo = object(object(data)?.repository)
  const issue = object(repo?.issue)
  if (issue === null || issue.number !== number) {
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('unreadable', `Issue #${number} parent association is unreadable`)],
    }
  }
  if (!('parent' in issue) || issue.parent === null || issue.parent === undefined) return { status: 'none' }

  const parent = object(issue.parent)
  const parentRepo = object(parent?.repository)
  const parentNumber = parent?.number
  const parentRepository = parentRepo?.nameWithOwner
  if (
    parent === null ||
    typeof parentNumber !== 'number' ||
    !Number.isSafeInteger(parentNumber) ||
    parentNumber < 1 ||
    typeof parentRepository !== 'string' ||
    !RECORD_REPOSITORY.test(parentRepository)
  ) {
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('unreadable', `Issue #${number} parent payload is incomplete`)],
    }
  }
  return { status: 'linked', scope: githubScope(parentRepository, parentNumber), number: parentNumber }
}
