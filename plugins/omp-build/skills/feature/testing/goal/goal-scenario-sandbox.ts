import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os'
import path from 'node:path'
import {
  A,
  B,
  type Box,
  BRANCH_C,
  C,
  CHILD_BODY,
  EPIC,
  EPIC_BODY,
  type Pull,
  type SimState,
} from './goal-scenario-domain.ts'

const DRIVER = path.resolve(import.meta.dirname, 'goal-scenario-driver-direct.ts')
const SIM = path.resolve(import.meta.dirname, '..', 'gh-simulator', 'gh-simulator.ts')
const WORKFLOW = path.resolve(import.meta.dirname, 'goal-scenario-workflow-direct.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const REPOSITORY_URL = 'https://github.com/acme/app.git'

let box: Box | undefined

// Temporary CI diagnosis: record only operation names and resource readings, never command arguments.
function timing(event: Record<string, unknown>): void {
  const file = process.env.OMP_GOAL_TIMING_FILE
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...event })}\n`)
  } catch {
    // Diagnostics must not alter the test result.
  }
}

function timed<T>(kind: string, operation: string | undefined, run: () => T): T {
  if (!process.env.OMP_GOAL_TIMING_FILE) return run()
  const name = operation && /^[a-zA-Z-]+$/.test(operation) ? operation : 'other'
  const started = performance.now()
  timing({ event: 'start', kind, operation: name, load: loadavg(), freeMemory: freemem() })
  try {
    return run()
  } finally {
    timing({ event: 'end', kind, operation: name, elapsedMs: performance.now() - started })
  }
}

function activeBox(): Box {
  if (!box) throw new Error('no sandbox')
  return box
}

export function sandboxEpic(): string | undefined {
  return box?.epic
}

export function sandboxOrigin(): string {
  return activeBox().origin
}

export function dispose(): void {
  if (box) rmSync(box.root, { recursive: true, force: true })
  box = undefined
}

export function git(cwd: string, args: string[]): string {
  const active = activeBox()
  return timed('git', args[0], () =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env: active.env,
      encoding: 'utf8',
    }).trim(),
  )
}

export function readSim(): SimState {
  return JSON.parse(readFileSync(activeBox().stateFile, 'utf8'))
}

export function writeSim(mutate: (state: SimState) => void): void {
  const state = readSim()
  mutate(state)
  writeFileSync(activeBox().stateFile, JSON.stringify(state, null, 2))
}

export function gh(args: string[], input?: string) {
  const active = activeBox()
  const out = timed('gh', args[0], () =>
    spawnSync(path.join(active.root, 'bin', 'gh'), args, {
      cwd: active.epic,
      env: active.env,
      encoding: 'utf8',
      input,
    }),
  )
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

export function callWorkflow<T>(fn: string, cwd: string, payload: object): T {
  const active = activeBox()
  const out = timed('workflow', fn, () =>
    spawnSync(REAL_BUN, [WORKFLOW, fn, cwd, JSON.stringify(payload)], {
      cwd,
      env: active.env,
      encoding: 'utf8',
    }),
  )
  if (out.status !== 0) throw new Error(`${fn} failed (${out.status}): ${out.stderr}\n${out.stdout}`)
  return JSON.parse(out.stdout)
}

export function runDriver(args: string[], cwd: string): { code: number | null; stdout: string; stderr: string } {
  const active = activeBox()
  const out = timed('driver', args[0], () =>
    spawnSync(REAL_BUN, [DRIVER, ...args, '--epic', String(EPIC)], {
      cwd,
      env: active.env,
      encoding: 'utf8',
    }),
  )
  return { code: out.status, stdout: out.stdout, stderr: out.stderr }
}

function child(number: number, title: string, blockedBy: number[] = []) {
  return {
    number,
    title,
    body: CHILD_BODY,
    state: 'OPEN',
    updatedAt: '2026-01-01T00:00:00Z',
    author: 'operator',
    labels: ['size:F-lite'],
    comments: [],
    subIssues: [],
    blockedBy,
  }
}

export function sandbox(): Box {
  if (process.env.OMP_GOAL_TIMING_FILE)
    timing({
      event: 'sandbox',
      availableParallelism: availableParallelism(),
      cpus: cpus().length,
      totalMemory: totalmem(),
      freeMemory: freemem(),
      load: loadavg(),
    })
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-goal-scenario-')))
  const origin = path.join(root, 'origin.git')
  const principal = path.join(root, 'principal')
  const epic = path.join(root, 'epic')
  const bin = path.join(root, 'bin')
  const stateFile = path.join(root, 'gh-state.json')
  mkdirSync(bin)
  symlinkSync(SIM, path.join(bin, 'gh'))
  chmodSync(SIM, 0o755)
  const gitWrapper = path.join(bin, 'git')
  writeFileSync(
    gitWrapper,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    fetch|push) exec "${REAL_GIT}" -c "url.\${GH_SIM_ORIGIN}.insteadOf=${REPOSITORY_URL}" "$@" ;;
  esac
done
exec "${REAL_GIT}" "$@"
`,
  )
  chmodSync(gitWrapper, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    GH_SIM_STATE: stateFile,
    GH_SIM_ORIGIN: origin,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'])
    delete env[key]
  box = { root, origin, epic, stateFile, env }
  git(root, ['init', '-q', '-b', 'main', principal])
  git(root, ['init', '-q', '--bare', origin])
  mkdirSync(path.join(principal, '.dev'), { recursive: true })
  mkdirSync(path.join(principal, 'scripts'), { recursive: true })
  writeFileSync(
    path.join(principal, '.dev', 'stack.yml'),
    [
      'landing:',
      '  mode: native',
      '  required_checks:',
      '    - ci',
      'release:',
      '  model: trunk',
      '  post_merge:',
      '    - ./scripts/post-merge.sh',
      '',
    ].join('\n'),
  )
  writeFileSync(path.join(principal, 'scripts', 'post-merge.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(path.join(principal, 'scripts', 'post-merge.sh'), 0o755)
  writeFileSync(path.join(principal, 'README.md'), 'base\n')
  git(principal, ['add', '.'])
  git(principal, ['commit', '-qm', 'chore: base'])
  git(principal, ['remote', 'add', 'origin', REPOSITORY_URL])
  git(principal, ['push', '-q', '-u', 'origin', 'main'])
  git(principal, ['worktree', 'add', '-q', '--detach', epic, 'refs/remotes/origin/main'])
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        viewer: 'operator',
        owner: 'acme',
        name: 'app',
        defaultBranch: 'main',
        origin,
        repositoryUrls: { [REPOSITORY_URL]: 'acme/app' },
        requiredChecks: ['ci'],
        nextPr: 10,
        clock: 0,
        issues: {
          1: {
            number: 1,
            title: 'epic: goal',
            body: EPIC_BODY,
            state: 'OPEN',
            updatedAt: '2026-01-01T00:00:00Z',
            author: 'operator',
            labels: ['epic', 'size:F-lite'],
            comments: [],
            subIssues: [A, B, C],
            blockedBy: [],
          },
          2: child(A, 'feat(a): child a'),
          3: child(B, 'feat(b): child b', [A]),
          4: child(C, 'feat(c): child c'),
        },
        prs: {},
        checks: {},
        events: {},
        calls: [],
      },
      null,
      2,
    ),
  )
  return box
}

export function commitAndPush(branch: string, message: string, file: string): string {
  const active = activeBox()
  writeFileSync(path.join(active.epic, file), `${message}\n`)
  git(active.epic, ['add', file])
  git(active.epic, ['commit', '-qm', message])
  git(active.epic, ['push', '-q', '-u', 'origin', branch])
  return git(active.epic, ['rev-parse', 'HEAD'])
}

export function markGreen(sha: string): void {
  writeSim((state) => {
    state.checks[sha] = [
      { name: 'ci', status: 'completed', conclusion: 'success', workflowName: 'ci', startedAt: '2026-01-01T00:00:00Z' },
    ]
  })
}

export function prOf(head: string): Pull {
  const pr = Object.values(readSim().prs).find((item) => item.headRefName === head)
  if (!pr) throw new Error(`no PR for ${head}`)
  return pr
}

export function stoppedArms(): Pull[] {
  return Object.values(readSim().prs).filter(
    (pr) =>
      pr.headRefName === BRANCH_C && pr.state === 'OPEN' && (pr.labels.includes('reviewed') || pr.autoMerge !== null),
  )
}
