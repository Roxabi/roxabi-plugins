import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shippedProductVersion } from '../contracts.ts'
import { decodeHistory, githubScope, readGitHubHistory } from '../dist/contracts.js'
import { buildRecord } from '../engine/core.ts'
import { specDigest } from '../engine/schemas.ts'
import {
  configPinDigest,
  effectiveWorkflowConfig,
  readProofConfigPins,
  WORKFLOW_CONFIG_VERSION,
} from '../roxabi/workflow-config.ts'
import { hashReviewInput } from '../skills/feature/proof.ts'
import { confirmedReviewSemanticContext } from '../skills/feature/workflow.js'
import { encodedAdmissionReviewGraph } from '../testing/records.ts'
import { framedBodies, historyFrom, workflowBinding } from '../testing/workflow-records.ts'

const PLUGIN = path.resolve(import.meta.dirname, '..')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const SCOPE = { repository: 'acme/app', target: 'acme/app#7' }
const AUTOMATION = 'automation'
const STOP_BOT = 'github-actions[bot]'
const GITHUB_ENV = ['GITHUB', 'TOKEN'].join('_')
const STOP_ENV = ['STOP', 'GH', 'TOKEN'].join('_')

type StoredComment = {
  id: number
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}
type IssueState = {
  body: string
  updatedAt: string | null
  /** Native issue state projected by `gh issue view`; unknown/missing refuses Spec reads. */
  state: string
  labels: { name: string }[]
  comments: StoredComment[]
}
type State = {
  head: string
  base: string
  ci: { status: string; conclusion: string }
  comments: StoredComment[]
  calls: string[][]
  nextCommentId: number
  prBody: string
  prEditedAt: string | null
  issues: Record<string, IssueState>
  /** Local bare origin path mapped to the selected repository for URL rewrite. */
  origin?: string
}
type Box = {
  root: string
  tools: string
  candidate: string
  state: string
  stateDir: string
  env: NodeJS.ProcessEnv
  base: string
  head: string
  pin: string
}

