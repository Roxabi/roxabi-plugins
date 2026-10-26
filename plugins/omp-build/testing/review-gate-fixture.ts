import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decodeHistory, githubScope, readGitHubHistory } from '../dist/contracts.js'
import {
  AUTOMATION,
  GITHUB_ENV,
  installFakeGh,
  PR_TEXT,
  type ReviewGateState,
  STOP_BOT,
  STOP_ENV,
  type StoredComment,
} from './review-gate-gh.ts'

const PLUGIN = path.resolve(import.meta.dirname, '..')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
}
for (const key of Object.keys(GIT_ENV))
  if (key.startsWith('GIT_') && key !== 'GIT_CONFIG_GLOBAL' && key !== 'GIT_CONFIG_NOSYSTEM') delete GIT_ENV[key]

export type ReviewGateFixture = {
  root: string
  tools: string
  candidate: string
  statePath: string
  stateDir: string
  home: string
  env: NodeJS.ProcessEnv
  base: string
  head: string
  pin: string
}

const fixtureRoots = new Set<string>()

export function cleanupReviewGateFixture(): void {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
  fixtureRoots.clear()
}

export function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'commit.gpgSign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: GIT_ENV,
    },
  ).trim()
}

export function setupReviewGateFixture(): ReviewGateFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'omp-review-gate-'))
  fixtureRoots.add(root)
  try {
    const tools = path.join(root, 'tools')
    const candidate = path.join(root, 'candidate')
    const stateDir = path.join(root, 'state')
    const statePath = path.join(stateDir, 'github.json')
    const home = path.join(root, 'home')
    const bin = path.join(root, 'bin')
    mkdirSync(stateDir)
    mkdirSync(home)
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
    git(candidate, ['add', '.'])
    git(candidate, ['commit', '-qm', 'base'])
    const base = git(candidate, ['rev-parse', 'HEAD'])
    writeFileSync(path.join(candidate, 'candidate.txt'), 'candidate\n')
    git(candidate, ['add', '.'])
    git(candidate, ['commit', '-qm', 'candidate'])
    const head = git(candidate, ['rev-parse', 'HEAD'])

    installFakeGh(bin)
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          head,
          base,
          ci: { status: 'COMPLETED', conclusion: 'SUCCESS' },
          comments: [],
          calls: [],
          nextCommentId: 1,
          prBody: PR_TEXT,
          prEditedAt: '2026-10-21T00:00:00Z',
          issues: {},
        } satisfies ReviewGateState,
        null,
        2,
      ),
    )
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      NODE_PATH: '',
      BUN_INSTALL: path.join(home, '.bun'),
      BUN_INSTALL_CACHE_DIR: path.join(home, '.bun-cache'),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: '1',
      // The gate swaps the global config for /dev/null; these keys survive it.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'maintenance.auto',
      GIT_CONFIG_VALUE_0: 'false',
      GATE_STATE: statePath,
      GATE_STATE_DIR: stateDir,
    }
    env[GITHUB_ENV] = AUTOMATION
    env[STOP_ENV] = 'stop'
    const fixture = { root, tools, candidate, statePath, stateDir, home, base, head, pin, env }
    attachBareOriginAtBase(fixture)
    return fixture
  } catch (error) {
    fixtureRoots.delete(root)
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function writeState(fixture: ReviewGateFixture, state: ReviewGateState): void {
  writeFileSync(fixture.statePath, JSON.stringify(state, null, 2))
}

export function readState(fixture: ReviewGateFixture): ReviewGateState {
  return JSON.parse(readFileSync(fixture.statePath, 'utf8')) as ReviewGateState
}

export function runReviewGate(fixture: ReviewGateFixture, head = fixture.head) {
  return spawnSync(
    REAL_BUN,
    [
      path.join(fixture.tools, 'plugins/omp-build/scripts/review-gate.ts'),
      '--repository',
      'acme/app',
      '--pr',
      '7',
      '--head',
      head,
      '--automation-login',
      AUTOMATION,
      '--candidate-cwd',
      fixture.candidate,
      '--tooling-sha',
      fixture.pin,
    ],
    { cwd: fixture.tools, env: fixture.env, encoding: 'utf8' },
  )
}

export function runReviewStop(
  fixture: ReviewGateFixture,
  observation: {
    ok: false
    allowed: false
    reason: 'ci-failed'
    detail: { reviewId: string; detail: { reviews: number; ci: 'red' } }
  },
  head = fixture.head,
) {
  const observationPath = path.join(fixture.root, 'observation.json')
  writeFileSync(observationPath, JSON.stringify(observation))
  return spawnSync(
    REAL_BUN,
    [
      path.join(fixture.tools, 'plugins/omp-build/scripts/review-stop.ts'),
      '--repository',
      'acme/app',
      '--pr',
      '7',
      '--head',
      head,
      '--automation-login',
      AUTOMATION,
      '--run-id',
      'run-84',
      '--observation',
      observationPath,
    ],
    { cwd: fixture.tools, env: fixture.env, encoding: 'utf8' },
  )
}

export function postCalls(fixture: ReviewGateFixture): string[][] {
  return readState(fixture).calls.filter((argv) => argv[0] === 'api' && argv.includes('--method'))
}

export async function readExternalHistory(fixture: ReviewGateFixture) {
  return decodeHistory(
    await readGitHubHistory(githubScope('acme/app', 7), {
      cwd: fixture.tools,
      readAuthor: AUTOMATION,
      stopAuthor: STOP_BOT,
      gh: async (_cwd, args) => {
        const result = spawnSync('gh', args, { cwd: fixture.tools, env: fixture.env, encoding: 'utf8' })
        if (result.status !== 0) throw new Error(String(result.stderr || result.stdout))
        return String(result.stdout).trim()
      },
    }),
  )
}

export function attachBareOriginAtBase(fixture: ReviewGateFixture): string {
  const state = readState(fixture)
  if (typeof state.origin === 'string' && state.origin.length > 0) return state.origin
  const origin = path.join(fixture.root, 'origin.git')
  git(fixture.root, ['clone', '-q', '--bare', fixture.candidate, origin])
  git(origin, ['update-ref', 'refs/heads/main', fixture.base])
  const resolved = path.resolve(origin)
  git(fixture.candidate, ['remote', 'add', 'origin', resolved])
  state.origin = resolved
  writeState(fixture, state)
  return resolved
}

export function publish(
  fixture: ReviewGateFixture,
  bodies: string[],
  conclusion: string,
  status = 'COMPLETED',
  padding = 0,
): void {
  const state = readState(fixture)
  const bindings = state.comments.filter((comment) => recordKind(comment.body) === 'workflow-binding')
  const dated = (body: string, id: number): StoredComment => ({
    id,
    body,
    user: { login: AUTOMATION },
    created_at: '2026-10-21T00:00:00Z',
    updated_at: '2026-10-21T00:00:00Z',
  })
  state.comments = [
    ...Array.from({ length: padding }, (_, index) => dated(`unrelated pagination comment ${index + 1}`, index + 1)),
    ...bodies.map((body, index) => dated(body, index + padding + 1)),
    ...bindings,
  ]
  state.nextCommentId = Math.max(state.nextCommentId, ...state.comments.map((comment) => comment.id)) + 1
  state.ci = { status, conclusion }
  state.calls = []
  writeState(fixture, state)
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
