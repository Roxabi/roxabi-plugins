/**
 * Stateful stand-in for api.github.com plus `gh`, for the filing fence.
 * Triage mutations use fetch (REST and GraphQL), not only `gh`. This process
 * never calls the real network: a non-GitHub URL throws, and GitHub URLs are
 * answered from GITHUB_ISOLATE_STATE.
 *
 * Preload: `bun --preload github-isolate.ts`.
 * CLI: `bun github-isolate.ts --gh <gh argv...>`.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export type IsolateIssue = {
  number: number
  node_id: string
  state: 'OPEN' | 'CLOSED'
  title: string
  body: string
  parent: number | null
  blockedBy: number[]
  labels: string[]
  type: string | null
  comments?: string[]
}

export type IsolateState = {
  next: number
  issues: IsolateIssue[]
  failGraphQL: 'relations' | null
  failView: number[]
  failPatch: boolean
  failCommentsRead?: boolean
  failCommentWrite?: boolean
  concurrentEdit?: { body: string; comment: string }
  log: string[]
}

const TYPES = ['feat', 'fix', 'docs', 'test', 'chore', 'ci', 'perf', 'refactor', 'epic', 'research']

function load(): IsolateState {
  const path = process.env.GITHUB_ISOLATE_STATE
  if (!path) throw new Error('GITHUB_ISOLATE_STATE unset')
  return JSON.parse(readFileSync(path, 'utf8')) as IsolateState
}

function save(state: IsolateState): void {
  const path = process.env.GITHUB_ISOLATE_STATE
  if (!path) throw new Error('GITHUB_ISOLATE_STATE unset')
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, path)
}

function note(state: IsolateState, line: string): void {
  state.log.push(line)
}

function byNumber(state: IsolateState, number: number): IsolateIssue | undefined {
  return state.issues.find((issue) => issue.number === number)
}

function byNode(state: IsolateState, nodeId: string): IsolateIssue | undefined {
  return state.issues.find((issue) => issue.node_id === nodeId)
}

/** Another writer wins immediately before this request mutates the issue. */
function concurrentEdit(state: IsolateState, issue: IsolateIssue): void {
  if (!state.concurrentEdit) return
  issue.body = state.concurrentEdit.body
  issue.comments = [...(issue.comments ?? []), state.concurrentEdit.comment]
  delete state.concurrentEdit
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function readBody(init?: RequestInit): Promise<string> {
  if (!init?.body) return ''
  if (typeof init.body === 'string') return init.body
  return await new Response(init.body).text()
}

function graphql(state: IsolateState, query: string, variables: Record<string, unknown>): Response {
  if (query.includes('issueTypes')) {
    note(state, 'graphql:issueTypes')
    return json(200, {
      data: {
        organization: {
          id: 'ORG',
          issueTypes: {
            nodes: TYPES.map((name) => ({
              id: `TYPE_${name}`,
              name,
              color: 'ededed',
              isEnabled: true,
            })),
          },
        },
      },
    })
  }
  if (query.includes('updateIssueIssueType')) {
    const issue = byNode(state, String(variables.issueId))
    if (!issue) return json(200, { errors: [{ message: 'missing issue' }] })
    issue.type = String(variables.issueTypeId)
    note(state, 'graphql:updateIssueIssueType')
    return json(200, {
      data: {
        updateIssueIssueType: {
          issue: { id: issue.node_id, issueType: { id: issue.type, name: issue.type } },
        },
      },
    })
  }
  if (query.includes('addBlockedBy')) {
    note(state, 'graphql:addBlockedBy')
    if (state.failGraphQL === 'relations') return json(200, { errors: [{ message: 'relation down' }] })
    const issue = byNode(state, String(variables.issueId))
    const blocking = byNode(state, String(variables.blockingId))
    if (!issue || !blocking) return json(200, { errors: [{ message: 'missing issue' }] })
    if (!issue.blockedBy.includes(blocking.number)) issue.blockedBy.push(blocking.number)
    return json(200, {
      data: { addBlockedBy: { issue: { number: issue.number }, blockingIssue: { number: blocking.number } } },
    })
  }
  if (query.includes('addSubIssue')) {
    note(state, 'graphql:addSubIssue')
    if (state.failGraphQL === 'relations') return json(200, { errors: [{ message: 'relation down' }] })
    const parent = byNode(state, String(variables.parentId))
    const child = byNode(state, String(variables.childId))
    if (!parent || !child) return json(200, { errors: [{ message: 'missing issue' }] })
    child.parent = parent.number
    return json(200, {
      data: { addSubIssue: { issue: { number: child.number }, parent: { number: parent.number } } },
    })
  }
  if (query.includes('removeBlockedBy')) {
    note(state, 'graphql:removeBlockedBy')
    return json(200, { data: { removeBlockedBy: { issue: { number: 0 } } } })
  }
  if (query.includes('removeSubIssue')) {
    note(state, 'graphql:removeSubIssue')
    return json(200, { data: { removeSubIssue: { issue: { number: 0 } } } })
  }
  note(state, `graphql:unexpected ${query.slice(0, 80)}`)
  return json(500, { errors: [{ message: 'unexpected graphql' }] })
}

async function handle(url: string, init?: RequestInit): Promise<Response> {
  const state = load()
  const method = (init?.method ?? 'GET').toUpperCase()
  const parsed = new URL(url)
  note(state, `fetch:${method} ${parsed.pathname}`)
  if (parsed.pathname === '/graphql' && method === 'POST') {
    const payload = JSON.parse(await readBody(init)) as { query: string; variables?: Record<string, unknown> }
    const response = graphql(state, payload.query, payload.variables ?? {})
    save(state)
    return response
  }
  const issuePath = parsed.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues(?:\/(\d+))?$/)
  if (!issuePath) {
    save(state)
    return json(500, { message: `unexpected github path ${parsed.pathname}` })
  }
  if (!issuePath[1] && method === 'POST') {
    const payload = JSON.parse(await readBody(init)) as { title?: string; body?: string; labels?: string[] }
    const number = state.next
    state.next += 1
    state.issues.push({
      number,
      node_id: `NODE_${number}`,
      state: 'OPEN',
      title: payload.title ?? '',
      body: payload.body ?? '',
      parent: null,
      blockedBy: [],
      labels: payload.labels ?? [],
      type: null,
    })
    note(state, `rest:POST ${parsed.pathname}`)
    save(state)
    return json(201, {
      html_url: `https://github.com${parsed.pathname}/${number}`,
      number,
      node_id: `NODE_${number}`,
    })
  }
  const number = Number(issuePath[1])
  const issue = byNumber(state, number)
  if (!issue) {
    save(state)
    return json(404, { message: 'not found' })
  }
  if (method === 'GET') {
    save(state)
    return json(200, { node_id: issue.node_id, state: issue.state, body: issue.body, title: issue.title })
  }
  if (method === 'PATCH') {
    if (state.failPatch) {
      note(state, `rest:PATCH-fail ${parsed.pathname}`)
      save(state)
      return json(500, { message: 'patch down' })
    }
    concurrentEdit(state, issue)
    const payload = JSON.parse(await readBody(init)) as { body?: string }
    issue.body = payload.body ?? ''
    note(state, `rest:PATCH ${parsed.pathname}`)
    save(state)
    return json(200, { node_id: issue.node_id, number: issue.number })
  }
  save(state)
  return json(500, { message: `unexpected method ${method}` })
}

