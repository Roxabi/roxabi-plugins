import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from './fixtures/github-api'

type StatReader = (path: string, encoding: 'utf8') => string

const RUNNING: Record<string, true> = { R: true, S: true, D: true, T: true, t: true, W: true, I: true, P: true }

function executionState(pid: number, readStat: StatReader = readFileSync): string | null {
  try {
    const stat = readStat(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(') ') + 2).split(' ', 1)[0]
    if (!/^[A-Za-z]$/.test(state)) throw new Error(`unreadable execution state for ${pid}`)
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function notRunning(pid: number, readStat: StatReader = readFileSync): boolean {
  const deadline = Date.now() + 2_000
  for (;;) {
    const state = executionState(pid, readStat)
    if (state === null || state === 'Z' || state === 'X') return true
    if (!RUNNING[state]) throw new Error(`unknown execution state ${state}`)
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
      expect(notRunning(childPid)).toBe(true)

      expect(ran).toMatchObject({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' })
      expect(elapsed).toBeLessThan(4_000)
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
      expect(notRunning(childPid)).toBe(true)

      expect(ran).toEqual({ code: 0, signal: null, stdout: 'complete\n', stderr: '' })
    } finally {
      killIfRunning(childPid)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats terminal X state as not running', () => {
    expect(notRunning(42, () => '42 (sleep) X 0 0 0')).toBe(true)
  })

  it('propagates an unexpected stat reader error unchanged', () => {
    const sentinel = Object.assign(new Error('permission denied reading process state'), { code: 'EACCES' })
    let received: unknown

    try {
      notRunning(42, () => {
        throw sentinel
      })
    } catch (error) {
      received = error
    }

    expect(received).toBe(sentinel)
  })

  it('accepts a terminated zombie and rejects a running descendant', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'issue-triage-runner-state-'))
    let childPid: number | undefined
    let closed: Promise<void> | undefined

    try {
      try {
        const spawned = spawn('sleep', ['20'], { cwd: root, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } })

        let startError: Error | undefined
        const started = new Promise<void>((resolve) => {
          spawned.once('spawn', () => resolve())
          spawned.once('error', (error) => {
            startError = error
            resolve()
          })
        })
        closed = new Promise<void>((resolve) => {
          spawned.once('close', () => resolve())
        })

        await started
        if (startError) throw startError
        const pid = spawned.pid
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
          throw new Error('descendant did not receive a valid PID')
        }
        childPid = pid

        expect(notRunning(pid)).toBe(false)
        process.kill(pid, 'SIGKILL')

        const deadline = Date.now() + 2_000
        for (;;) {
          const state = executionState(pid)
          if (state === 'Z') break
          if (state === null) throw new Error('descendant was reaped before its zombie state was observed')
          if (Date.now() >= deadline) throw new Error('descendant did not enter zombie state before the deadline')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        }

        const readObservedZombie: StatReader = (file, encoding) => {
          try {
            const stat = readFileSync(file, encoding)
            const state = stat.slice(stat.lastIndexOf(') ') + 2).split(' ', 1)[0]
            if (state !== 'Z') throw new Error(`expected observed zombie state, received ${state}`)
            return stat
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new Error('descendant was reaped before guarded zombie acceptance', { cause: error })
            }
            throw error
          }
        }
        expect(notRunning(pid, readObservedZombie)).toBe(true)
      } finally {
        try {
          killIfRunning(childPid)
        } finally {
          if (closed) await closed
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
