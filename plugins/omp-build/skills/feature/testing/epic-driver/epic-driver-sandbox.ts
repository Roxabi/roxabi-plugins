import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { epicRuntime } from './epic-driver-gh-stub.ts'

/**
 * The driver's I/O shell, end to end: a real git repository (a bare origin, the
 * Principal clone, a detached epic worktree) and a stub `gh` that serves canned
 * GraphQL and records every write. Each case asserts what the driver did to git
 * and what it wrote to GitHub, in order.
 */

const DRIVER = path.resolve(import.meta.dirname, '..', '..', 'epic-driver.ts')

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

export function drive(args: string[], { cwd = sandboxOf().epic, epic = 1 } = {}) {
  const { env } = sandboxOf()
  const { bun } = epicRuntime()
  const command = env.DRIVER_STRACE ? ['strace', '-f', '-e', 'trace=openat,write', '-o', env.DRIVER_STRACE, bun] : [bun]
  const out = spawnSync(command[0], [...command.slice(1), DRIVER, ...args, '--epic', String(epic)], {
    cwd,
    env,
    encoding: 'utf8',
  })
  return { code: out.status, stdout: out.stdout, stderr: out.stderr, json: () => JSON.parse(out.stdout) }
}

export function detail(text: string): string[] {
  const file = path.join(sandboxOf().root, 'detail.txt')
  writeFileSync(file, text)
  return ['--detail-file', file]
}
