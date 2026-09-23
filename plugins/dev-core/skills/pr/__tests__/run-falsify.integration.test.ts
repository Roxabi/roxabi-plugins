import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const RUN = fileURLToPath(new URL('../run-falsify.sh', import.meta.url))
const ROOT = join(RUN, '..', '..', '..', '..', '..')

// A git hook (lefthook pre-push runs this suite) exports GIT_DIR/GIT_INDEX_FILE, which
// beat `cwd`: without this, fixture commits land on the invoking branch (#541 review).
// Built per call, so a GIT_* present when the fixture runs is the one that gets dropped.
function cleanEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-falsify-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A PATH holding only the named tools, so a test can take one away from the runner.
function pathWith(tools: string[]): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const tool of tools) {
    const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim()
    symlinkSync(real, join(bin, tool))
  }
  return bin
}

function run(
  args: string[],
  cwd = ROOT,
  extraEnv: NodeJS.ProcessEnv = {},
): { ok: string; reason: string; stdout: string; stderr: string } {
  const env = { ...cleanEnv(), RF_LOG: ranLog(), ...extraEnv }
  const r = spawnSync('bash', [RUN, ...args], { encoding: 'utf-8', cwd, env })
  const stdout = r.stdout ?? ''
  return {
    ok: stdout.match(/^oracle_ok=(.*)$/m)?.[1] ?? '',
    reason: stdout.match(/^oracle_reason=(.*)$/m)?.[1] ?? '',
    stdout,
    stderr: r.stderr ?? '',
  }
}

// A throwaway repo that owns its own `.dev/stack.yml` contract: `commands.test` is a
// tiny checker that passes iff every named file contains MARK, and logs every run to
// RF_LOG (outside the repo) so a refusal can prove that nothing executed. The runner
// must derive what it runs from that contract, never from a row's free text (#541).
function ranLog(): string {
  return join(dir, 'ran.log')
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf-8',
    env: cleanEnv(),
  })
  if (r.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function fixtureRepo(
  stackYml: string | Buffer | null = 'commands:\n  test: sh check.sh\n',
  setup?: (repo: string) => void,
): string {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.dev'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'check.sh'), 'echo ran >> "$RF_LOG"\nfor f in "$@"; do grep -q MARK "$f" || exit 1; done\n')
  writeFileSync(join(repo, 'src', 'lib.txt'), 'MARK\n')
  writeFileSync(join(repo, 'src', 'other.txt'), 'MARK\n')
  if (stackYml !== null) writeFileSync(join(repo, '.dev', 'stack.yml'), stackYml)
  setup?.(repo)
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'fixture')
  return repo
}

function forgedArtifact(repo: string, rows: unknown[]): string {
  const head = git(repo, 'rev-parse', 'HEAD')
  const path = join(dir, 'forged-artifact.json')
  writeFileSync(
    path,
    JSON.stringify({ schema_version: '1', issue: 541, head, runner_id: 'forged', oracle_ok: true, rows }),
  )
  return path
}

