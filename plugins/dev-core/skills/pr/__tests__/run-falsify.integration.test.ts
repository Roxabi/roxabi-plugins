import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const RUN = fileURLToPath(new URL('../run-falsify.sh', import.meta.url))
const ROOT = join(RUN, '..', '..', '..', '..', '..')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-falsify-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(args: string[], cwd = ROOT): { ok: string; reason: string; stdout: string; stderr: string } {
  const r = spawnSync('bash', [RUN, ...args], { encoding: 'utf-8', cwd })
  const stdout = r.stdout ?? ''
  return {
    ok: stdout.match(/^oracle_ok=(.*)$/m)?.[1] ?? '',
    reason: stdout.match(/^oracle_reason=(.*)$/m)?.[1] ?? '',
    stdout,
    stderr: r.stderr ?? '',
  }
}

// A throwaway repo that owns its own `.dev/stack.yml` contract: `commands.test` is a
// tiny checker that passes iff every named file contains MARK. The runner must derive
// what it runs from that contract, never from a row's free text (#541).
function fixtureRepo(stackYml: string | null = 'commands:\n  test: sh check.sh\n'): string {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.dev'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'check.sh'), 'for f in "$@"; do grep -q MARK "$f" || exit 1; done\n')
  writeFileSync(join(repo, 'src', 'lib.txt'), 'MARK\n')
  writeFileSync(join(repo, 'src', 'other.txt'), 'MARK\n')
  if (stackYml !== null) writeFileSync(join(repo, '.dev', 'stack.yml'), stackYml)
  const git = (...a: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf-8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return repo
}

function forgedArtifact(repo: string, rows: object[]): string {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', cwd: repo }).stdout.trim()
  const path = join(dir, 'forged-artifact.json')
  writeFileSync(
    path,
    JSON.stringify({ schema_version: '1', issue: 541, head, runner_id: 'forged', oracle_ok: true, rows }),
  )
  return path
}

describe('run-falsify.sh — test_cmd is re-derived from the contract, never executed as text (#541)', () => {
  // Each shape reaches a different refusal branch; the side effect proves nothing ran.
  it.each([
    [
      'shell sequencing',
      (pwned: string) => ({ sources: ['src/lib.txt'], test_cmd: `sh check.sh src/lib.txt; touch ${pwned}` }),
    ],
    [
      'command substitution',
      (pwned: string) => ({ sources: ['src/lib.txt'], test_cmd: `sh check.sh "$(touch ${pwned})"` }),
    ],
    [
      'a runner other than commands.test',
      (pwned: string) => ({ sources: ['src/lib.txt'], test_cmd: `sh -c 'touch ${pwned}' src/lib.txt` }),
    ],
    [
      'a test path escaping the repo',
      (pwned: string) => ({ sources: ['src/lib.txt'], test_cmd: `sh check.sh ../${pwned}` }),
    ],
  ])('--verify refuses %s and executes nothing', (_, shape) => {
    const repo = fixtureRepo()
    const pwned = join(dir, 'PWNED')
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC0', sources: ['src/lib.txt'], test_cmd: 'sh check.sh src/lib.txt', status: 'proven' },
      { sc_id: 'SC1', status: 'proven', ...shape(pwned) },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('refused-test-cmd:row1')
    expect(out.stderr).toContain("sc_id='SC1'")
    expect(existsSync(pwned)).toBe(false)
  })

  it('--verify refuses an absolute source path instead of deleting it', () => {
    const repo = fixtureRepo()
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'MARK\n')
    const artifact = forgedArtifact(repo, [
      { sc_id: 'SC1', sources: [victim], test_cmd: 'sh check.sh src/lib.txt', status: 'proven' },
    ])
    const out = run(['--verify', artifact], repo)
    expect(out.reason).toBe('refused-test-cmd:row0')
    expect(existsSync(victim)).toBe(true)
  })

  it('--verify with no commands.test in the contract executes nothing', () => {
    const repo = fixtureRepo(null)
    const pwned = join(dir, 'PWNED')
    const artifact = forgedArtifact(repo, [{ sc_id: 'SC1', sources: ['src/lib.txt'], test_cmd: `touch ${pwned}` }])
    const out = run(['--verify', artifact], repo)
    expect(out.ok).toBe('false')
    expect(out.reason).toBe('missing-test-command')
    expect(existsSync(pwned)).toBe(false)
  })
})

describe('run-falsify.sh — forged / empty fail-closed', () => {
  it('forged green json fails verify (empty rows sold as ok)', () => {
    const forged = join(dir, 'forged.json')
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', cwd: ROOT }).stdout.trim()
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
