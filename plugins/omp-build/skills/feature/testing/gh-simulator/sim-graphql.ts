import { execFileSync } from 'node:child_process'

import { recordedBase, rollupPage, settleAll } from './sim-git.ts'
import { type Comment, fail, fullName, type Issue, type Pull, type State } from './sim-types.ts'

export function prNode(state: State, pr: Pull): Record<string, unknown> {
  return {
    number: pr.number,
    state: pr.state,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    mergedAt: pr.mergedAt,
    isCrossRepository: pr.isCrossRepository,
    mergeCommit: pr.mergeCommit
      ? { oid: pr.mergeCommit.oid, parents: { nodes: [{ oid: pr.mergeCommit.parents[0] }] } }
      : null,
    autoMergeRequest: pr.autoMerge ? { enabledAt: pr.autoMerge.enabledAt } : null,
    labels: { nodes: pr.labels.map((name) => ({ name })) },
    repository: { nameWithOwner: fullName(state) },
  }
}

export function commentNodes(comments: Comment[]): { body: string; author: { login: string } }[] {
  return comments.map((comment) => ({ body: comment.body, author: { login: comment.author } }))
}

export function commentsForNumber(state: State, number: string): Comment[] {
  return state.prs[number]?.comments ?? state.issues[number]?.comments ?? []
}

export function commentThreadForNumber(state: State, number: string): { comments: Comment[] } | undefined {
  return state.prs[number] ?? state.issues[number]
}

function issueNode(state: State, issue: Issue): Record<string, unknown> {
  const linked = Object.values(state.prs).filter(
    (pr) => !pr.isCrossRepository && pr.closes.includes(issue.number) && pr.headRefName.length > 0,
  )
  const merged = linked.filter((pr) => pr.state === 'MERGED')
  const open = linked.filter((pr) => pr.state !== 'MERGED')
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body,
    author: { login: issue.author },
    repository: { nameWithOwner: fullName(state) },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    blockedBy: {
      nodes: issue.blockedBy.map((number) => ({
        number,
        state: state.issues[String(number)]?.state ?? 'OPEN',
        repository: { nameWithOwner: fullName(state) },
      })),
    },
    comments: { nodes: commentNodes(commentsForNumber(state, String(issue.number))) },
    closedByPullRequestsReferences: { nodes: merged.map((pr) => prNode(state, pr)) },
    timelineItems: { nodes: open.map((pr) => ({ source: prNode(state, pr) })) },
  }
}

export type ParsedFlags = {
  positionals: string[]
  flag: Map<string, string[]>
  bool: Set<string>
}

export function flags(argv: string[]): ParsedFlags {
  const positionals: string[] = []
  const flag = new Map<string, string[]>()
  const bool = new Set<string>()
  const takes: Record<string, true> = {
    '--json': true,
    '--jq': true,
    '--method': true,
    '--repo': true,
    '--head': true,
    '--base': true,
    '--state': true,
    '--add-label': true,
    '--remove-label': true,
    '--body': true,
    '--body-file': true,
    '--match-head-commit': true,
    '-f': true,
    '-F': true,
    '-R': true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (takes[arg]) {
      const value = argv[++i]
      if (value === undefined) fail(`gh: ${arg} needs a value\n${argv.join(' ')}`)
      const list = flag.get(arg) ?? []
      list.push(value)
      flag.set(arg, list)
    } else if (arg.startsWith('--')) {
      bool.add(arg)
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flag, bool }
}

export function one(flag: Map<string, string[]>, name: string): string | undefined {
  return flag.get(name)?.at(-1)
}

function statusCheckRollup(state: State, pr: Pull): Record<string, unknown>[] {
  return (state.checks[pr.headRefOid] ?? []).map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    workflowName: check.workflowName,
    startedAt: check.startedAt,
  }))
}

function pullFieldValues(pr: Pull, state: State): Record<string, unknown> {
  return {
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    baseRefName: pr.baseRefName,
    baseRefOid: pr.state === 'MERGED' ? pr.mergeCommit?.parents[0] : recordedBase(state, pr),
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    headRepository: pr.isCrossRepository ? null : { nameWithOwner: fullName(state) },
    isCrossRepository: pr.isCrossRepository,
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit.oid } : null,
    mergeStateStatus: pr.state === 'MERGED' ? 'UNKNOWN' : 'CLEAN',
    autoMergeRequest: pr.autoMerge ? { enabledAt: pr.autoMerge.enabledAt } : null,
    labels: pr.labels.map((name) => ({ name })),
    comments: commentNodes(commentsForNumber(state, String(pr.number))),
    statusCheckRollup: statusCheckRollup(state, pr),
  }
}

function selectedFields(wanted: string[], values: Record<string, unknown>): Record<string, unknown> {
  if (!wanted.length) return values
  const fields: Record<string, unknown> = {}
  for (const key of wanted) fields[key] = values[key] ?? null
  return fields
}

export function fields(flag: Map<string, string[]>, pr: Pull, state: State): Record<string, unknown> {
  return selectedFields((one(flag, '--json') ?? '').split(',').filter(Boolean), pullFieldValues(pr, state))
}

