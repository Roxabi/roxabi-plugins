import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

// Stand-ins for ccc and codegraph: each call logs its argv, physical cwd and the
// worktree's .cocoindex_code contents at the moment the indexer starts.
function fakeIndexers(dir: string): { env: NodeJS.ProcessEnv; log: string } {
  const bin = path.join(dir, 'bin')
  const log = path.join(dir, 'indexers.log')
  mkdirSync(bin)
  for (const name of ['ccc', 'codegraph']) {
    const file = path.join(bin, name)
    writeFileSync(
      file,
      `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' "${name} $*" "$(pwd -P)" "$(ls .cocoindex_code 2>/dev/null | paste -sd, -)" >> '${log}'\n`,
    )
    chmodSync(file, 0o755)
  }
  return { env: { ...ENV, PATH: `${bin}:${ENV.PATH}` }, log }
}

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
    expect(() => execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })).toThrow(
      /bootstrap=refused symlink/,
    )
    expect(() => statSync(path.join(repo, 'NEW'))).toThrow()
    expect(readFileSync(path.join(repo, 'out', 'NEW'), 'utf8')).toBe('src-bytes\n')
  })

  it('indexes the worktree itself, starting ccc from a copy of the principal stores', () => {
    const { repo, wt } = principalWith('')
    const ccc = path.join(repo, '.cocoindex_code')
    mkdirSync(path.join(ccc, 'cocoindex.db', 'mdb'), { recursive: true })
    writeFileSync(path.join(ccc, 'settings.yml'), 'include_patterns: []\n')
    writeFileSync(path.join(ccc, 'cocoindex.db', 'mdb', 'data.mdb'), 'state\n')
    const sql = (db: string, query: string) =>
      execFileSync(
        'python3',
        [
          '-c',
          'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute(sys.argv[2]).fetchall()); c.commit()',
          db,
          query,
        ],
        { encoding: 'utf8' },
      )
    sql(path.join(ccc, 'target_sqlite.db'), 'create table chunks(path)')
    sql(path.join(ccc, 'target_sqlite.db'), "insert into chunks values ('src/a.ts')")
    mkdirSync(path.join(repo, '.codegraph'))
    writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'graph\n')
    const { env, log } = fakeIndexers(path.dirname(repo))
    const here = realpathSync(wt)

    const out = execFileSync('bash', [BOOT], { cwd: wt, env, encoding: 'utf8' })

    expect(out.trim().split('\n').at(-1)).toBe('bootstrap=done')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `ccc index|${here}|cocoindex.db,settings.yml,target_sqlite.db`,
      `codegraph init -y ${here}|${here}|cocoindex.db,settings.yml,target_sqlite.db`,
    ])
    expect(readFileSync(path.join(wt, '.cocoindex_code', 'settings.yml'), 'utf8')).toBe('include_patterns: []\n')
    expect(readFileSync(path.join(wt, '.cocoindex_code', 'cocoindex.db', 'mdb', 'data.mdb'), 'utf8')).toBe('state\n')
    expect(sql(path.join(wt, '.cocoindex_code', 'target_sqlite.db'), 'select path from chunks').trim()).toBe(
      "[('src/a.ts',)]",
    )
  })

  it('starts no indexer when the principal only holds tool config, not an index', () => {
    const { repo, wt } = principalWith('')
    mkdirSync(path.join(repo, '.cocoindex_code'))
    writeFileSync(path.join(repo, '.cocoindex_code', 'global_settings.yml'), 'embedding: {}\n')
    mkdirSync(path.join(repo, '.codegraph'))
    writeFileSync(path.join(repo, '.codegraph', 'telemetry.json'), '{}\n')
    const { env, log } = fakeIndexers(path.dirname(repo))

    const out = execFileSync('bash', [BOOT], { cwd: wt, env, encoding: 'utf8' })

    expect(out.trim()).toBe('bootstrap=done')
    expect(existsSync(log)).toBe(false)
    expect(existsSync(path.join(wt, '.cocoindex_code'))).toBe(false)
  })
})
