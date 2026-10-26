import { execFile, execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const BOOT = path.resolve(import.meta.dirname, 'worktree-bootstrap.sh')
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
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

function principalWith(stack: string, files: Record<string, string> = {}): { repo: string; wt: string } {
  root = mkdtempSync(path.join(tmpdir(), 'omp-build-bootstrap-'))
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, '.dev'), { recursive: true })
  writeFileSync(path.join(repo, '.dev', 'stack.yml'), stack)
  writeFileSync(path.join(repo, '.env'), 'REAL=1\n')
  writeFileSync(path.join(repo, '.env.example'), 'EXAMPLE=1\n')
  mkdirSync(path.join(repo, 'cache'))
  writeFileSync(path.join(repo, 'cache', 'state.db'), 'seed\n')
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(repo, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '--', '.dev/stack.yml', '.env.example', ...Object.keys(files))
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

function withoutSemctx(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: env.PATH?.split(path.delimiter)
      .filter((entry) => !existsSync(path.join(entry, 'semctx')))
      .join(path.delimiter),
  }
}

describe('worktree bootstrap', () => {
  it.each([
    { name: 'block lists', stack: STACK },
    {
      name: 'flow lists',
      stack: 'worktree:\n  copy: [.env]\n  seed: [cache/state.db]\n  setup: touch setup-ran\n',
    },
  ])('copies, seeds and runs setup once, then no-ops with $name', ({ stack }) => {
    const { repo, wt } = principalWith(stack)
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

  it('treats producer-shaped empty lists as no transfer', () => {
    const { wt } = principalWith('worktree:\n  copy: []\n  seed: []\n  setup: ""\n')

    const out = execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(out.trim()).toBe('bootstrap=done')
    expect(existsSync(path.join(wt, '.env'))).toBe(false)
    expect(existsSync(path.join(wt, 'cache', 'state.db'))).toBe(false)
    expect(existsSync(path.join(wt, 'setup-ran'))).toBe(false)
  })

  it('boots without a stack file', () => {
    const { wt } = principalWith('')
    rmSync(path.join(wt, '.dev', 'stack.yml'))

    const out = execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(out.trim()).toBe('bootstrap=done')
  })

  it('copies and seeds through newline-ending parent directories without changing the source', () => {
    const copy = 'copy-parent\n/value.txt'
    const seed = 'seed-parent\n/state.db'
    const stack = `worktree:
  copy: [${JSON.stringify(copy)}]
  seed: [${JSON.stringify(seed)}]
`
    const { repo, wt } = principalWith(stack)
    mkdirSync(path.dirname(path.join(repo, copy)), { recursive: true })
    mkdirSync(path.dirname(path.join(repo, seed)), { recursive: true })
    writeFileSync(path.join(repo, copy), 'copy through newline\n')
    writeFileSync(path.join(repo, seed), 'seed through newline\n')

    execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(readFileSync(path.join(wt, copy), 'utf8')).toBe('copy through newline\n')
    expect(readFileSync(path.join(wt, seed), 'utf8')).toBe('seed through newline\n')
    expect(readFileSync(path.join(repo, copy), 'utf8')).toBe('copy through newline\n')
    expect(readFileSync(path.join(repo, seed), 'utf8')).toBe('seed through newline\n')
  })

  it('runs the declared setup file from the worktree once when only commands.worktree_setup exists', () => {
    const { repo, wt } = principalWith('commands:\n  worktree_setup: "tools/worktree setup.sh"\n', {
      'tools/worktree setup.sh': 'printf "%s\\n" "$PWD" >> setup-runs\n',
    })

    const first = execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })
    expect(first.trim()).toBe('bootstrap=done')
    expect(readFileSync(path.join(wt, 'setup-runs'), 'utf8')).toBe(`${realpathSync(wt)}\n`)
    expect(existsSync(path.join(repo, 'setup-runs'))).toBe(false)

    const second = execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })
    expect(second.trim()).toBe('bootstrap=noop')
    expect(readFileSync(path.join(wt, 'setup-runs'), 'utf8')).toBe(`${realpathSync(wt)}\n`)
  })

  it.each([
    { name: 'absent setup', prefix: 'worktree:\n', file: 'tools/setup.sh' },
    { name: 'empty setup', prefix: 'worktree:\n  setup: ""\n', file: 'tools/setup.sh' },
    { name: 'whitespace setup', prefix: 'worktree:\n  setup: "  "\n', file: 'tools/setup.sh' },
    { name: 'option-like filename', prefix: '', file: '--version' },
    { name: 'delimiter-like filename', prefix: '', file: '---' },
    { name: 'quoted filename with spaces', prefix: '', file: "tools/quote ' space.sh" },
  ])('runs the fallback file for $name', ({ prefix, file }) => {
    const { wt } = principalWith(`${prefix}commands:\n  worktree_setup: ${JSON.stringify(file)} # script path\n`, {
      [file]: 'printf "fallback\\n" > setup-runs\n',
    })

    execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(readFileSync(path.join(wt, 'setup-runs'), 'utf8')).toBe('fallback\n')
  })

  it('runs only a nonempty multiline snippet when a fallback file is also declared', () => {
    const { wt } = principalWith(
      `worktree:
  setup: |
    printf 'snippet\\n' >> setup-runs
    printf 'second\\n' >> setup-runs
commands:
  worktree_setup: tools/setup.sh
`,
      { 'tools/setup.sh': 'printf "fallback\\n" >> setup-runs\n' },
    )

    execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(readFileSync(path.join(wt, 'setup-runs'), 'utf8')).toBe('snippet\nsecond\n')
  })

  it('keeps the terminal setup newline that completes a Bash continuation', () => {
    const { wt } = principalWith(`worktree:
  setup: |
    touch terminal-continuation\\
`)

    execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(existsSync(path.join(wt, 'terminal-continuation'))).toBe(true)
    expect(existsSync(path.join(wt, 'terminal-continuation\\'))).toBe(false)
  })

  it('keeps multiline setup contents out of the copy list', () => {
    const { wt } = principalWith(`worktree:
  copy:
    - .env
  setup: |
    cat > generated.yml <<'EOF'
    - cache/state.db
    EOF
`)

    execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('REAL=1\n')
    expect(readFileSync(path.join(wt, 'generated.yml'), 'utf8')).toBe('- cache/state.db\n')
    expect(existsSync(path.join(wt, 'cache', 'state.db'))).toBe(false)
  })

  it.each([
    { name: 'exit code', ending: 'exit 19', status: 19 },
    { name: 'signal', ending: 'kill -TERM $$', status: null },
  ])('leaves setup retryable after a child $name failure', ({ ending, status }) => {
    const { repo, wt } = principalWith('commands:\n  worktree_setup: tools/setup.sh\n', {
      'tools/setup.sh': `printf 'failed\\n' >> setup-runs\n${ending}\n`,
    })
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt')

    const failed = spawnSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(failed.status).not.toBe(0)
    if (status !== null) expect(failed.status).toBe(status)
    expect(readFileSync(path.join(wt, 'setup-runs'), 'utf8')).toBe('failed\n')
    expect(existsSync(path.join(gitDir, 'omp-build-bootstrapped'))).toBe(false)
    expect(() => lstatSync(path.join(gitDir, 'omp-build-bootstrap.lock'))).toThrow(/ENOENT/)

    writeFileSync(path.join(wt, 'tools', 'setup.sh'), 'printf "retry\\n" >> setup-runs\n')
    const retry = execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(retry.trim()).toBe('bootstrap=done')
    expect(readFileSync(path.join(wt, 'setup-runs'), 'utf8')).toBe('failed\nretry\n')
    expect(existsSync(path.join(gitDir, 'omp-build-bootstrapped'))).toBe(true)
    expect(() => lstatSync(path.join(gitDir, 'omp-build-bootstrap.lock'))).toThrow(/ENOENT/)
  })

  it('fails malformed YAML before transfer, setup, indexing or marking, then retries after correction', () => {
    const { repo, wt } = principalWith('worktree:\n  copy: [.env\n  setup: touch setup-ran\n')
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt')
    const ccc = path.join(repo, '.cocoindex_code')
    mkdirSync(ccc)
    writeFileSync(path.join(ccc, 'settings.yml'), 'include_patterns: []\n')
    mkdirSync(path.join(repo, '.codegraph'))
    writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'graph\n')
    const { env, log } = fakeIndexers(path.dirname(repo))

    const failed = spawnSync('bash', [BOOT], { cwd: wt, env, encoding: 'utf8' })

    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain(path.join(wt, '.dev', 'stack.yml'))
    expect(existsSync(path.join(wt, '.env'))).toBe(false)
    expect(existsSync(path.join(wt, 'setup-ran'))).toBe(false)
    expect(existsSync(log)).toBe(false)
    expect(existsSync(path.join(gitDir, 'omp-build-bootstrapped'))).toBe(false)
    expect(() => lstatSync(path.join(gitDir, 'omp-build-bootstrap.lock'))).toThrow(/ENOENT/)

    writeFileSync(path.join(wt, '.dev', 'stack.yml'), 'worktree:\n  copy: [.env]\n  setup: touch setup-ran\n')
    execFileSync('bash', [BOOT], { cwd: wt, env, encoding: 'utf8' })

    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('REAL=1\n')
    expect(existsSync(path.join(wt, 'setup-ran'))).toBe(true)
    expect(readFileSync(log, 'utf8')).toContain('ccc index|')
    expect(readFileSync(log, 'utf8')).toContain('codegraph init -y')
    expect(existsSync(path.join(gitDir, 'omp-build-bootstrapped'))).toBe(true)
    expect(() => lstatSync(path.join(gitDir, 'omp-build-bootstrap.lock'))).toThrow(/ENOENT/)
  })

  it.each([
    { name: 'a scalar copy field', stack: 'worktree:\n  copy: .env\n' },
    { name: 'a NUL list value', stack: 'worktree:\n  copy: ["unsafe\u0000"]\n' },
  ])('rejects $name at the stack transport boundary', ({ stack }) => {
    const { repo, wt } = principalWith(stack)
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt')

    const failed = spawnSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain(path.join(wt, '.dev', 'stack.yml'))
    expect(existsSync(path.join(wt, '.env'))).toBe(false)
    expect(existsSync(path.join(gitDir, 'omp-build-bootstrapped'))).toBe(false)
    expect(() => lstatSync(path.join(gitDir, 'omp-build-bootstrap.lock'))).toThrow(/ENOENT/)
  })

  it.each([
    { name: 'missing records', body: 'exit 0\n' },
    { name: 'a truncated record', body: "printf 'copy\\0'\n" },
  ])('rejects missing or truncated Bun output with $name', ({ body }) => {
    const { repo, wt } = principalWith('worktree:\n  copy: []\n')
    const bin = path.join(path.dirname(repo), 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'bun'), `#!/usr/bin/env bash\n${body}`)
    chmodSync(path.join(bin, 'bun'), 0o755)
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt')

    const failed = spawnSync('bash', [BOOT], {
      cwd: wt,
      env: { ...ENV, PATH: `${bin}:${ENV.PATH}` },
      encoding: 'utf8',
    })

    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain(path.join(wt, '.dev', 'stack.yml'))
    expect(existsSync(path.join(gitDir, 'omp-build-bootstrapped'))).toBe(false)
    expect(() => lstatSync(path.join(gitDir, 'omp-build-bootstrap.lock'))).toThrow(/ENOENT/)
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

  it('indexes the worktree itself before setup despite a residual Semctx directory', () => {
    const { repo, wt } = principalWith('worktree:\n  setup: echo setup >> ../indexers.log\n')
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
    mkdirSync(path.join(wt, '.semctx'))
    const { env, log } = fakeIndexers(path.dirname(repo))
    const here = realpathSync(wt)

    const out = execFileSync('bash', [BOOT], { cwd: wt, env: withoutSemctx(env), encoding: 'utf8' })

    expect(out.trim().split('\n').at(-1)).toBe('bootstrap=done')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `ccc index|${here}|cocoindex.db,settings.yml,target_sqlite.db`,
      `codegraph init -y ${here}|${here}|cocoindex.db,settings.yml,target_sqlite.db`,
      'setup',
    ])
    expect(readFileSync(log, 'utf8')).not.toMatch(/semctx/i)
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

  it('runs setup once when two bootstraps race, the later one waiting then no-op', async () => {
    const { wt } = principalWith('worktree:\n  setup: echo run >> setup-runs; sleep 1\n')
    const run = () => promisify(execFile)('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8' })

    const outputs = await Promise.all([run(), run()])

    expect(outputs.map(({ stdout }) => stdout.trim()).sort()).toEqual(['bootstrap=done', 'bootstrap=noop'])
    expect(readFileSync(path.join(wt, 'setup-runs'), 'utf8')).toBe('run\n')
  })

  it('takes over the lock of a run that died', () => {
    const { repo, wt } = principalWith(STACK)
    const lock = path.join(repo, '.git', 'worktrees', 'wt', 'omp-build-bootstrap.lock')
    symlinkSync(String(spawnSync('true').pid), lock)

    const out = execFileSync('bash', [BOOT], { cwd: wt, env: ENV, encoding: 'utf8', timeout: 10_000 })

    expect(out.trim()).toBe('bootstrap=done')
    expect(() => lstatSync(lock)).toThrow(/ENOENT/)
  })
})
