import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const BOOT = path.resolve(import.meta.dirname, 'worktree-bootstrap.sh')
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: ENV, stdio: 'ignore' })
}

function principalWith(stack: string): { repo: string; wt: string } {
  root = mkdtempSync(path.join(tmpdir(), 'omp-build-bootstrap-'))
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, '.dev'), { recursive: true })
  writeFileSync(path.join(repo, '.dev', 'stack.yml'), stack)
  writeFileSync(path.join(repo, '.env'), 'REAL=1\n')
  writeFileSync(path.join(repo, '.env.example'), 'EXAMPLE=1\n')
  mkdirSync(path.join(repo, 'cache'))
  writeFileSync(path.join(repo, 'cache', 'state.db'), 'seed\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.dev/stack.yml', '.env.example')
  git(repo, 'commit', '-q', '-m', 'chore: base')
  const wt = path.join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/x')
  return { repo, wt }
}

const STACK = `worktree:
  copy:
    - .env
  seed:
    - cache/state.db
  setup: touch setup-ran
`

describe('worktree bootstrap', () => {
  it('copies, seeds and runs setup once, then no-ops', () => {
    const { repo, wt } = principalWith(STACK)
    const before = statSync(path.join(repo, '.env')).mtimeMs
    const first = execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })
    expect(first.trim()).toBe('bootstrap=done')
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('REAL=1\n')
    expect(readFileSync(path.join(wt, 'cache', 'state.db'), 'utf8')).toBe('seed\n')
    expect(readFileSync(path.join(wt, 'setup-ran'), 'utf8')).toBe('')
    const stamped = statSync(path.join(wt, 'setup-ran')).mtimeMs
    const second = execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })
    expect(second.trim()).toBe('bootstrap=noop')
    expect(statSync(path.join(wt, 'setup-ran')).mtimeMs).toBe(stamped)
    expect(statSync(path.join(repo, '.env')).mtimeMs).toBe(before)
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('REAL=1\n')
  })

  it('does not copy an example in place of a missing real file', () => {
    const { repo, wt } = principalWith(`worktree:\n  copy:\n    - secrets.env\n`)
    writeFileSync(path.join(repo, 'secrets.env.example'), 'EXAMPLE=1\n')
    execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })
    expect(() => statSync(path.join(wt, 'secrets.env'))).toThrow()
    expect(() => statSync(path.join(wt, 'secrets.env.example'))).toThrow()
  })
  it('refuses to write on the principal', () => {
    const { repo } = principalWith(STACK)
    expect(() => execFileSync('bash', [BOOT], { cwd: repo, env: ENV, encoding: 'utf8' })).toThrow(/bootstrap=refused/)
  })

  it('does not write on the principal through a checkout symlink', () => {
    const { repo, wt } = principalWith(`worktree:\n  copy:\n    - out/NEW\n`)
    mkdirSync(path.join(repo, 'out'))
    writeFileSync(path.join(repo, 'out', 'NEW'), 'src-bytes\n')
    execFileSync('ln', ['-s', repo, path.join(wt, 'out')])
    expect(() => execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })).toThrow(/bootstrap=refused symlink/)
    expect(() => statSync(path.join(repo, 'NEW'))).toThrow()
    expect(readFileSync(path.join(repo, 'out', 'NEW'), 'utf8')).toBe('src-bytes\n')
  })
})
