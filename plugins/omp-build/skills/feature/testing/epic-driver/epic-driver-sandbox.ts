import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SelectedMandateAuthority } from '../../../../roxabi/feature-disarm-ownership.ts'
import { epicRuntime } from './epic-driver-gh-stub.ts'

// Real Git checkout and a stub `gh` that serves histories and records writes.
const CONTROL = path.resolve(import.meta.dirname, '..', '..', 'epic-driver-control.ts')
const CONTRACTS = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'dist', 'contracts.js')
const FEATURE_DISARM = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'roxabi', 'feature-disarm.ts')
const RUNTIME = path.resolve(import.meta.dirname, '..', '..', 'epic-driver-runtime.ts')

export type Sandbox = {
  root: string
  state: string
  origin: string
  principal: string
  epic: string
  env: NodeJS.ProcessEnv
}

let box: Sandbox | undefined
export function cleanupSandbox(): void {
  if (box) rmSync(box.root, { recursive: true, force: true })
  box = undefined
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: box?.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function sandbox(stack = 'release:\n  model: trunk\n'): Sandbox {
  const { ghStub } = epicRuntime()
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-epic-driver-')))
  const state = path.join(root, 'state')
  const bin = path.join(root, 'bin')
  mkdirSync(path.join(state, 'pr'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'gh'), ghStub)
  chmodSync(path.join(bin, 'gh'), 0o755)
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    DRIVER_STATE: state,
    HEAD_AUTH_REPOSITORY_ID: '1',
    HEAD_AUTH_OPERATOR_IDS: '[101]',
    HEAD_AUTH_APP_ID: '200',
    HEAD_AUTH_BOT_USER_ID: '201',
  }
  env.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL
  env.GIT_CONFIG_NOSYSTEM = '1'
  box = {
    root,
    state,
    origin: path.join(root, 'origin.git'),
    principal: path.join(root, 'principal'),
    epic: path.join(root, 'worktrees', 'r', 'parents', 'o-1'),
    env,
  }
  git(root, 'init', '-q', '--bare', '-b', 'main', box.origin)
  git(root, 'clone', '-q', box.origin, box.principal)
  mkdirSync(path.join(box.principal, '.dev'))
  writeFileSync(
    path.join(box.principal, '.dev', 'stack.yml'),
    `${stack}\nworktree:\n  base: ${path.join(root, 'worktrees')}\n`,
  )
  writeFileSync(path.join(box.principal, 'README.md'), 'base\n')
  git(box.principal, 'add', '.')
  git(box.principal, 'commit', '-qm', 'chore: base')
  git(box.principal, 'push', '-q', 'origin', 'main')
  git(box.principal, 'remote', 'set-head', 'origin', 'main')
  mkdirSync(path.dirname(box.epic), { recursive: true })
  git(box.principal, 'worktree', 'add', '-q', '--detach', box.epic, 'refs/remotes/origin/main')
  return box
}

export function sandboxOf(): Sandbox {
  if (!box) throw new Error('no sandbox')
  return box
}

export function writes(): string[] {
  try {
    return readFileSync(path.join(sandboxOf().state, 'writes.log'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function runContainment(script: string) {
  const { epic: cwd, env } = sandboxOf()
  const { bun } = epicRuntime()
  const out = spawnSync(bun, ['--no-env-file', '--no-install', '-e', script], { cwd, env, encoding: 'utf8' })
  return { code: out.status, stderr: out.stderr, json: () => JSON.parse(out.stdout) }
}

export function readControlTarget() {
  return runContainment(`
    import { readEpicControlTarget } from ${JSON.stringify(CONTROL)}
    console.log(JSON.stringify(await readEpicControlTarget(process.cwd(), 1)))
  `)
}

export function disarmControlTarget(mandate: SelectedMandateAuthority['mandate']) {
  return runContainment(`
    import * as loaded from ${JSON.stringify(CONTRACTS)}
    import { disarmKnownTarget } from ${JSON.stringify(FEATURE_DISARM)}
    import { gh } from ${JSON.stringify(RUNTIME)}
    const result = await disarmKnownTarget(async (cwd, args) => gh(cwd, args), process.cwd(), {
      status: 'issue',
      scope: { repository: 'o/r', target: 'o/r#1' },
      issue: { number: 1 },
    }, 'epic', null, { loaded, mandate: ${JSON.stringify(mandate)} })
    console.log(JSON.stringify(result))
  `)
}