function jq(expression: string, json: string): string {
  return execFileSync('jq', ['-r', expression], { input: json, encoding: 'utf8' })
}

export function emit(value: unknown, expression: string | undefined): void {
  const json = typeof value === 'string' ? value : JSON.stringify(value)
  if (!expression) {
    process.stdout.write(`${json}\n`)
    return
  }
  process.stdout.write(jq(expression, json))
}

export function varsOf(flag: Map<string, string[]>): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const pair of [...(flag.get('-f') ?? []), ...(flag.get('-F') ?? [])]) {
    const at = pair.indexOf('=')
    if (at !== -1) vars[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return vars
}

function ticketNode(number: number, issue: Issue): Record<string, unknown> {
  return {
    number,
    title: issue.title,
    labels: { totalCount: issue.labels.length, nodes: issue.labels.map((label) => ({ name: label })) },
    issueType: issue.issueType ? { name: issue.issueType } : null,
  }
}

function subIssuesResponse(state: State, epic: Issue | undefined, epicNumber: string | undefined): unknown {
  settleAll(state)
  return {
    data: {
      viewer: { login: state.viewer },
      repository: {
        issue: epic
          ? {
              comments: { nodes: commentNodes(commentsForNumber(state, String(epicNumber))) },
              subIssues: {
                pageInfo: { hasNextPage: false },
                nodes: epic.subIssues.map((number) => issueNode(state, state.issues[String(number)] as Issue)),
              },
            }
          : null,
      },
    },
  }
}

function rollupResponse(state: State, query: string, sha: string, after: string | undefined): unknown {
  const page = rollupPage(query, after, state.checks[sha] ?? [], state.ciPageInfo === 'absent')
  return {
    data: {
      repository: {
        object: sha
          ? {
              statusCheckRollup: {
                contexts:
                  page.pageInfo === undefined ? { nodes: page.nodes } : { pageInfo: page.pageInfo, nodes: page.nodes },
              },
            }
          : null,
      },
    },
  }
}

function closingIssuesResponse(state: State, number: string | undefined): unknown {
  const pr = state.prs[String(number)]
  const linked = pr && pr.baseRefName === state.defaultBranch ? pr.closes : []
  const nodes = linked.flatMap((issueNumber) => {
    const issue = state.issues[String(issueNumber)]
    return issue ? [ticketNode(issueNumber, issue)] : []
  })
  return {
    data: {
      repository: {
        pullRequest: pr
          ? { headRefName: pr.headRefName, closingIssuesReferences: { totalCount: nodes.length, nodes } }
          : null,
      },
    },
  }
}

function issueTypeResponse(state: State, query: string, vars: Record<string, string>): unknown | undefined {
  if (!query.includes('issueType') || !/\bissue\(number:/.test(query)) return undefined
  const issue = state.issues[String(vars.number)]
  if (!issue) fail(`GraphQL: Could not resolve to an Issue with the number of ${vars.number}. (repository.issue)`)
  return { data: { repository: { issue: ticketNode(Number(vars.number), issue) } } }
}

function lastEditedResponse(state: State, query: string, vars: Record<string, string>): unknown | undefined {
  if (!query.includes('lastEditedAt')) return undefined
  const pr = state.prs[String(vars.number)]
  return { data: { repository: { pullRequest: pr ? { body: pr.body, lastEditedAt: pr.lastEditedAt ?? null } : null } } }
}

function specialQueryResponse(state: State, query: string, vars: Record<string, string>): unknown | undefined {
  if (query.includes('subIssues')) return subIssuesResponse(state, state.issues[String(vars.epic)], vars.epic)
  if (query.includes('statusCheckRollup')) return rollupResponse(state, query, vars.sha ?? '', vars.after)
  if (query.includes('closingIssuesReferences')) return closingIssuesResponse(state, vars.number)
  return issueTypeResponse(state, query, vars) ?? lastEditedResponse(state, query, vars)
}

function aliasedPullsResponse(state: State, query: string): unknown | undefined {
  const pulls = [...query.matchAll(/(\w+):\s*pullRequest\(number:\s*(\d+)\)/g)]
  if (!pulls.length) return undefined
  settleAll(state)
  const repository: Record<string, unknown> = {}
  for (const match of pulls) {
    const alias = match[1] ?? ''
    const pr = state.prs[match[2] ?? '']
    repository[alias] = pr ? { comments: { nodes: commentNodes(commentsForNumber(state, match[2] ?? '')) } } : null
  }
  return { data: { repository } }
}

export function graphql(state: State, query: string, vars: Record<string, string>): unknown {
  if (vars.owner !== state.owner || vars.name !== state.name) {
    return { data: { repository: null, viewer: { login: state.viewer } } }
  }
  const response = specialQueryResponse(state, query, vars) ?? aliasedPullsResponse(state, query)
  if (response !== undefined) return response
  fail(`gh: unhandled graphql query\n${query}`)
}
