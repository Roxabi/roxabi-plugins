import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { reviewGateGraphProgram } from './review-gate-graph-program.ts'

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
  const tooling = JSON.stringify(path.resolve(import.meta.dirname, 'review-gate-tooling-gh.ts'))
  return `#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolingGh } from ${tooling}

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
${reviewGateGraphProgram}

function main() {
  const pinned = toolingGh(argv, process.env.GATE_TOOLS)
  if (pinned !== undefined) {
    save()
    process.stdout.write(pinned)
    return
  }
  if (argv[0] === 'api' && argv[1] === 'user') {
    if (state.installation) fail('gh: Resource not accessible by integration (HTTP 403)')
    if (argv[2] !== '--jq' || argv[3] !== '.login') fail('unexpected gh api user')
    save()
    process.stdout.write('automation\\n')
    return
  }
  if (argv[0] === 'api' && argv[1] === 'graphql') {
    if (!argv.some((value) => value.startsWith('query='))) fail('unexpected gh GraphQL argv')
    const query = argv.find((value) => value.startsWith('query='))
    if (query === 'query=query($owner:String!,$name:String!,$cursor:String,$branch:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED],headRefName:$branch){pageInfo{hasNextPage endCursor}nodes{number headRefName baseRefName repository{nameWithOwner}}}}}') {
      if (graphVariable('owner') !== 'acme' || graphVariable('name') !== 'app' || graphVariable('cursor') !== undefined) fail('unexpected pull enumeration scope or cursor')
      const branch = graphVariable('branch')
      output({ data: { repository: { pullRequests: { nodes: branch === undefined || branch === 'feat/7-fixture' ? [{ number: 7, headRefName: 'feat/7-fixture', baseRefName: 'main', repository: { nameWithOwner: 'acme/app' } }] : [], pageInfo: { hasNextPage: false, endCursor: null } } } } })
      return
    }
    if (isNativeGraphQuery(query)) {
      const number = graphVariable('number')
      if (number === undefined || !/^[1-9]\\d*$/.test(number)) fail('missing native graph issue number')
      output({ data: { repository: { issue: nativeGraphIssue(number) } } })
      return
    }
    if (argv[9] !== 'number=7') fail('unexpected gh GraphQL argv')
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
    const selected = flag('--json')
    if (flag('--repo') !== 'acme/app' || (selected !== 'body,updatedAt,state,labels' && selected !== 'title,body,labels,updatedAt')) fail('unexpected issue view')
    if (argv[2] === '7' && !state.issues?.['7']) {
      output(selected === 'title,body,labels,updatedAt'
        ? { title: 'Feature', body: state.prBody, updatedAt: state.prEditedAt ?? null, labels: [] }
        : { body: state.prBody, updatedAt: state.prEditedAt ?? null, state: 'OPEN', labels: [] })
      return
    }
    const issue = issueOf(argv[2])
    output(selected === 'title,body,labels,updatedAt'
      ? { title: 'Save selected region', body: issue.body, updatedAt: issue.updatedAt ?? null, labels: issue.labels }
      : { body: issue.body, updatedAt: issue.updatedAt ?? null, state: issue.state ?? 'OPEN', labels: issue.labels })
    return
  }
  if (argv[0] === 'api') {
    const endpoint = argv.find((value) => value.startsWith('repos/'))
    const gitCommit = endpoint?.match(/^repos\\/acme\\/app\\/git\\/commits\\/([a-f0-9]{40})$/)
    const gitCompare = endpoint?.match(/^repos\\/acme\\/app\\/compare\\/([a-f0-9]{40})\\.\\.\\.([a-f0-9]{40})\\?per_page=100&page=([1-9][0-9]*)$/)
    if ((gitCommit || gitCompare) && !argv.includes('--method')) {
      const git = (...args) => execFileSync('git', ['-C', process.env.GATE_CANDIDATE, ...args], { encoding: 'utf8' }).trim()
      const commit = (sha) => {
        const [actual, ...parents] = git('rev-list', '--parents', '-n', '1', sha).split(' ')
        if (actual !== sha) fail('unknown commit')
        return { sha: actual, parents: parents.map((parent) => ({ sha: parent })) }
      }
      if (gitCommit) { output(commit(gitCommit[1])); return }
      const base = gitCompare[1], head = gitCompare[2], page = Number(gitCompare[3])
      commit(base); commit(head)
      if (!Number.isSafeInteger(page)) fail('invalid comparison page')
      const ahead = git('rev-list', '--reverse', base + '..' + head).split('\\n').filter(Boolean)
      const behind = git('rev-list', '--count', head + '..' + base)
      const status = ahead.length === 0 ? (behind === '0' ? 'identical' : 'behind') : (behind === '0' ? 'ahead' : 'diverged')
      output({ status, total_commits: ahead.length, commits: ahead.slice((page - 1) * 100, page * 100).map(commit) })
      return
    }
    const pathOnly = endpoint?.split('?')[0] ?? ''
    const match = pathOnly.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)(\\/comments)?$/)
    if (!match) fail('unexpected gh api endpoint')
    const number = match[1]
    const commentsPath = Boolean(match[2])
    if (number === '7' && commentsPath && existsSync(join(process.env.GATE_STATE_DIR ?? '', 'comments.fail'))) process.exit(17)
    if (argv.includes('--method')) {
      if (!commentsPath || argv.length !== 6 || argv[1] !== '--method' || argv[2] !== 'POST' || argv[4] !== '-f') fail('unexpected gh api method')
      const field = argv[5]
      if (!field?.startsWith('body=')) fail('missing comment body')
      const comment = {
        id: state.nextCommentId++,
        body: field.slice('body='.length),
        user: { login: actor() },
        created_at: number === '7' ? '2026-10-21T00:00:00Z' : '2026-10-23T00:00:00Z',
        updated_at: number === '7' ? '2026-10-21T00:00:00Z' : '2026-10-23T00:00:00Z',
      }
      if (number === '7') state.comments.push(comment)
      else issueOf(number).comments.push(comment)
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
  if (argv[0] === 'pr' && argv[1] === 'list') {
    if (flag('--repo') !== 'acme/app' || flag('--state') !== 'all' || flag('--limit') !== '30' ||
        flag('--json') !== 'number,isCrossRepository,state') fail('unexpected gh pr list')
    const matches = flag('--head') === 'feat/7-fixture' && flag('--base') === 'main'
    output(matches ? [{ number: 7, isCrossRepository: false, state: 'OPEN' }] : [])
    return
  }
  if (argv[0] === 'pr' && argv[1] === 'view' && argv[2] === '7') {
    if (repos().some((repo) => repo !== 'acme/app')) fail('unexpected repo')
    const fields = flag('--json')
    if (!fields) fail('missing pr json')
    const source = {
      number: 7,
      state: 'OPEN',
      mergeCommit: null,
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
    const githubApp = argv[2] === 'https://github.com/acme/app' || argv[2] === 'https://github.com/acme/app.git'
    if (selected || originMatch || githubApp) {
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
