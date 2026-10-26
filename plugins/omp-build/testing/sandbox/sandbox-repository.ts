import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Box, Files, SimIssue, SimState, Spec } from './sandbox-types'

export const SIM = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'skills',
  'feature',
  'testing',
  'gh-simulator',
  'gh-simulator.ts',
)
export const WORKFLOW = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'skills',
  'feature',
  'testing',
  'goal',
  'goal-scenario-workflow.ts',
)

const DATE = '2026-01-01T00:00:00Z'
const RETAINED_GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE']

export function git(box: Pick<Box, 'env'>, cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  }).replace(/\n$/, '')
}

function write(dir: string, files: Files, box: Box): void {
  for (const [file, content] of Object.entries(files)) {
    const at = path.join(dir, file)
    if (content === null) {
      git(box, dir, ['rm', '-r', '-q', '--', file])
      continue
    }
    mkdirSync(path.dirname(at), { recursive: true })
    writeFileSync(at, content)
  }
}

function sandboxEnvironment(root: string, bin: string, stateFile: string, spec: Spec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...(spec.path ?? []), bin, process.env.PATH].join(':'),
    HOME: root,
    GH_SIM_STATE: stateFile,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: DATE,
    GIT_COMMITTER_DATE: DATE,
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !RETAINED_GIT_ENV.includes(key)) delete env[key]
  }
  return env
}

function sandboxBox(allocated: string, spec: Spec): Box {
  const root = realpathSync(allocated)
  const origin = path.join(root, 'origin.git')
  const principal = path.join(root, spec.principalName ?? 'principal')
  const bin = path.join(root, 'bin')
  const stateFile = path.join(root, 'gh-state.json')
  mkdirSync(bin)
  symlinkSync(SIM, path.join(bin, 'gh'))
  return { root, origin, principal, stateFile, env: sandboxEnvironment(root, bin, stateFile, spec), sha: {} }
}

function initializeRepository(box: Box, spec: Spec): void {
  git(box, box.root, ['init', '-q', '--bare', box.origin])
  git(box, box.root, ['init', '-q', '-b', 'main', box.principal])
  write(box.principal, spec.base, box)
  git(box, box.principal, ['add', '-A'])
  git(box, box.principal, ['commit', '-qm', 'chore: base'])
  git(box, box.principal, ['remote', 'add', 'origin', box.origin])
  git(box, box.principal, ['push', '-q', '-u', 'origin', 'main'])
  box.sha.main = git(box, box.principal, ['rev-parse', 'HEAD'])
}

function createBranches(box: Box, spec: Spec): void {
  for (const branch of spec.branches) {
    git(box, box.principal, ['checkout', '-q', '-b', branch.name, box.sha[branch.from] ?? branch.from])
    for (const commit of branch.commits) {
      write(box.principal, commit.files, box)
      git(box, box.principal, ['add', '-A'])
      git(box, box.principal, ['commit', '-qm', commit.message])
    }
    box.sha[branch.name] = git(box, box.principal, ['rev-parse', 'HEAD'])
    git(box, box.principal, ['push', '-q', 'origin', branch.name])
  }
  git(box, box.principal, ['checkout', '-q', 'main'])
  git(box, box.principal, ['fetch', '-q', 'origin'])
}

function addPrincipalFiles(box: Box, spec: Spec): void {
  for (const [file, content] of Object.entries(spec.principalFiles ?? {})) {
    const pathToFile = path.join(box.principal, file)
    mkdirSync(path.dirname(pathToFile), { recursive: true })
    writeFileSync(pathToFile, content)
  }
}

function simulatorIssues(spec: Spec): Record<string, SimIssue> {
  const issues: Record<string, SimIssue> = {}
  for (const issue of spec.issues) {
    issues[issue.number] = {
      number: issue.number,
      title: issue.title,
      body: '## Acceptance criteria\n\n- [ ] lands\n',
      state: 'OPEN',
      author: 'operator',
      labels: ['size:F-lite'],
      comments: [],
      subIssues: [],
      blockedBy: [],
      issueType: issue.issueType ?? null,
    }
  }
  return issues
}

function simulatorPrs(box: Box, spec: Spec): Record<string, unknown> {
  const prs: Record<string, unknown> = {}
  for (const pr of spec.prs) {
    const base = pr.base ?? 'main'
    const head = box.sha[pr.branch]
    prs[pr.number] = {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: 'OPEN',
      headRefName: pr.branch,
      baseRefName: base,
      headRefOid: head,
      isCrossRepository: false,
      labels: [],
      autoMerge: null,
      mergeCommit: null,
      mergedAt: null,
      comments: [],
      closes: pr.closes,
      // GitHub records the base tip when the PR opens; pushes to the base leave it.
      baseRecord: { at: `${base}@${head}`, oid: box.sha[base] ?? null },
    }
  }
  return prs
}

function writeSimulatorState(box: Box, spec: Spec): void {
  writeFileSync(
    box.stateFile,
    JSON.stringify(
      {
        viewer: 'operator',
        owner: 'acme',
        name: 'app',
        defaultBranch: 'main',
        origin: box.origin,
        requiredChecks: ['ci'],
        nextPr: 100,
        clock: 0,
        issues: simulatorIssues(spec),
        prs: simulatorPrs(box, spec),
        checks: {},
        events: {},
        calls: [],
      },
      null,
      2,
    ),
  )
}

export function sandbox(spec: Spec): Box {
  const allocated = mkdtempSync(path.join(tmpdir(), 'omp-proof-'))
  try {
    const box = sandboxBox(allocated, spec)
    initializeRepository(box, spec)
    createBranches(box, spec)
    addPrincipalFiles(box, spec)
    writeSimulatorState(box, spec)
    return box
  } catch (error) {
    rmSync(allocated, { recursive: true, force: true })
    throw error
  }
}

export function readSim(box: Box): SimState {
  return JSON.parse(readFileSync(box.stateFile, 'utf8')) as SimState
}

export function writeSim(box: Box, mutate: (state: SimState) => void): void {
  const state = readSim(box)
  mutate(state)
  writeFileSync(box.stateFile, JSON.stringify(state, null, 2))
}

/** A linked worktree of the principal, detached at `sha`. */
export function worktree(box: Box, name: string, sha: string): string {
  const dir = path.join(box.root, name)
  git(box, box.principal, ['worktree', 'add', '-q', '--detach', dir, sha])
  return dir
}
