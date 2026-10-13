import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from './fixtures/github-api'

function exited(pid: number): boolean {
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) return false
    // Process death is the platform behavior under test; fake timers cannot drive it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
}

function killIfRunning(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

describe('recipe runner process-group ownership', () => {
  it('kills a pipe-holding descendant after Bash exits before the deadline', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'issue-triage-runner-deadline-'))
    const pidFile = path.join(root, 'child.pid')
    let childPid: number | undefined

    try {
      const began = performance.now()
      const ran = await run(
        `sleep 20 & echo $! > ${JSON.stringify(pidFile)}; exit 0`,
        root,
        { PATH: '/usr/bin:/bin' },
        100,
      )
      const elapsed = performance.now() - began
      childPid = Number(readFileSync(pidFile, 'utf8'))
      const childExited = exited(childPid)

      expect(ran).toMatchObject({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' })
      expect(elapsed).toBeLessThan(4_000)
      expect(childExited).toBe(true)
    } finally {
      killIfRunning(childPid)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves a completed Bash receipt while disposing a redirected descendant', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'issue-triage-runner-normal-'))
    const pidFile = path.join(root, 'child.pid')
    let childPid: number | undefined

    try {
      const ran = await run(`sleep 20 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; echo complete`, root, {
        PATH: '/usr/bin:/bin',
      })
      childPid = Number(readFileSync(pidFile, 'utf8'))
      const childExited = exited(childPid)

      expect(ran).toEqual({ code: 0, signal: null, stdout: 'complete\n', stderr: '' })
      expect(childExited).toBe(true)
    } finally {
      killIfRunning(childPid)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
