import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type StoredComment = {
  id: number
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}

export type IssueState = {
  body: string
  updatedAt: string | null
  state: string
  labels: { name: string }[]
  comments: StoredComment[]
}

export type ReviewGateState = {
  head: string
  base: string
  ci: { status: string; conclusion: string }
  comments: StoredComment[]
  calls: string[][]
  nextCommentId: number
  prBody: string
  prEditedAt: string | null
  issues: Record<string, IssueState>
  installation?: boolean
  origin?: string
}

export const SCOPE = { repository: 'acme/app', target: 'acme/app#7' }
export const AUTOMATION = 'automation'
export const STOP_BOT = 'github-actions[bot]'
export const GITHUB_ENV = ['GITHUB', 'TOKEN'].join('_')
export const STOP_ENV = ['STOP', 'GH', 'TOKEN'].join('_')
export const PR_TEXT = 'Ship the selected region\n'
export const PR_EDITED = '2026-10-21T00:00:00Z'

export function fakeGhProgram(): string {
  return `#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const path = process.env.GATE_STATE
if (!path) throw new Error('GATE_STATE is required')
const state = JSON.parse(readFileSync(path, 'utf8'))
const argv = process.argv.slice(2)
const githubEnv = ['GITHUB', 'TOKEN'].join('_')
const stopEnv = ['STOP', 'GH', 'TOKEN'].join('_')
state.calls.push(argv)

function save() {
  writeFileSync(path, JSON.stringify(state, null, 2))
}
function output(value) {
  save()
  process.stdout.write(JSON.stringify(value) + '\\n')
}
function fail(message) {
  save()
  process.stderr.write(message + '\\n')
  process.exit(9)
}
function actor() {
  return process.env[githubEnv] === process.env[stopEnv] ? 'github-actions[bot]' : 'automation'
}
function flag(name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
function repos() {
  const found = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--repo') found.push(argv[i + 1])
  return found
}
function issueOf(number) {
  const issue = state.issues?.[number]
  if (!issue) fail('missing issue ' + number)
  return issue
}
function main() {
  if (argv[0] === 'api' && argv[1] === 'user') {
    if (state.installation) fail('gh: Resource not accessible by integration (HTTP 403)')
    if (argv[2] !== '--jq' || argv[3] !== '.login') fail('unexpected gh api user')
    save()
    process.stdout.write('automation\\n')
    return
  }
  if (argv[0] === 'api' && argv[1] === 'graphql') {
    if (argv[9] !== 'number=7' || !argv.some((value) => value.startsWith('query='))) fail('unexpected gh GraphQL argv')
    const query = argv.find((value) => value.startsWith('query='))
    if (query.includes('issue(number: $number)')) {
      output({ data: { repository: { issue: { number: 7, title: 'Feature', labels: { totalCount: 0, nodes: [] }, issueType: { name: 'Feature' } } } } })
      return
    }
    if (!query.includes('pullRequest(number: $number)')) fail('unexpected GraphQL operation')
    output({
      data: {
        repository: {
          pullRequest: {
            headRefName: 'feat/7-fixture',
            body: state.prBody,
            lastEditedAt: state.prEditedAt,
            closingIssuesReferences: { nodes: [], totalCount: 0 },
          },
        },
      },
    })
    return
  }
  if (argv[0] === 'issue' && argv[1] === 'view') {
    if (flag('--repo') !== 'acme/app' || flag('--json') !== 'body,updatedAt,state,labels') fail('unexpected issue view')
    if (argv[2] === '7' && !state.issues?.['7']) {
      output({ body: state.prBody, updatedAt: state.prEditedAt ?? null, state: 'OPEN', labels: [] })
      return
    }
    const issue = issueOf(argv[2])
    output({ body: issue.body, updatedAt: issue.updatedAt ?? null, state: issue.state ?? 'OPEN', labels: issue.labels })
    return
  }
  if (argv[0] === 'api') {
    const endpoint = argv.find((value) => value.startsWith('repos/'))
    const pathOnly = endpoint?.split('?')[0] ?? ''
    const match = pathOnly.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)(\\/comments)?$/)
    if (!match) fail('unexpected gh api endpoint')
    const number = match[1]
    const commentsPath = Boolean(match[2])
    if (number === '7' && commentsPath && existsSync(join(process.env.GATE_STATE_DIR ?? '', 'comments.fail'))) process.exit(17)
    if (argv.includes('--method')) {
      if (number !== '7' || argv.length !== 6 || argv[1] !== '--method' || argv[2] !== 'POST' || argv[4] !== '-f') fail('unexpected gh api method')
      const field = argv[5]
      if (!field?.startsWith('body=')) fail('missing comment body')
      const comment = {
        id: state.nextCommentId++,
        body: field.slice('body='.length),
        user: { login: actor() },
        created_at: '2026-10-21T00:00:00Z',
        updated_at: '2026-10-21T00:00:00Z',
      }
      state.comments.push(comment)
      output(comment)
      return
    }
    if (commentsPath) {
      const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page') ?? '1')
      if (!Number.isSafeInteger(page) || page < 1) fail('invalid comment page')
      const comments = number === '7' ? state.comments : issueOf(number).comments
      output(comments.slice((page - 1) * 100, page * 100))
      return
    }
    if (number === '7') {
      output({
        number: 7,
        body: state.prBody,
        state: 'open',
        user: { login: actor() },
        comments: state.comments.map((comment) => ({ body: comment.body, user: comment.user })),
      })
      return
    }
    const issue = issueOf(number)
    output({
      number: Number(number),
      body: issue.body,
      state: String(issue.state ?? 'OPEN').toLowerCase(),
      user: { login: actor() },
      comments: issue.comments.map((comment) => ({ body: comment.body, user: comment.user })),
    })
    return
  }
  if (argv[0] === 'pr' && argv[1] === 'view' && argv[2] === '7') {
    if (repos().some((repo) => repo !== 'acme/app')) fail('unexpected repo')
    const fields = flag('--json')
    if (!fields) fail('missing pr json')
    const source = {
      number: 7,
      state: 'OPEN',
      headRefOid: state.head,
      headRefName: 'feat/7-fixture',
      baseRefName: 'main',
      baseRefOid: state.base,
      author: { login: 'automation' },
      body: state.prBody,
      statusCheckRollup: [{ name: 'CI', status: state.ci.status, conclusion: state.ci.conclusion }],
    }
    const picked = {}
    for (const field of fields.split(',')) {
      if (!Object.hasOwn(source, field)) fail('unexpected gh pr view fields')
      picked[field] = source[field]
    }
    output(picked)
    return
  }
  if (argv[0] === 'repo' && argv[1] === 'view') {
    if (argv.length !== 5 || argv[3] !== '--json' || argv[4] !== 'nameWithOwner') fail('unscoped gh repo view')
    const selected = argv[2] === 'acme/app'
    let originMatch = false
    if (typeof state.origin === 'string' && typeof argv[2] === 'string' && argv[2] !== 'acme/app') {
      try {
        originMatch = realpathSync(argv[2]) === realpathSync(state.origin)
      } catch {
        originMatch = argv[2] === state.origin
      }
    }
    if (selected || originMatch) {
      output({ nameWithOwner: 'acme/app' })
      return
    }
    fail('unscoped gh repo view')
  }
  fail('unexpected gh argv: ' + JSON.stringify(argv))
}
main()
`
}

export function installFakeGh(bin: string): void {
  const gh = path.join(bin, 'gh')
  writeFileSync(gh, fakeGhProgram())
  chmodSync(gh, 0o755)
}