let box: Box | undefined
afterEach(() => {
  if (box) rmSync(box.root, { recursive: true, force: true })
  box = undefined
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function fakeGh(): string {
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
    // Shared GH number namespace: branch feat/7-fixture discovers #7; the pull is
    // readable here without a separate issues['7'] seed (standalone discovery only).
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
    // PR #7 is also addressable via the issues REST API (shared number namespace).
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
    // Selected repository, or bare-origin get-url path rewritten to the same owner/name.
    // realpath-match absorbs get-url path expansion; product identity check stays strict.
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

function setup(): Box {
  const root = mkdtempSync(path.join(tmpdir(), 'omp-review-gate-'))
  const tools = path.join(root, 'tools')
  const candidate = path.join(root, 'candidate')
  const stateDir = path.join(root, 'state')
  const state = path.join(stateDir, 'github.json')
  const bin = path.join(root, 'bin')
  mkdirSync(stateDir)
  mkdirSync(bin)
  mkdirSync(path.join(tools, 'plugins'), { recursive: true })
  cpSync(PLUGIN, path.join(tools, 'plugins/omp-build'), { recursive: true })
  git(tools, ['init', '-q', '-b', 'main'])
  git(tools, ['add', '.'])
  git(tools, ['commit', '-qm', 'trusted tooling'])
  git(tools, ['remote', 'add', 'origin', 'https://github.com/Roxabi/roxabi-plugins'])
  const pin = git(tools, ['rev-parse', 'HEAD'])

  git(root, ['init', '-q', '-b', 'main', candidate])
  writeFileSync(path.join(candidate, 'base.txt'), 'base\n')
  writeFileSync(path.join(candidate, 'assertledger.config.json'), '{"adapter":{}}\n')
  git(candidate, ['add', '.'])
  git(candidate, ['commit', '-qm', 'base'])
  const base = git(candidate, ['rev-parse', 'HEAD'])
  writeFileSync(path.join(candidate, 'candidate.txt'), 'candidate\n')
  git(candidate, ['add', '.'])
  git(candidate, ['commit', '-qm', 'candidate'])
  const head = git(candidate, ['rev-parse', 'HEAD'])

  writeFileSync(path.join(bin, 'gh'), fakeGh())
  chmodSync(path.join(bin, 'gh'), 0o755)
  writeFileSync(
    state,
    JSON.stringify(
      {
        head,
        base,
        ci: { status: 'COMPLETED', conclusion: 'SUCCESS' },
        comments: [],
        calls: [],
        nextCommentId: 1,
        prBody: 'Ship the selected region\\n',
        prEditedAt: '2026-10-21T00:00:00Z',
        issues: {},
      } satisfies State,
      null,
      2,
    ),
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GATE_STATE: state,
    GATE_STATE_DIR: stateDir,
  }
  env[GITHUB_ENV] = AUTOMATION
  env[STOP_ENV] = 'stop'
  box = { root, tools, candidate, state, stateDir, base, head, pin, env }
  // Candidate checkouts always have an origin; gate fetches the selected base tip from it.
  attachBareOriginAtBase(box)
  return box
}

function readState(box: Box): State {
  return JSON.parse(readFileSync(box.state, 'utf8')) as State
}

function writeState(box: Box, state: State): void {
  writeFileSync(box.state, JSON.stringify(state, null, 2))
}

function cleanReview(head: string, prefix: string, input: string | null = null): string[] {
  return encodedAdmissionReviewGraph({ scope: SCOPE, head, input, prefix }).comments.map((comment) => comment.body)
}

function approvals(head: string, input: string | null = null): string[] {
  return ['one', 'two', 'three'].flatMap((prefix) => cleanReview(head, prefix, input))
}

function runGate(box: Box, head = box.head) {
  return spawnSync(
    REAL_BUN,
    [
      path.join(box.tools, 'plugins/omp-build/scripts/review-gate.ts'),
      '--repository',
      SCOPE.repository,
      '--pr',
      '7',
      '--head',
      head,
      '--automation-login',
      AUTOMATION,
      '--candidate-cwd',
      box.candidate,
      '--tooling-sha',
      box.pin,
    ],
    { cwd: box.tools, env: box.env, encoding: 'utf8' },
  )
}

function runStop(
  box: Box,
  observation: {
    ok: false
    allowed: false
    reason: 'ci-failed'
    detail: { reviewId: string; detail: { reviews: number; ci: 'red' } }
  },
  head = box.head,
) {
  const observationFile = path.join(box.root, 'observation.json')
  writeFileSync(observationFile, JSON.stringify(observation))
  return spawnSync(
    REAL_BUN,
    [
      path.join(box.tools, 'plugins/omp-build/scripts/review-stop.ts'),
      '--repository',
      SCOPE.repository,
      '--pr',
      '7',
      '--head',
      head,
      '--automation-login',
      AUTOMATION,
      '--run-id',
      'run-84',
      '--observation',
      observationFile,
    ],
    { cwd: box.tools, env: box.env, encoding: 'utf8' },
  )
}
function recordKind(body: string): string | null {
  const framed = /^<!-- omp-build-record v=1 kind=([a-z][a-z0-9-]*) /.exec(body)
  if (framed?.[1]) return framed[1]
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed) || typeof parsed.kind !== 'string') return null
    return parsed.kind
  } catch {
    return null
  }
}

function publish(box: Box, bodies: string[], conclusion: string, status = 'COMPLETED', padding = 0): void {
  const state = readState(box)
  const kept = state.comments.filter((comment) => recordKind(comment.body) === 'workflow-binding')
  state.comments = [
    ...Array.from(
      { length: padding },
      (_, index): StoredComment => ({
        id: index + 1,
        body: `unrelated pagination comment ${index + 1}`,
        user: { login: AUTOMATION },
        created_at: '2026-10-21T00:00:00Z',
        updated_at: '2026-10-21T00:00:00Z',
      }),
    ),
    ...bodies.map(
      (body, index): StoredComment => ({
        id: index + padding + 1,
        body,
        user: { login: AUTOMATION },
        created_at: '2026-10-21T00:00:00Z',
        updated_at: '2026-10-21T00:00:00Z',
      }),
    ),
    ...kept,
  ]
  state.nextCommentId = Math.max(state.nextCommentId, ...state.comments.map((comment) => comment.id)) + 1
  state.ci = { status, conclusion }
  state.calls = []
  writeState(box, state)
}

