import { execFileSync, execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MockInstance } from 'vitest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Node echoes a sync child's stderr onto this worker's stderr when the call
 * passes no `stdio`. vitest does not attribute that write, so under a git hook
 * every expected usage error a fixture provokes printed as bare text and read
 * like a real failure. vitest.setup.ts drops the echo; the caller's options
 * must still reach the child, and a failing call must keep the child's stderr
 * on the error it throws, the one place a test reads it.
 */

// Builds its stderr marker at run time, so the marker never appears in a command
// line or in the `Command failed: …` message Node derives from one.
const SCRIPT = `#!/bin/sh
printf '%s-%s\\n' child noise >&2
if [ "$1" = fail ]; then printf '%s-%s\\n' child failure >&2; exit 3; fi
printf '%s:%s:%s' "$(pwd)" "$MARK" "$(cat)"
`

const dir = mkdtempSync(join(tmpdir(), 'child-stderr-'))
const script = join(dir, 'child.sh')
writeFileSync(script, SCRIPT)
chmodSync(script, 0o755)
const cwd = realpathSync(dir)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Node's own overloads accept these shapes; its type declarations do not all list them.
const run = {
  execFileSync: execFileSync as (...args: unknown[]) => unknown,
  execSync: execSync as (...args: unknown[]) => unknown,
}

const OPTIONS = { cwd, env: { PATH: process.env.PATH, MARK: 'mark' }, encoding: 'utf8', input: 'in' }
const ROUND_TRIP = `${cwd}:mark:in`

let write: MockInstance<typeof process.stderr.write>
const echoed = () => write.mock.calls.map(([chunk]) => String(chunk)).filter((chunk) => chunk.includes('child-'))

beforeEach(() => {
  write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a sync child process run by a test', () => {
  it.each([
    ['execFileSync(file)', () => run.execFileSync(script)],
    ['execFileSync(file, args)', () => run.execFileSync(script, [])],
    ['execFileSync(file, args, null)', () => run.execFileSync(script, [], null)],
    ['execFileSync(file, () => {})', () => run.execFileSync(script, () => {})],
    ['execSync(command)', () => run.execSync(script)],
    ['execSync(command, null)', () => run.execSync(script, null)],
    ['execSync(command, () => {})', () => run.execSync(script, () => {})],
  ])('%s keeps its stderr off the run output', (_, call) => {
    expect(Buffer.isBuffer(call())).toBe(true)
    expect(echoed()).toEqual([])
  })

  it.each([
    ['execFileSync(file, options)', () => run.execFileSync(script, OPTIONS)],
    ['execFileSync(file, null, options)', () => run.execFileSync(script, null, OPTIONS)],
    ['execFileSync(file, undefined, options)', () => run.execFileSync(script, undefined, OPTIONS)],
    ['execFileSync(file, args, options)', () => run.execFileSync(script, [], OPTIONS)],
    ['execFileSync(file, args, { stdio: null })', () => run.execFileSync(script, [], { ...OPTIONS, stdio: null })],
    ['execSync(command, options)', () => run.execSync(script, OPTIONS)],
    ['execSync(command, { stdio: null })', () => run.execSync(script, { ...OPTIONS, stdio: null })],
  ])('%s passes the options to the child and keeps its stderr off the run output', (_, call) => {
    expect(call()).toBe(ROUND_TRIP)
    expect(echoed()).toEqual([])
  })

  it.each([
    ['execFileSync', () => run.execFileSync('sh', ['-c', 'exec sleep 5'], { timeout: 100 })],
    ['execSync', () => run.execSync('exec sleep 5', { timeout: 100 })],
  ])('%s passes a timeout to the child', (_, call) => {
    expect(call).toThrow(expect.objectContaining({ code: 'ETIMEDOUT' }))
  })

  it.each([
    ['execFileSync(file, args, [])', () => run.execFileSync(script, [], [])],
    ["execFileSync(file, args, 'x')", () => run.execFileSync(script, [], 'x')],
  ])('%s is rejected, as Node rejects it', (_, call) => {
    expect(call).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
  })

  it.each([
    ['execFileSync', () => run.execFileSync(script, ['fail'])],
    ['execSync', () => run.execSync([script, 'fail'].join(' '))],
  ])('%s keeps the stderr of a failing child on the error it throws, and off the run output', (_, call) => {
    let error: (Error & { status?: number; stderr?: Buffer }) | undefined
    try {
      call()
    } catch (thrown) {
      error = thrown as typeof error
    }
    expect(error?.status).toBe(3)
    expect(String(error?.stderr)).toContain('child-failure')
    expect(echoed()).toEqual([])
  })

  // An ignored stdout is not captured, so the call returns null; a stdio overridden to `pipe` returns a Buffer.
  it.each([
    ['execFileSync(file, options)', () => run.execFileSync(script, { stdio: 'ignore' })],
    ['execFileSync(file, null, options)', () => run.execFileSync(script, null, { stdio: 'ignore' })],
    ['execFileSync(file, undefined, options)', () => run.execFileSync(script, undefined, { stdio: 'ignore' })],
    ['execFileSync(file, args, options)', () => run.execFileSync(script, [], { stdio: 'ignore' })],
    ['execSync(command, options)', () => run.execSync(script, { stdio: 'ignore' })],
  ])('%s keeps an explicit stdio as given', (_, call) => {
    expect(call()).toBeNull()
  })

  // An ignored stderr leaves nothing on the error; a stderr slot overridden to `pipe` fills it.
  it.each([
    ['execFileSync', () => run.execFileSync(script, ['fail'], { stdio: ['pipe', 'pipe', 'ignore'] })],
    ['execSync', () => run.execSync([script, 'fail'].join(' '), { stdio: ['pipe', 'pipe', 'ignore'] })],
  ])('%s keeps an explicit stderr slot as given on a failing call', (_, call) => {
    expect(call).toThrow(expect.objectContaining({ status: 3, stderr: null }))
  })
})
