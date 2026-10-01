import { execFileSync, execSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Node echoes a sync child's stderr onto this worker's stderr when the call
 * passes no `stdio`. vitest does not attribute that write, so under a git hook
 * every expected usage error a fixture provokes printed as bare text and read
 * like a real failure. vitest.setup.ts drops the echo; the child's stderr must
 * still reach the error a failing call throws, the one place a test reads it.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a sync child process run by a test', () => {
  it('keeps its stderr off the run output, and on the error it throws', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    execFileSync('sh', ['-c', 'echo child-noise >&2'])
    execFileSync('sh', { input: 'echo child-noise >&2' })
    execSync('echo child-noise >&2')
    expect(() => execFileSync('sh', ['-c', 'echo child-failure >&2; exit 3'])).toThrow(/child-failure/)

    const echoed = write.mock.calls.map(([chunk]) => String(chunk)).filter((chunk) => chunk.includes('child-'))
    expect(echoed).toEqual([])
  })
})