function capturedCiFailure(reviewId = 'three-final') {
  return {
    ok: false as const,
    allowed: false as const,
    reason: 'ci-failed' as const,
    detail: { reviewId, detail: { reviews: 3, ci: 'red' as const } },
  }
}

function postCalls(box: Box): string[][] {
  return readState(box).calls.filter((argv) => argv[0] === 'api' && argv.includes('--method'))
}

async function readExternalHistory(box: Box) {
  return decodeHistory(
    await readGitHubHistory(githubScope(SCOPE.repository, 7), {
      cwd: box.tools,
      readAuthor: AUTOMATION,
      stopAuthor: STOP_BOT,
      gh: async (_cwd, args) => {
        const result = spawnSync('gh', args, { cwd: _cwd, env: box.env, encoding: 'utf8' })
        if (result.status !== 0) throw new Error(String(result.stderr || result.stdout))
        return String(result.stdout).trim()
      },
    }),
  )
}

const SPEC = '## Acceptance\n- [ ] Save keeps the selected region'
const PR_TEXT = 'Ship the selected region\n'
const PR_EDITED = '2026-10-21T00:00:00Z'

async function gitResult(cwd: string, args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function gateGh(box: Box) {
  return async (_cwd: string, args: string[]) => {
    // Mirror review-gate.ts: pin the explicit target; never discover from tooling cwd.
    const targetArgs =
      args[0] === 'pr'
        ? [...args, '--repo', SCOPE.repository]
        : args[0] === 'repo' && args[1] === 'view' && args[2]?.startsWith('--')
          ? ['repo', 'view', SCOPE.repository, ...args.slice(2)]
          : args
    const result = spawnSync('gh', targetArgs, { cwd: box.tools, env: box.env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout))
    return String(result.stdout).trim()
  }
}

function stored(body: string, id: number): StoredComment {
  return { id, body, user: { login: AUTOMATION }, created_at: PR_EDITED, updated_at: PR_EDITED }
}

async function seedMandate(box: Box, spec = SPEC): Promise<void> {
  const pins = await readProofConfigPins(gitResult, box.candidate, box.base)
  const productVersion = shippedProductVersion()
  const effective = effectiveWorkflowConfig(productVersion, [])
  const built = buildRecord({
    version: 1,
    recordId: 'mandate-feature-1',
    runId: 'run00001',
    operationId: 'op-mandate-feature-1',
    repository: 'acme/app',
    target: 'acme/app#42',
    kind: 'mandate',
    payload: {
      role: 'feature',
      run: null,
      children: null,
      branch: 'feat/7-fixture',
      base: 'main',
      lineageHead: box.head,
      config: {
        productVersion,
        version: WORKFLOW_CONFIG_VERSION,
        digest: configPinDigest(effective),
        effective,
      },
      proofPins: pins,
      parent: null,
      antecedent: null,
      spec: { reference: 'acme/app#42', body: spec, bodySha256: specDigest(spec), lastEditedAt: PR_EDITED },
      permissions: { landing: true, correct: true },
    },
  })
  if (!built.ok) throw new Error(built.diagnostics.map((item) => item.message).join('; '))
  const binding = workflowBinding(
    { repository: 'acme/app', target: 'acme/app#7' },
    built.value,
    'feat/7-fixture',
    'main',
  )
  const state = readState(box)
  state.prBody = PR_TEXT
  state.prEditedAt = PR_EDITED
  state.issues['42'] = {
    body: spec,
    updatedAt: PR_EDITED,
    state: 'OPEN',
    labels: [],
    comments: historyFrom([built.value], AUTOMATION).source.comments.map((comment, index) =>
      stored(comment.body, 4200 + index),
    ),
  }
  const mandateHistory = historyFrom([built.value], AUTOMATION)
  const bindingBodies = framedBodies([binding], AUTOMATION, [mandateHistory])
  state.comments = [
    ...state.comments.filter((comment) => recordKind(comment.body) !== 'workflow-binding'),
    ...bindingBodies.map((body, index) => stored(body, 5000 + index)),
  ]
  state.nextCommentId = Math.max(state.nextCommentId, 5000 + bindingBodies.length)
  writeState(box, state)
}

function setMandateIssue(box: Box, patch: { state?: string; body?: string; updatedAt?: string | null }): void {
  const state = readState(box)
  const issue = state.issues['42']
  if (!issue) throw new Error('mandate issue 42 is missing')
  if (patch.state !== undefined) issue.state = patch.state
  if (patch.body !== undefined) issue.body = patch.body
  if (patch.updatedAt !== undefined) issue.updatedAt = patch.updatedAt
  writeState(box, state)
}

async function boundInput(box: Box): Promise<string> {
  const semantic = await confirmedReviewSemanticContext(box.tools, 7, gateGh(box), 'main')
  if ('ok' in semantic) throw new Error(semantic.error)
  return hashReviewInput(
    'acme/app',
    { pr: 7, candidate: box.head },
    { body: PR_TEXT, lastEditedAt: PR_EDITED },
    null,
    null,
    semantic,
  )
}

/**
 * Wire a bare origin at the recorded GH tip (T0); no network — local path rewrite only.
 * Idempotent: setup always attaches so refreshSelectedBase can fetch; T0→T1 cases reuse it.
 * Fake `gh repo view <origin-path>` maps to acme/app — origin identity check is not weakened.
 */
function attachBareOriginAtBase(box: Box): string {
  const state = readState(box)
  if (typeof state.origin === 'string' && state.origin.length > 0) return state.origin
  const origin = path.join(box.root, 'origin.git')
  git(box.root, ['clone', '-q', '--bare', box.candidate, origin])
  git(origin, ['update-ref', 'refs/heads/main', box.base])
  // Store + remote the realpath form so get-url and fake gh repo view see the same string.
  const resolved = path.resolve(origin)
  git(box.candidate, ['remote', 'add', 'origin', resolved])
  state.origin = resolved
  writeState(box, state)
  return resolved
}

/** Advance origin/main to T1 by changing committed normative stack; leave GH baseRefOid at T0. */
function advanceOriginNormativeStack(box: Box, origin: string): string {
  const stage = path.join(box.root, 'origin-stage')
  git(box.root, ['clone', '-q', origin, stage])
  mkdirSync(path.join(stage, '.dev'), { recursive: true })
  writeFileSync(path.join(stage, '.dev/stack.yml'), 'landing:\n  mode: merge-on-green\n')
  git(stage, ['add', '.dev/stack.yml'])
  git(stage, ['commit', '-qm', 'advance origin/main normative stack'])
  git(stage, ['push', '-q', 'origin', 'HEAD:main'])
  return git(stage, ['rev-parse', 'HEAD'])
}

/** Valid v2 no-producer standalone hash. Closing/tracker text is not landing authority. */
async function standaloneNoProducerInput(box: Box): Promise<string> {
  const state = readState(box)
  state.comments = state.comments.filter((comment) => recordKind(comment.body) !== 'workflow-binding')
  for (const issue of Object.values(state.issues)) {
    issue.comments = issue.comments.filter((comment) => recordKind(comment.body) !== 'mandate')
  }
  writeState(box, state)
  const semantic = await confirmedReviewSemanticContext(box.tools, 7, gateGh(box), 'main')
  if ('ok' in semantic) throw new Error(semantic.error)
  if (semantic.mode !== 'standalone') {
    throw new Error('standalone no-producer input requires an absent workflow-binding')
  }
  return hashReviewInput(
    'acme/app',
    { pr: 7, candidate: box.head },
    { body: state.prBody, lastEditedAt: state.prEditedAt },
    null,
    null,
    semantic,
  )
}

describe('review-gate CLI', () => {
  it('allows a green review whose input is the no-producer v2 hash', async () => {
    const current = setup()
    await seedMandate(current)
    const input = await boundInput(current)
    expect(input).toMatch(/^[0-9a-f]{64}$/)
    publish(current, cleanReview(current.head, 'one', input), 'SUCCESS')

    const result = runGate(current)

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, allowed: true, ci: 'green' })
  })

  it.each(['SUCCESS', ''] as const)(
    'refuses %s CI when a valid standalone no-producer approval has no workflow-binding mandate',
    async (conclusion) => {
      const current = setup()
      const input = await standaloneNoProducerInput(current)
      expect(input).toMatch(/^[0-9a-f]{64}$/)
      publish(
        current,
        cleanReview(current.head, 'one', input),
        conclusion,
        conclusion === '' ? 'IN_PROGRESS' : 'COMPLETED',
      )

      const result = runGate(current)
      const body = JSON.parse(result.stdout)

      expect(result.status).toBe(1)
      expect(result.stderr).toBe('')
      expect(body).toMatchObject({ ok: false, allowed: false, reason: 'missing' })
      expect(body.reason).not.toBe('proof-refused')
      expect(body.detail?.reason).not.toBe('unbound')
    },
  )

  it('allows a bound closed Spec when the accepted bytes are unchanged', async () => {
    const current = setup()
    await seedMandate(current)
    setMandateIssue(current, { state: 'CLOSED' })
    const input = await boundInput(current)
    expect(input).toMatch(/^[0-9a-f]{64}$/)
    publish(current, cleanReview(current.head, 'one', input), 'SUCCESS')

    const result = runGate(current)

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, allowed: true, ci: 'green' })
  })

  it('refuses a closed Spec whose live body drifted from the accepted mandate', async () => {
    const current = setup()
    await seedMandate(current)
    const input = await boundInput(current)
    publish(current, cleanReview(current.head, 'one', input), 'SUCCESS')
    setMandateIssue(current, { state: 'CLOSED', body: `${SPEC}\n- [ ] clarified`, updatedAt: '2026-10-21T01:00:00Z' })

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      allowed: false,
      reason: 'materially-changed',
      detail: [{ code: 'materially-changed' }],
    })
  })

  it.each(['MISSING', 'UNKNOWN', 'MERGED'] as const)(
    'refuses Spec reads when the tracker state is %s',
    async (state) => {
      const current = setup()
      await seedMandate(current)
      setMandateIssue(current, { state })

      // Assert the semantic refusal outcome, not incidental transport wording.
      const semantic = await confirmedReviewSemanticContext(current.tools, 7, gateGh(current), 'main')
      expect(semantic).toMatchObject({ ok: false, reason: 'unreadable' })
    },
  )

  it('does not grant landing from a closed tracker issue alone without a workflow-binding', async () => {
    const current = setup()
    const state = readState(current)
    state.prBody = 'Closes #42\n'
    state.prEditedAt = PR_EDITED
    state.issues['42'] = {
      body: SPEC,
      updatedAt: PR_EDITED,
      state: 'CLOSED',
      labels: [],
      comments: [],
    }
    writeState(current, state)
    const input = await standaloneNoProducerInput(current)
    publish(current, cleanReview(current.head, 'one', input), 'SUCCESS')

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'missing' })
  })

  it('refuses a stored null review input when no producer applies', async () => {
    const current = setup()
    // Seed a real workflow-binding so admission reaches unbound proof (null input),
    // not the earlier missing-authority exit for an absent binding.
    await seedMandate(current)
    publish(current, cleanReview(current.head, 'one'), 'SUCCESS')

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      allowed: false,
      reason: 'proof-refused',
      detail: { reason: 'unbound' },
    })
  })

  it('allows pending CI when the no-producer hash matches the bound review', async () => {
    const current = setup()
    await seedMandate(current)
    publish(current, cleanReview(current.head, 'one', await boundInput(current)), '', 'IN_PROGRESS')

    const result = runGate(current)

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, allowed: true, ci: 'pending' })
  })

  it.each([['green', 'SUCCESS', 'COMPLETED'] as const, ['pending', '', 'IN_PROGRESS'] as const])(
    'refuses %s when origin/main advances past GH baseRefOid while the mandate stays at the recorded tip',
    async (ciLabel, conclusion, status) => {
      const current = setup()
      const origin = attachBareOriginAtBase(current)
      await seedMandate(current)
      const input = await boundInput(current)
      publish(current, cleanReview(current.head, 'one', input), conclusion, status)

      const allowed = runGate(current)
      expect(allowed.stderr).toBe('')
      expect(JSON.parse(allowed.stdout)).toMatchObject({
        ok: true,
        allowed: true,
        ci: ciLabel,
      })

      const advanced = advanceOriginNormativeStack(current, origin)
      expect(advanced).not.toBe(current.base)
      expect(readState(current)).toMatchObject({ base: current.base, head: current.head })

      const refused = runGate(current)
      expect(refused.status).toBe(1)
      expect(refused.stderr).toBe('')
      expect(JSON.parse(refused.stdout)).toMatchObject({
        ok: false,
        allowed: false,
        reason: 'proof-pin-drift',
      })
    },
  )

  it('refuses the same head after the accepted Spec changes', async () => {
    const current = setup()
    await seedMandate(current)
    const input = await boundInput(current)
    publish(current, cleanReview(current.head, 'one', input), 'SUCCESS')
    await seedMandate(current, `${SPEC}\n- [ ] clarified`)

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      allowed: false,
      reason: 'proof-refused',
      detail: { reason: 'unbound' },
    })
  })

  it('refuses pending CI when the current canonical review requests changes', async () => {
    const current = setup()
    await seedMandate(current)
    const blockers = encodedAdmissionReviewGraph({
      scope: SCOPE,
      head: current.head,
      input: await boundInput(current),
      prefix: 'blocker',
      verdict: 'Request changes',
    }).comments.map((comment) => comment.body)
    publish(current, blockers, '', 'IN_PROGRESS')

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, allowed: false, reason: 'review-state-wait' })
    expect(result.stderr).toBe('')
  })

  it('does not allow publication without a canonical review', () => {
    const current = setup()
    publish(current, [], 'SUCCESS')

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false })
    expect(result.stderr).toBe('')
  })

  it('refuses an unknown CI conclusion instead of retaining native auto-merge', () => {
    const current = setup()
    publish(current, cleanReview(current.head, 'one'), 'ACTION_REQUIRED')

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'review-history-refused' })
    expect(result.stderr).toBe('')
  })

  it('refuses a failed CI after the third approving review', () => {
    const current = setup()
    publish(current, approvals(current.head), 'FAILURE')

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'ci-failed' })
    expect(result.stderr).toBe('')
  })

  it('surfaces the third-review CI stop before refusing unbound positive admission', () => {
    const current = setup()
    publish(current, approvals(current.head, 'a'.repeat(64)), 'FAILURE')

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      allowed: false,
      reason: 'ci-failed',
      detail: { reviewId: 'three-final', detail: { reviews: 3, ci: 'red' } },
    })
    expect(postCalls(current)).toEqual([])
    expect(result.stderr).toBe('')
  })

  it('refuses a red current head when its third approving review binds the prior head', () => {
    const current = setup()
    const reviewedHead = current.head
    writeFileSync(path.join(current.candidate, 'unreviewed.txt'), 'unreviewed\n')
    git(current.candidate, ['add', '.'])
    git(current.candidate, ['commit', '-qm', 'unreviewed head'])
    const currentHead = git(current.candidate, ['rev-parse', 'HEAD'])
    publish(current, approvals(reviewedHead), 'FAILURE')
    const state = readState(current)
    state.head = currentHead
    state.calls = []
    writeState(current, state)

    const stopped = runStop(current, capturedCiFailure(), currentHead)

    expect(stopped.status).toBe(1)
    expect(stopped.stderr).toContain('reviewed head does not bind this CI stop')
    expect(postCalls(current)).toEqual([])

    const gate = runGate(current, currentHead)

    expect(gate.status).toBe(1)
    expect(JSON.parse(gate.stdout)).toEqual({ ok: false, allowed: false, reason: 'reviewed-head-mismatch' })
    expect(postCalls(current)).toEqual([])
  })

  it('retains the captured third-review CI stop across later green CI and a fresh head', async () => {
    const current = setup()
    publish(current, approvals(current.head), 'FAILURE', 'COMPLETED', 100)

    const stopped = runStop(current, capturedCiFailure())

    expect(stopped.status).toBe(0)
    expect(JSON.parse(stopped.stdout)).toEqual({
      ok: true,
      stop: { reason: 'ci-failed', reviewId: 'three-final', detail: { reviews: 3, ci: 'red' } },
    })
    expect(postCalls(current)).toHaveLength(1)
    expect(readState(current).calls.some((argv) => argv[1]?.includes('page=2'))).toBe(true)

    writeFileSync(path.join(current.candidate, 'later.txt'), 'later\n')
    git(current.candidate, ['add', '.'])
    git(current.candidate, ['commit', '-qm', 'later candidate'])
    const freshHead = git(current.candidate, ['rev-parse', 'HEAD'])
    const state = readState(current)
    state.head = freshHead
    state.ci = { status: 'COMPLETED', conclusion: 'SUCCESS' }
    writeState(current, state)

    const gate = runGate(current, freshHead)

    expect(gate.status).toBe(1)
    expect(JSON.parse(gate.stdout)).toEqual({
      ok: false,
      allowed: false,
      reason: 'ci-failed',
      detail: { reviewId: 'three-final', detail: { reviews: 3, ci: 'red' } },
    })
    const decoded = await readExternalHistory(current)
    expect(decoded.operations.find((operation) => operation.kind === 'stop')).toMatchObject({
      status: 'complete',
      record: { kind: 'stop', payload: { reason: 'ci-failed', reviewId: 'three-final' } },
      parts: [{ author: STOP_BOT }],
    })
  })

  it('accepts a normal automation stop when the CI bot is also configured as a stop author', async () => {
    const current = setup()
    publish(current, approvals(current.head), 'FAILURE')
    expect(runStop(current, capturedCiFailure()).status).toBe(0)
    const state = readState(current)
    for (const comment of state.comments) {
      if (comment.body.includes('kind=stop')) comment.user.login = AUTOMATION
    }
    state.ci = { status: 'COMPLETED', conclusion: 'SUCCESS' }
    writeState(current, state)

    const gate = runGate(current)

    expect(JSON.parse(gate.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'ci-failed' })
    expect(
      (await readExternalHistory(current)).operations.find((operation) => operation.kind === 'stop'),
    ).toMatchObject({
      status: 'complete',
      parts: [{ author: AUTOMATION }],
    })
  })

  it('rejects a bot-authored non-stop record through the public adapter boundary', async () => {
    const current = setup()
    publish(current, cleanReview(current.head, 'one'), 'SUCCESS')
    const state = readState(current)
    for (const comment of state.comments) comment.user.login = STOP_BOT
    writeState(current, state)

    const decoded = await readExternalHistory(current)

    expect(decoded.operations.find((operation) => operation.kind === 'review')).toMatchObject({
      status: 'invalid',
      record: null,
    })
    expect(decoded.diagnostics.map((diagnostic) => diagnostic.code)).toContain('native-author-mismatch')
  })

  it('refuses stale head and captured review-bound mismatches without posting a stop', () => {
    const current = setup()
    publish(current, approvals(current.head), 'FAILURE')
    const moved = readState(current)
    moved.head = 'f'.repeat(40)
    writeState(current, moved)

    const staleHead = runStop(current, capturedCiFailure())

    expect(staleHead.status).toBe(1)
    expect(staleHead.stderr).toContain('PR head moved before stop publication')
    expect(postCalls(current)).toEqual([])

    const restored = readState(current)
    restored.head = current.head
    restored.calls = []
    writeState(current, restored)

    const staleBound = runStop(current, capturedCiFailure('one-final'))

    expect(staleBound.status).toBe(1)
    expect(staleBound.stderr).toContain('fresh review state no longer matches observed ci-failed stop')
    expect(postCalls(current)).toEqual([])
  })

  it('refuses when the complete native comment history cannot be read', () => {
    const current = setup()
    writeFileSync(path.join(current.stateDir, 'comments.fail'), '')

    const result = runGate(current)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'unreadable' })
    expect(result.stderr).toBe('')
  })
})
