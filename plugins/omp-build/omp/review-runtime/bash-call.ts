import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { BashToolDetails, BashToolInput } from '@oh-my-pi/pi-coding-agent'
import { nativeSnapshot, object } from './capture.ts'
import type { Json, NativeProofBashCall } from './contracts'

export function bashInput(value: unknown): value is BashToolInput {
  return object(value) && typeof value.command === 'string'
}

function bashDetails(value: unknown): value is BashToolDetails {
  return object(value) && (value.exitCode === undefined || typeof value.exitCode === 'number')
}

function bashExitCode(value: unknown, isError: unknown): number | null {
  if (!object(value) || !bashDetails(value.details)) return null
  const details = value.details
  if (typeof details.exitCode === 'number') return details.exitCode
  if (isError !== false || details.async !== undefined || details.service !== undefined) return null
  if (details.timedOut === true || details.terminalId !== undefined) return null
  return 0
}

export function rememberBashCall(
  completed: Map<string, NativeProofBashCall>,
  ambiguous: Set<string>,
  toolCallId: string,
  pending: { input: Json; effectiveCwd: string | null },
  event: { result: unknown; isError?: unknown },
  conflicts?: NativeProofBashCall[],
): void {
  const call: NativeProofBashCall = {
    toolCallId,
    input: pending.input,
    effectiveCwd: pending.effectiveCwd,
    result: nativeSnapshot(event.result),
    exitCode: bashExitCode(event.result, event.isError),
  }
  const existing = completed.get(toolCallId)
  if (existing === undefined && !ambiguous.has(toolCallId)) {
    completed.set(toolCallId, call)
    return
  }
  if (conflicts !== undefined) {
    if (existing !== undefined) conflicts.push(existing)
    conflicts.push(call)
  }
  completed.delete(toolCallId)
  ambiguous.add(toolCallId)
}

/** Mirrors the installed public Bash resolver's supported host-path cases without importing it at runtime. */
export function effectiveBashCwd(value: unknown, sessionCwd: string | null): string | null {
  if (!bashInput(value) || typeof sessionCwd !== 'string') return null
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return null

  const requested = value.cwd ?? sessionCwd
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(requested)) return null

  const home = homedir()
  const expanded =
    requested === '~'
      ? home
      : requested.startsWith('~/') || requested.startsWith('~\\')
        ? home + requested.slice(1)
        : requested.startsWith('~')
          ? join(home, requested.slice(1))
          : requested
  if (/^\/+$/.test(expanded)) return sessionCwd
  return isAbsolute(expanded) ? expanded : resolve(sessionCwd, expanded)
}
