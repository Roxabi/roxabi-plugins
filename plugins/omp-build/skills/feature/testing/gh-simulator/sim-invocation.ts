import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'

export type SimCommandInput = {
  cwd: string
  readStdin: () => string
}

export type SimInvocation = {
  cwd: string
  readStdin: () => string
  stdout: string
  stderr: string
  writeStdout(text: string): void
  writeStderr(text: string): void
}

const invocations = new AsyncLocalStorage<SimInvocation>()

export function currentInvocation(): SimInvocation {
  const current = invocations.getStore()
  if (!current) throw new Error('gh: simulator command is not executing')
  return current
}

export function runInvocation<T>(input: SimCommandInput, fn: (invocation: SimInvocation) => T): T {
  const invocation: SimInvocation = {
    cwd: input.cwd,
    readStdin: input.readStdin,
    stdout: '',
    stderr: '',
    writeStdout(text: string) {
      this.stdout += text
    },
    writeStderr(text: string) {
      this.stderr += text
    },
  }
  return invocations.run(invocation, () => fn(invocation))
}

export function writeStdout(text: string): void {
  currentInvocation().writeStdout(text)
}

/** One subprocess. Stderr is kept on exit 0 and on failure. No second launch. */
export function execInherited(file: string, args: string[], options: { input?: string } = {}): string {
  const result = spawnSync(file, args, {
    input: options.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.stderr) currentInvocation().writeStderr(result.stderr)
  if (result.error) throw result.error
  if (result.status === 0 && !result.signal) return result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const rendered = [file, ...args].join(' ')
  const message = stderr.length > 0 ? `Command failed: ${rendered}\n${stderr}` : `Command failed: ${rendered}`
  throw new Error(message)
}
