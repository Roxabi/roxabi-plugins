import { nativeComment } from '../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../adapters/github/types.ts'

const repository = 'acme/app'

type Issue = { title: string; body: string; labels: string[]; parent: number | null; blockers: number[] }
type Write = { kind: 'create' | 'patch' | 'labels' | 'comment' | 'sub-issue' | 'blocked-by'; issue: number }
type Fault = (write: Write) => 'reject' | 'lose-response' | null

/** GitHub is the only replaced boundary: issues, comments and native relations behave statefully. */
export function nativeGitHub(seed: Record<number, Partial<Issue>> = {}) {
  const issues = new Map<number, Issue>()
  const comments = new Map<number, ReturnType<typeof nativeComment>[]>()
  for (const [key, value] of Object.entries(seed)) {
    issues.set(Number(key), { title: '', body: '', labels: [], parent: null, blockers: [], ...value })
    comments.set(Number(key), [])
  }
  const writes: Write[] = []
  let fault: Fault = () => null
  let nextIssue = 50
  let nextComment = 100
  const known = (number: number): Issue => {
    const issue = issues.get(number)
    if (!issue) throw new Error(`unknown issue ${number}`)
    return issue
  }
  const field = (args: readonly string[], name: string) =>
    args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  const mutate = (write: Write, apply: () => string): string => {
    const injected = fault(write)
    writes.push(write)
    if (injected === 'reject') throw new Error(`GitHub rejected ${write.kind}`)
    const output = apply()
    if (injected === 'lose-response') throw new Error(`GitHub response lost after ${write.kind}`)
    return output
  }
  const ref = (number: number) => ({ number, repository: { nameWithOwner: repository } })
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  const graphql = (args: readonly string[]): string => {
    const query = field(args, 'query') ?? ''
    if (query.includes('removeSubIssue') || query.includes('removeBlockedBy'))
      throw new Error('unexpected relation removal')
    if (query.includes('addSubIssue')) {
      const parent = Number(field(args, 'parentId')?.slice(5))
      const child = Number(field(args, 'childId')?.slice(5))
      return mutate({ kind: 'sub-issue', issue: parent }, () => {
        known(parent)
        known(child).parent = parent
        return JSON.stringify({ data: { addSubIssue: {} } })
      })
    }
    if (query.includes('addBlockedBy')) {
      const dependent = Number(field(args, 'issueId')?.slice(5))
      const blocker = Number(field(args, 'blockingId')?.slice(5))
      return mutate({ kind: 'blocked-by', issue: dependent }, () => {
        known(blocker)
        known(dependent).blockers.push(blocker)
        return JSON.stringify({ data: { addBlockedBy: {} } })
      })
    }
    if (query.includes('pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED],headRefName:$branch)'))
      return JSON.stringify({ data: { repository: { pullRequests: page([]) } } })
    const number = Number(field(args, 'number'))
    const issue = known(number)
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            number,
            title: issue.title,
            body: issue.body,
            updatedAt: '2026-10-27T12:00:00Z',
            state: 'OPEN',
            stateReason: null,
            repository: { nameWithOwner: repository },
            parent: issue.parent === null ? null : ref(issue.parent),
            labels: page(issue.labels.map((name) => ({ name }))),
            subIssues: page([...issues].filter(([, value]) => value.parent === number).map(([child]) => ref(child))),
            blockedBy: page(issue.blockers.map(ref)),
          },
        },
      },
    })
  }
  const commentRequest = (number: number, args: readonly string[], pageNumber: number): string => {
    const list = comments.get(number)
    if (!list) throw new Error(`unknown comment scope ${number}`)
    if (!args.includes('POST')) return JSON.stringify(list.slice((pageNumber - 1) * 100, pageNumber * 100))
    const body = field(args, 'body')
    if (body === undefined) throw new Error('missing comment body')
    return mutate({ kind: 'comment', issue: number }, () => {
      const item = nativeComment(++nextComment, body)
      list.push(item)
      return JSON.stringify(item)
    })
  }
  const create = (args: readonly string[]): string =>
    mutate({ kind: 'create', issue: nextIssue + 1 }, () => {
      const number = ++nextIssue
      issues.set(number, {
        title: field(args, 'title') ?? '',
        body: field(args, 'body') ?? '',
        labels: [],
        parent: null,
        blockers: [],
      })
      comments.set(number, [])
      return String(number)
    })
  const patch = (number: number, args: readonly string[]): string =>
    mutate({ kind: 'patch', issue: number }, () => {
      const issue = known(number)
      const title = field(args, 'title')
      const body = field(args, 'body')
      if (title !== undefined) issue.title = title
      if (body !== undefined) issue.body = body
      return '{}'
    })
  const labels = (args: readonly string[]): string => {
    const number = Number(args[2])
    return mutate({ kind: 'labels', issue: number }, () => {
      const issue = known(number)
      const list = (flag: string) => {
        const index = args.indexOf(flag)
        return index < 0 ? [] : (args[index + 1] ?? '').split(',')
      }
      const remove = list('--remove-label')
      issue.labels = [...new Set([...issue.labels.filter((label) => !remove.includes(label)), ...list('--add-label')])]
      return ''
    })
  }
  const issueView = (number: number): string => {
    const value = known(number)
    return JSON.stringify({
      ...value,
      labels: value.labels.map((name) => ({ name })),
      updatedAt: '2026-10-27T12:00:00Z',
      state: 'OPEN',
    })
  }
  const apiRequest = (args: string[]): string => {
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    const comment = /^repos\/acme\/app\/issues\/(\d+)\/comments(?:\?per_page=100&page=(\d+))?$/.exec(endpoint)
    if (comment) return commentRequest(Number(comment[1]), args, Number(comment[2] ?? 1))
    if (endpoint === 'repos/acme/app/issues' && args.includes('POST')) return create(args)
    const issue = /^repos\/acme\/app\/issues\/(\d+)$/.exec(endpoint)
    if (issue && args.includes('PATCH')) return patch(Number(issue[1]), args)
    if (issue && args.includes('.node_id')) {
      known(Number(issue[1]))
      return `node-${issue[1]}`
    }
    if (issue) {
      const number = Number(issue[1])
      const value = known(number)
      return JSON.stringify({
        number,
        title: value.title,
        body: value.body,
        state: 'open',
        user: { login: 'automation' },
      })
    }
    throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
  }
  const gh: Gh = async (_cwd, args) => {
    if (args[0] === 'api' && args[1] === 'user') return 'automation'
    if (args[0] === 'issue' && args[1] === 'edit') return labels(args)
    if (args[0] === 'issue' && args[1] === 'view') return issueView(Number(args[2]))
    if (args[0] === 'api' && args[1] === 'graphql') return graphql(args)
    return apiRequest(args)
  }
  return {
    gh,
    issues,
    comments,
    writes,
    count: (kind: Write['kind']) => writes.filter((write) => write.kind === kind).length,
    injectFault(next: Fault) {
      fault = next
    },
  }
}
