import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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

function run(args: string[]): { ok: string; reason: string; stdout: string } {
  const r = spawnSync('bash', [RUN, ...args], { encoding: 'utf-8', cwd: ROOT })
  const stdout = r.stdout ?? ''
  return {
    ok: stdout.match(/^oracle_ok=(.*)$/m)?.[1] ?? '',
    reason: stdout.match(/^oracle_reason=(.*)$/m)?.[1] ?? '',
    stdout,
  }
}

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
    const forged = join(dir, 'forged-row.json')
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', cwd: ROOT }).stdout.trim()
    // Claim proven for deleting this tracked script while test_cmd is `true` (always passes).
    writeFileSync(
      forged,
      JSON.stringify({
        schema_version: '1',
        issue: 417,
        head,
        runner_id: 'forged',
        oracle_ok: true,
        oracle_reason: 'ok',
        rows: [
          {
            sc_id: 'SC1',
            sources: ['plugins/dev-core/skills/pr/run-falsify.sh'],
            source_hashes: { 'plugins/dev-core/skills/pr/run-falsify.sh': 'deadbeef' },
            test_cmd: 'true',
            fail_exit: 1,
            pass_exit: 0,
            error: 'AssertionError: forged',
            status: 'proven',
          },
        ],
      }),
    )
    const out = run(['--verify', forged])
    expect(out.ok).toBe('false')
    expect(['tautology', 'no-proven-row', 'row-failed']).toContain(out.reason)
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
  it('map with real source+failing test when absent → oracle_ok=true', () => {
    // Use a tiny fixture under tmp that we copy into repo? Better: use existing tracked file
    // and a test_cmd that greps for a unique string in run-falsify.sh — fails if file deleted.
    const map = join(dir, 'map.json')
    const outPath = join(dir, 'good.json')
    const src = 'plugins/dev-core/skills/pr/run-falsify.sh'
    writeFileSync(
      map,
      JSON.stringify({
        issue: 417,
        rows: [
          {
            sc_id: 'SC1',
            sources: [src],
            test_cmd: `grep -q 'Plugin-owned falsify oracle' ${src}`,
          },
        ],
      }),
    )
    const out = run(['--map', map, '--out', outPath, '--issue', '417'])
    expect(out.ok).toBe('true')
    expect(out.reason).toBe('ok')
    const doc = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(doc.schema_version).toBe('1')
    expect(doc.oracle_ok).toBe(true)
    expect(doc.rows[0].status).toBe('proven')

    // verify re-exec succeeds
    const v = run(['--verify', outPath])
    expect(v.ok).toBe('true')
  })
})