describe('run-falsify.sh — test_cmd is re-derived from the contract, never executed as text (#541)', () => {
  // One row per refusal branch, behind a valid SC0. A refusal must stop SC0 too, so an
  // absent run log proves nothing executed; `why` pins which branch refused the row.
  it.each([
    ['shell sequencing', 'is not a plain relative path', { test_cmd: 'sh check.sh src/lib.txt; touch PWNED' }],
    [
      'a runner other than the contract',
      "does not start with the contract's test command",
      { test_cmd: 'sh other.sh src/lib.txt' },
    ],
    ['a row naming no test path', 'names no test path', { test_cmd: 'sh check.sh' }],
    ['a `..` segment after a plain one', 'is not a plain relative path', { test_cmd: 'sh check.sh src/../../x' }],
    ['an unbalanced quote', 'unparseable', { test_cmd: 'sh check.sh "src/lib.txt' }],
    ['a non-string test_cmd', 'test_cmd is not a string', { test_cmd: ['sh', 'check.sh', 'src/lib.txt'] }],
    // Deliberate: test paths reach argv, and the allowlist is that contract.
    ['a route-group path', 'is not a plain relative path', { test_cmd: 'sh check.sh app/(g)/x.test.ts' }],
    ['a test path the snapshot does not carry', 'is not a file in the snapshot', { test_cmd: 'sh check.sh src/nope' }],
    [
      'a source with a `..` segment',
      'sources must be relative paths',
      { test_cmd: 'sh check.sh src/lib.txt', sources: ['src/../../victim.txt'] },
    ],
    [
      'a `.` source (would remove the whole snapshot)',
      'sources must be relative paths',
      { test_cmd: 'sh check.sh src/lib.txt', sources: ['.'] },
    ],
    ['a non-object row', 'row must be an object', 'not-a-row'],
  ])('--verify refuses %s and executes nothing', (_, why, shape) => {
    const repo = fixtureRepo()
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC0', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt', status: 'proven' },
      typeof shape === 'string' ? shape : { sc_id: 'SC1', sources: ['src/lib.txt'], status: 'proven', ...shape },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('refused-test-cmd:row1')
    expect(out.stderr).toContain(
      typeof shape === 'string' ? 'refused row 1 (sc_id=None)' : "refused row 1 (sc_id='SC1')",
    )
    expect(out.stderr).toContain(why)
    expect(existsSync(ranLog())).toBe(false)
  })

  it.each([
    ['no .dev/stack.yml', null, 'missing-test-command'],
    ['only a nested test key', 'commands:\n  e2e:\n    test: sh check.sh\n', 'missing-test-command'],
    ['test under another top-level key', 'ci:\n  test: sh check.sh\ncommands:\n  lint: x\n', 'missing-test-command'],
    ['an empty scalar', 'commands:\n  test: ""\n', 'missing-test-command'],
    // YAML semantics now: a duplicate top-level key keeps the last one, which has no test.
    ['two commands blocks', 'commands:\n  test: sh check.sh\ncommands:\n  lint: x\n', 'missing-test-command'],
    ['a non-string value', 'commands:\n  test: true\n', 'unsupported-test-command'],
    [
      'a file over the size cap',
      `commands:\n  test: sh check.sh\n#${'x'.repeat(70_000)}\n`,
      'unsupported-test-command',
    ],
    ['shell syntax', 'commands:\n  test: sh check.sh && true\n', 'unsupported-test-command'],
    ['a VAR= prefix', 'commands:\n  test: CI=1 sh check.sh\n', 'unsupported-test-command'],
    ['an unbalanced quote', 'commands:\n  test: "sh check.sh\n', 'unsupported-test-command'],
    ['invalid YAML', 'commands:\n  test: sh a: b\n', 'unsupported-test-command'],
    [
      'a quoted value spanning lines (YAML reads no commands.test here)',
      'commands:\n  lint: "a\n  test: sh check.sh #"\n',
      'unsupported-test-command',
    ],
    ['a non-ASCII space', 'commands:\n  test: sh\u00a0check.sh\n', 'unsupported-test-command'],
    [
      'a trailing U+2028 (str.strip would eat it)',
      'commands:\n  test: "sh check.sh\\u2028"\n',
      'unsupported-test-command',
    ],
    [
      'a .nan test_file (JSON would read it as unset)',
      'commands:\n  test_file: .nan\n  test: sh check.sh\n',
      'unsupported-test-command',
    ],
    ['non-UTF-8 bytes', Buffer.from('commands:\n  test: sh check.sh \xff\n', 'latin1'), 'unsupported-test-command'],
    [
      'an unusable test_file (no fallback to test)',
      'commands:\n  test: sh check.sh\n  test_file: sh check.sh && x\n',
      'unsupported-test-command',
    ],
  ])('a contract with %s refuses every row and executes nothing', (_, stackYml, reason) => {
    const repo = fixtureRepo(stackYml)
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.ok).toBe('false')
    expect(out.reason).toBe(reason)
    expect(existsSync(ranLog())).toBe(false)
  })

  // What YAML reads is what runs: the reader is a YAML parser, not a line matcher (#541, RC-B).
  it.each([
    ['a quoted scalar', 'commands:\n  test: "sh check.sh"\n'],
    [
      'a trailing comment beside a nested test key',
      'commands:\n  e2e:\n    test: sh evil.sh\n  test: sh check.sh  # checker\n',
    ],
    ['test_file, which wins over test', 'commands:\n  test: sh broken.sh\n  test_file: sh check.sh\n'],
    ['a quoted test_file key', 'commands:\n  test: sh broken.sh\n  "test_file": sh check.sh\n'],
    ['a duplicate key (the last one wins)', 'commands:\n  test: sh evil.sh\n  test: sh check.sh\n'],
    ['a multi-line plain value (folded)', 'commands:\n  test: sh\n    check.sh\n'],
    [
      'non-ASCII comments (the shipped example style)',
      'commands:\n  lint: x  # vérifie — tout\n  test_file: sh check.sh  # optional — runs exactly the named files\n',
    ],
  ])('reads the contract command from %s', (_, stackYml) => {
    const repo = fixtureRepo(stackYml)
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    expect(run(['--verify', artifact], repo).ok).toBe('true')
  })

  it('--verify refuses an absolute source path instead of deleting it', () => {
    const repo = fixtureRepo()
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'MARK\n')
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: [victim], test_cmd: 'sh check.sh src/lib.txt', status: 'proven' },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('refused-test-cmd:row0')
    expect(out.stderr).toContain("sc_id='SC1'")
    expect(existsSync(victim)).toBe(true)
  })

  it('--verify fails a source that escapes through a committed symlink, deleting nothing', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'MARK\n')
    const repo = fixtureRepo(undefined, (r) => symlinkSync(outside, join(r, 'lnk')))
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['lnk/victim.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('source-escape')
    expect(existsSync(victim)).toBe(true)
  })

  it('a committed file symlink escaping as a source fails its row instead of crashing', () => {
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'MARK\n')
    const repo = fixtureRepo(undefined, (r) => symlinkSync(victim, join(r, 'link.txt')))
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['link.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.reason).toBe('source-escape')
    expect(readFileSync(victim, 'utf-8')).toBe('MARK\n')
  })

  it('a source that is a symlink to an in-tree dir is removed as a link, not crashed on', () => {
    const repo = fixtureRepo(undefined, (r) => symlinkSync('src', join(r, 'alias')))
    const artifact = forgedArtifact(repo, [{ sc_id: 'SC1', sources: ['alias'], test_cmd: 'sh check.sh src/lib.txt' }])
    const out = run(['--verify', artifact], repo)
    expect(out.reason).toBe('tautology')
  })

  it.each([
    [
      'through a committed dir symlink',
      (r: string, outside: string) => symlinkSync(outside, join(r, 'lnk')),
      'lnk/evil.txt',
    ],
    ['that is a symlink loop', (r: string) => symlinkSync('loop', join(r, 'loop')), 'loop'],
  ])('--verify refuses a test path %s and executes nothing', (_, link, testPath) => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'evil.txt'), 'MARK\n')
    const repo = fixtureRepo(undefined, (r) => link(r, outside))
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: `sh check.sh ${testPath}` },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.reason).toBe('refused-test-cmd:row0')
    expect(out.stderr).toContain('is not a file in the snapshot')
    expect(existsSync(ranLog())).toBe(false)
  })

  it('a dot-directory source is accepted (sources never reach argv)', () => {
    const repo = fixtureRepo(undefined, (r) => {
      mkdirSync(join(r, '.cfg'))
      writeFileSync(join(r, '.cfg', 'x.txt'), 'MARK\n')
    })
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['.cfg/x.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.reason).toBe('tautology')
    expect(out.stderr).not.toContain('refused row')
  })

  it('an ambient GIT_DIR cannot stand in for the checkout the runner was invoked in', () => {
    const repo = fixtureRepo()
    const decoy = join(dir, 'decoy')
    mkdirSync(decoy)
    git(decoy, 'init', '-q')
    git(decoy, 'commit', '-q', '--allow-empty', '-m', 'decoy')
    const decoyHead = git(decoy, 'rev-parse', 'HEAD')
    const artifact = join(dir, 'decoy-artifact.json')
    writeFileSync(
      artifact,
      JSON.stringify({
        schema_version: '1',
        issue: 541,
        head: decoyHead,
        rows: [{ sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' }],
      }),
    )
    const out = run(['--verify', artifact], repo, { GIT_DIR: join(decoy, '.git') })
    expect(out.reason).toBe('head-mismatch')
  })

  it('fixture git ignores an ambient GIT_DIR (the hook that runs this suite exports one)', () => {
    const decoy = join(dir, 'decoy')
    mkdirSync(decoy)
    git(decoy, 'init', '-q')
    git(decoy, 'commit', '-q', '--allow-empty', '-m', 'decoy')
    const before = git(decoy, 'rev-parse', 'HEAD')
    const prev = process.env.GIT_DIR
    process.env.GIT_DIR = join(decoy, '.git')
    try {
      fixtureRepo()
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = prev
    }
    expect(git(decoy, 'rev-parse', 'HEAD')).toBe(before)
    expect(existsSync(join(dir, 'repo', '.git'))).toBe(true)
  })

  it('an artifact the runner cannot parse still ends in a fail-closed verdict', () => {
    const repo = fixtureRepo()
    const map = join(dir, 'broken.json')
    writeFileSync(map, '{ not json')
    const out = run(['--map', map], repo)
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('runner-error')
  })

  it('--verify refuses rows that are not a list as a bad schema', () => {
    const repo = fixtureRepo()
    const artifact = join(dir, 'rows-object.json')
    writeFileSync(
      artifact,
      JSON.stringify({ schema_version: '1', issue: 541, head: git(repo, 'rev-parse', 'HEAD'), rows: { a: 1 } }),
    )
    expect(run(['--verify', artifact], repo).reason).toBe('bad-schema')
  })

  it('a symlinked source is recorded without reading through the link', () => {
    const repo = fixtureRepo(undefined, (r) => symlinkSync('src/lib.txt', join(r, 'alias.txt')))
    const map = join(dir, 'map.json')
    const outPath = join(dir, 'alias.json')
    writeFileSync(
      map,
      JSON.stringify({
        issue: 541,
        rows: [{ sc_id: 'SC1', sources: ['alias.txt'], test_cmd: 'sh check.sh src/lib.txt' }],
      }),
    )
    run(['--map', map, '--out', outPath, '--issue', '541'], repo)
    expect(JSON.parse(readFileSync(outPath, 'utf-8')).rows[0].source_hashes).toEqual({ 'alias.txt': 'missing' })
  })

  it('--map refuses a bad row and records the refusal in the artifact it writes', () => {
    const repo = fixtureRepo()
    const map = join(dir, 'map.json')
    const outPath = join(dir, 'refused.json')
    writeFileSync(
      map,
      JSON.stringify({
        issue: 541,
        rows: [{ sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh other.sh src/lib.txt' }],
      }),
    )
    const out = run(['--map', map, '--out', outPath, '--issue', '541'], repo)
    expect(out.reason).toBe('refused-test-cmd:row0')
    expect(JSON.parse(readFileSync(outPath, 'utf-8'))).toMatchObject({
      oracle_ok: false,
      oracle_reason: 'refused-test-cmd:row0',
      rows: [],
    })
    expect(existsSync(ranLog())).toBe(false)
  })

  it('a commands.test installed under gitignored node_modules still runs in the snapshot', () => {
    const repo = fixtureRepo('commands:\n  test: sh node_modules/checker/check.sh\n', (r) => {
      writeFileSync(join(r, 'package.json'), '{}\n')
      writeFileSync(join(r, '.gitignore'), 'node_modules/\n')
      mkdirSync(join(r, 'node_modules', 'checker'), { recursive: true })
      writeFileSync(
        join(r, 'node_modules', 'checker', 'check.sh'),
        'for f in "$@"; do grep -q MARK "$f" || exit 1; done\n',
      )
    })
    const map = join(dir, 'map.json')
    const outPath = join(dir, 'deps.json')
    writeFileSync(
      map,
      JSON.stringify({
        issue: 541,
        rows: [{ sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh node_modules/checker/check.sh src/lib.txt' }],
      }),
    )
    const out = run(['--map', map, '--out', outPath, '--issue', '541'], repo)
    expect(out.reason).toBe('ok')
    expect(JSON.parse(readFileSync(outPath, 'utf-8')).rows[0].status).toBe('proven')
  })

  it('a workspace link into the repo resolves to the snapshot, so a deleted source is really gone', () => {
    const repo = fixtureRepo(undefined, (r) => {
      writeFileSync(join(r, 'package.json'), '{}\n')
      writeFileSync(join(r, '.gitignore'), 'node_modules/\n.venv/\n')
      mkdirSync(join(r, 'packages', 'lib'), { recursive: true })
      writeFileSync(join(r, 'packages', 'lib', 'index.txt'), 'MARK\n')
      mkdirSync(join(r, 'node_modules', '@s'), { recursive: true })
      symlinkSync('../../packages/lib', join(r, 'node_modules', '@s', 'lib'))
    })
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['packages/lib/index.txt'], test_cmd: 'sh check.sh node_modules/@s/lib/index.txt' },
    ])
    expect(run(['--verify', artifact], repo).reason).toBe('ok')
  })

  // ── Root causes of the round-3 review (#570) ─────────────────────────────────────
  it('an untracked .venv link (a worktree pointing at the main venv) is never carried into the snapshot', () => {
    const mainVenv = join(dir, 'main-venv')
    mkdirSync(mainVenv)
    writeFileSync(join(mainVenv, 'check.sh'), 'echo through >> "$RF_LOG"\nexit 0\n')
    const repo = fixtureRepo('commands:\n  test: sh .venv/check.sh\n', (r) =>
      writeFileSync(join(r, '.gitignore'), '.venv/\n'),
    )
    symlinkSync(mainVenv, join(repo, '.venv')) // made after checkout, as the scaffold does
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh .venv/check.sh src/lib.txt' },
    ])
    expect(run(['--verify', artifact], repo).reason).toBe('restore-failed')
    expect(existsSync(ranLog())).toBe(false)
  })

  it('a node_modules link in the archive does not redirect where dependency links are written', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    const repo = fixtureRepo(undefined, (r) => {
      writeFileSync(join(r, 'package.json'), '{}\n')
      symlinkSync(outside, join(r, 'node_modules')) // committed as a link
    })
    unlinkSync(join(repo, 'node_modules'))
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true }) // an install replaced it
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    run(['--verify', artifact], repo)
    expect(readdirSync(outside)).toEqual([])
  })

  it('a .dev/stack.yml that is a link (to /dev/zero) is refused unread', () => {
    const repo = fixtureRepo(null, (r) => symlinkSync('/dev/zero', join(r, '.dev', 'stack.yml')))
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.reason).toBe('unsupported-test-command')
    expect(out.stderr).toContain('not a regular file')
  })

  it('a source behind a committed dir link is neither deleted nor hashed', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    const repo = fixtureRepo(undefined, (r) => symlinkSync(outside, join(r, 'd')))
    const map = join(dir, 'map.json')
    const outPath = join(dir, 'escape.json')
    writeFileSync(
      map,
      JSON.stringify({
        issue: 541,
        rows: [{ sc_id: 'SC1', sources: ['d/secret.txt'], test_cmd: 'sh check.sh src/lib.txt' }],
      }),
    )
    expect(run(['--map', map, '--out', outPath, '--issue', '541'], repo).reason).toBe('source-escape')
    expect(JSON.parse(readFileSync(outPath, 'utf-8')).rows[0].source_hashes).toEqual({ 'd/secret.txt': 'missing' })
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('secret\n')
  })

  it('a committed json.py cannot forge the verdict (python runs isolated from the checkout)', () => {
    const repo = fixtureRepo(undefined, (r) =>
      writeFileSync(
        join(r, 'json.py'),
        'import os\nos.write(1, b"oracle_ok=true\\noracle_reason=ok\\n")\nos._exit(0)\n',
      ),
    )
    const stale = join(dir, 'stale.json')
    writeFileSync(stale, JSON.stringify({ schema_version: '1', head: '0'.repeat(40), rows: [{}] }))
    expect(run(['--verify', stale], repo).reason).toBe('head-mismatch')
  })

  it('a test in the snapshot cannot find the repository above it, even with TMPDIR inside the work tree', () => {
    const repo = fixtureRepo('commands:\n  test: sh gitcheck.sh\n', (r) => {
      writeFileSync(join(r, '.gitignore'), '.tmp/\n')
      writeFileSync(
        join(r, 'gitcheck.sh'),
        'git rev-parse --git-dir >/dev/null 2>&1 && echo found >> "$RF_LOG"\nfor f in "$@"; do grep -q MARK "$f" || exit 1; done\n',
      )
    })
    mkdirSync(join(repo, '.tmp'))
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh gitcheck.sh src/lib.txt' },
    ])
    expect(run(['--verify', artifact], repo, { TMPDIR: join(repo, '.tmp') }).reason).toBe('ok')
    expect(existsSync(ranLog())).toBe(false)
  })

  it('the first failing row names the reason, not the last', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    const repo = fixtureRepo(undefined, (r) => {
      symlinkSync(outside, join(r, 'd'))
      writeFileSync(join(r, 'src', 'nomark.txt'), 'none\n')
    })
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['d/x.txt'], test_cmd: 'sh check.sh src/lib.txt' },
      { sc_id: 'SC2', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/nomark.txt' },
    ])
    expect(run(['--verify', artifact], repo).reason).toBe('source-escape')
  })

  it('an archive dir link replaced by a real dir cannot redirect the overlay', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    const repo = fixtureRepo(undefined, (r) => symlinkSync(outside, join(r, 'lnk'))) // committed as a link
    unlinkSync(join(repo, 'lnk'))
    mkdirSync(join(repo, 'lnk'))
    writeFileSync(join(repo, 'lnk', 'f.txt'), 'planted\n') // untracked, listed by the overlay
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    expect(run(['--verify', artifact], repo).reason).toBe('runner-error')
    expect(readdirSync(outside)).toEqual([])
  })

  it('a .dev/stack.yml that is not a regular file (a FIFO) is refused, not read', () => {
    const repo = fixtureRepo(null)
    spawnSync('mkfifo', [join(repo, '.dev', 'stack.yml')])
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.reason).toBe('unsupported-test-command')
    expect(out.stderr).toContain('not a regular file')
  })

  it('the YAML read loads nothing from the checkout (bun -e honours a cwd bunfig.toml preload)', () => {
    const repo = fixtureRepo(undefined, (r) => {
      writeFileSync(join(r, 'bunfig.toml'), 'preload = ["./evil.ts"]\n')
      writeFileSync(join(r, 'evil.ts'), 'require("node:fs").appendFileSync(process.env.RF_LOG, "preload\\n")\n')
    })
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    run(['--verify', artifact], repo)
    expect(existsSync(ranLog()) ? readFileSync(ranLog(), 'utf-8') : '').not.toContain('preload')
  })

  it('without bun, the contract is refused and the cause named — never read by hand', () => {
    const repo = fixtureRepo()
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const out = run(['--verify', artifact], repo, { PATH: pathWith(['bash', 'sed', 'tail', 'python3', 'git']) })
    expect(out.reason).toBe('unsupported-test-command')
    expect(out.stderr).toContain('bun is required')
  })

  it('a runner that dies without a verdict still ends in a fail-closed one', () => {
    const repo = fixtureRepo()
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const out = run(['--verify', artifact], repo, { PATH: pathWith(['bash', 'sed', 'tail']) }) // no python3
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('runner-error')
  })

  it('a staged .venv link pointing outside the checkout is not carried either', () => {
    const mainVenv = join(dir, 'main-venv')
    mkdirSync(mainVenv)
    writeFileSync(join(mainVenv, 'check.sh'), 'echo through >> "$RF_LOG"\nexit 0\n')
    const repo = fixtureRepo('commands:\n  test: sh .venv/check.sh\n', (r) =>
      writeFileSync(join(r, '.gitignore'), '.venv/\n'),
    )
    symlinkSync(mainVenv, join(repo, '.venv'))
    git(repo, 'add', '.venv') // `.venv/` does not match a link, so an add stages it
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh .venv/check.sh src/lib.txt' },
    ])
    expect(run(['--verify', artifact], repo).reason).toBe('restore-failed')
    expect(existsSync(ranLog())).toBe(false)
  })

  it('--out never writes through a committed artifact link', () => {
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'untouched\n')
    const repo = fixtureRepo(undefined, (r) => {
      mkdirSync(join(r, 'artifacts', 'reviews'), { recursive: true })
      symlinkSync(victim, join(r, 'artifacts', 'reviews', '541-falsify.json'))
    })
    const map = join(dir, 'map.json')
    writeFileSync(
      map,
      JSON.stringify({
        issue: 541,
        rows: [{ sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' }],
      }),
    )
    const out = run(['--map', map, '--out', 'artifacts/reviews/541-falsify.json', '--issue', '541'], repo)
    expect(out.ok).toBe('false')
    expect(readFileSync(victim, 'utf-8')).toBe('untouched\n')
  })

  it('a bun without Bun.YAML is named as the cause, not blamed on the YAML', () => {
    const repo = fixtureRepo()
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' },
    ])
    const bin = pathWith(['bash', 'sed', 'tail', 'python3', 'git'])
    const realBun = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' }).stdout.trim()
    const hide = join(dir, 'hide-yaml.js')
    writeFileSync(hide, 'Object.defineProperty(Bun, "YAML", { value: undefined })\n')
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec "${realBun}" --preload "${hide}" "$@"\n`, { mode: 0o755 })
    const out = run(['--verify', artifact], repo, { PATH: bin })
    expect(out.reason).toBe('unsupported-test-command')
    expect(out.stderr).toContain('bun >= 1.2.21 is required')
  })
})

describe('run-falsify.sh — forged / empty fail-closed', () => {
  it('forged green json fails verify (empty rows sold as ok)', () => {
    const forged = join(dir, 'forged.json')
    const head = git(ROOT, 'rev-parse', 'HEAD')
    writeFileSync(
      forged,
      JSON.stringify({
        schema_version: '1',
        issue: 417,
        head,
        runner_id: 'forged',
        oracle_ok: true,
        oracle_reason: 'ok',
        rows: [],
      }),
    )
    const out = run(['--verify', forged])
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('empty-map')
  })

  it('forged green json with tautological row fails verify', () => {
    // Claims proven for deleting src/lib.txt, but the test reads src/other.txt: it passes with the source absent.
    const repo = fixtureRepo()
    const forged = forgedArtifact(repo, [
      {
        sc_id: 'SC1',
        sources: ['src/lib.txt'],
        test_cmd: 'sh check.sh src/other.txt',
        error: 'AssertionError: forged',
        status: 'proven',
      },
    ])
    const out = run(['--verify', forged], repo)
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('tautology')
  })

  it('empty map → oracle_ok=false', () => {
    const map = join(dir, 'empty.json')
    writeFileSync(map, JSON.stringify({ issue: 417, rows: [] }))
    const outPath = join(dir, 'out.json')
    const out = run(['--map', map, '--out', outPath, '--issue', '417'])
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('empty-map')
  })

  it('head mismatch → verify false', () => {
    const forged = join(dir, 'stale.json')
    writeFileSync(
      forged,
      JSON.stringify({
        schema_version: '1',
        issue: 417,
        head: '0'.repeat(40),
        runner_id: 'forged',
        oracle_ok: true,
        rows: [{ sc_id: 'SC1', sources: ['x'], test_cmd: 'false', status: 'proven' }],
      }),
    )
    const out = run(['--verify', forged])
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('head-mismatch')
  })

  it('missing verify target → missing-artifact', () => {
    const out = run(['--verify', join(dir, 'nope.json')])
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('missing-artifact')
  })
})

describe('run-falsify.sh — real fail→pass path', () => {
  it('map with real source+failing test when absent → oracle_ok=true, and verify re-derives it', () => {
    const repo = fixtureRepo()
    const map = join(dir, 'map.json')
    const outPath = join(dir, 'good.json')
    writeFileSync(
      map,
      JSON.stringify({
        issue: 541,
        rows: [{ sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt' }],
      }),
    )
    const out = run(['--map', map, '--out', outPath, '--issue', '541'], repo)
    expect(out.ok).toBe('true')
    expect(out.reason).toBe('ok')
    const doc = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(doc.schema_version).toBe('1')
    expect(doc.oracle_ok).toBe(true)
    expect(doc.rows[0].status).toBe('proven')

    const v = run(['--verify', outPath], repo)
    expect(v.ok).toBe('true')
  })
})
