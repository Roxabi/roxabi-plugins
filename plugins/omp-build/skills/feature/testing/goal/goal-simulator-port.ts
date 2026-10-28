import { executeSimCommand, type SimCommandResult } from '../gh-simulator/sim-execution.ts'

function driverFailure(args: string[], result: SimCommandResult): Error {
  const rendered = args.length === 0 ? 'gh' : `gh ${args.join(' ')}`
  const message =
    result.stderr.length > 0 ? `Command failed: ${rendered}\n${result.stderr}` : `Command failed: ${rendered}`
  return Object.assign(new Error(message), {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  })
}

/** Synchronous driver port. Runtime trims the success string. `status` is the process exit, matching execFileSync. */
export function driverGh(repo: string, args: string[], input?: string): string {
  let pending = input
  const result = executeSimCommand(args, {
    cwd: repo,
    readStdin: () => {
      const value = pending ?? ''
      pending = ''
      return value
    },
  })
  if (result.status !== 0) throw driverFailure(args, result)
  return result.stdout
}

/**
 * Workflow port. Matches workflow-runtime.js:46-56: exitCode only.
 * Do not set `status` — workflow-pr.js treats `error.status` as an HTTP code,
 * so exit 1 would hide HTTP 422 and skip duplicate-PR recovery.
 */
export async function workflowGh(cwd: string, args: string[]): Promise<string> {
  const result = executeSimCommand(args, { cwd, readStdin: () => '' })
  if (result.status !== 0) {
    const error = new Error(`gh ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
    throw Object.assign(error, { exitCode: result.status, stderr: result.stderr, stdout: result.stdout })
  }
  return result.stdout.trim()
}