function installFetch(): void {
  if (!process.env.GITHUB_ISOLATE_STATE) return
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('https://api.github.com/')) {
        throw new Error(`external network blocked: ${url}`)
      }
      return handle(url, init)
    },
    { preconnect: async () => {} },
  )
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function gh(argv: string[]): number {
  const state = load()
  note(state, `gh:${argv.join(' ')}`)
  save(state)
  if (argv[0] === 'auth' && argv[1] === 'token') {
    process.stdout.write('isolate\n')
    return 0
  }
  if (argv[0] === 'label' && argv[1] === 'list') {
    process.stdout.write('size:S\nsize:F-lite\nsize:F-full\n')
    return 0
  }
  if (argv[0] === 'api' && argv.some((arg) => /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(arg))) {
    const endpoint = argv.find((arg) => arg.startsWith('repos/')) ?? ''
    const issue = byNumber(state, Number(endpoint.split('/')[4]))
    if (!issue || state.failCommentsRead) {
      process.stderr.write('comments unreadable\n')
      return 1
    }
    // gh without --paginate returns only the first page.
    const comments = argv.includes('--paginate') ? (issue.comments ?? []) : (issue.comments ?? []).slice(0, 30)
    process.stdout.write(comments.map((body) => `${body}\n`).join(''))
    return 0
  }
  if (argv[0] === 'issue' && argv[1] === 'comment') {
    const issue = byNumber(state, Number(argv[2]))
    const payload = flag(argv, '--body-file')
    if (!issue || !payload || state.failCommentWrite) {
      process.stderr.write('comment write failed\n')
      return 1
    }
    concurrentEdit(state, issue)
    issue.comments = [...(issue.comments ?? []), readFileSync(payload, 'utf8')]
    note(state, `comment:POST #${issue.number}`)
    save(state)
    process.stdout.write(`https://github.com/Acme/app/issues/${issue.number}#issuecomment-${issue.comments.length}\n`)
    return 0
  }
  if (argv[0] === 'issue' && argv[1] === 'view') {
    const number = Number(argv[2])
    if (state.failView.includes(number)) {
      process.stderr.write(`unreadable #${number}\n`)
      return 1
    }
    const issue = byNumber(state, number)
    if (!issue) {
      process.stderr.write(`issue not found #${number}\n`)
      return 1
    }
    const jq = flag(argv, '--jq') ?? ''
    if (jq.includes('.parent.number')) {
      process.stdout.write(issue.parent === null ? '\n' : `${issue.parent}\n`)
      return 0
    }
    if (jq.includes('.body')) {
      process.stdout.write(`${issue.body}\n`)
      return 0
    }
    if (jq.includes('.state')) {
      process.stdout.write(`${issue.state}\n`)
      return 0
    }
    process.stderr.write(`unexpected jq ${jq}\n`)
    return 1
  }
  if (argv[0] === 'issue' && argv[1] === 'edit') {
    const issue = byNumber(state, Number(argv[2]))
    if (!issue) {
      process.stderr.write('issue not found\n')
      return 1
    }
    const add = flag(argv, '--add-label')
    const remove = flag(argv, '--remove-label')
    if (remove) {
      const drop = new Set(remove.split(','))
      issue.labels = issue.labels.filter((label) => !drop.has(label))
    }
    if (add) {
      for (const label of add.split(',')) {
        if (label && !issue.labels.includes(label)) issue.labels.push(label)
      }
    }
    save(state)
    return 0
  }
  process.stderr.write(`unexpected gh ${argv.join(' ')}\n`)
  return 1
}

installFetch()

if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (argv[0] !== '--gh') {
    process.stderr.write('github-isolate: expected --gh\n')
    process.exit(2)
  }
  process.exit(gh(argv.slice(1)))
}
