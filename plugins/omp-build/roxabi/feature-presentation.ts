import { criterionIdSchema } from '../dist/contracts.js'
import type { Diagnostic } from '../engine/record-values.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'

/**
 * Operator text for a workflow result that ends the command, or `null` when the result hands on
 * work or a valid move. Text only: owner bookkeeping, dispatch and the same-checkout check stay
 * with the caller, so the principal checkout names a stop without acting on it.
 */
export function featureStopMessage(result: ContinueFeatureResult): string | null {
  switch (result.kind) {
    case 'session-cwd':
      return isMoveInstruction(result) ? null : 'feature-stopped: move-instruction-invalid'
    case 'blocked':
      return isAssistedFraming(result.reason)
        ? featureAssistedFramingMessage()
        : featureStoppedWithDiagnostics(result.reason, result.diagnostics)
    case 'operator-decision':
      return isAssistedFraming(result.reason)
        ? featureAssistedFramingMessage()
        : `feature-stopped: operator-decision:${result.reason}`
    case 'terminal':
      return featureStoppedWithDiagnostics(result.reason, result.diagnostics)
    case 'paused':
      return featurePauseMessage(result)
    case 'abandoned':
      return result.confirmed === true ? 'feature-abandoned' : 'feature-stopped: abandon-unconfirmed'
    default:
      return null
  }
}

export function featureErrorMessage(error: unknown): string {
  return `feature-stopped: ${error instanceof Error ? error.message : String(error)}`
}

/** From the principal checkout nothing is dispatched; the one refusal line still names why. */
export function principalRefusalMessage(cwd: string, stop: string): string {
  const reason = stop.replace(/^feature-stopped: /, '')
  return `session-cwd ${cwd}\nfeature-stopped: principal-dispatch-refused: ${reason}`
}

/** Framing guidance names no checkout: a worktree would receive the same text, so it is never a refusal. */
export function isFramingResult(result: ContinueFeatureResult): boolean {
  return (result.kind === 'blocked' || result.kind === 'operator-decision') && isAssistedFraming(result.reason)
}

export function featurePauseMessage(result: Extract<ContinueFeatureResult, { kind: 'paused' }>): string {
  if (result.confirmed === true) return `pause-confirmed: ${result.reason}`
  const safe = result.reason.toLowerCase().includes('disarmed') ? 'pause-unconfirmed' : result.reason
  return `pause-unconfirmed: ${safe}`
}

function isMoveInstruction(result: Extract<ContinueFeatureResult, { kind: 'session-cwd' }>): boolean {
  return result.path.startsWith('/') && result.instruction === `/move ${result.path}`
}

/**
 * Pre-selection assisted framing only (`needs-framing`).
 * Never used for `needs-scope`: that can follow an already-published mandate/checkout,
 * and this copy must not deny durable history or imply the same unchanged ref will pass.
 */
function featureAssistedFramingMessage(): string {
  return 'Frame with skill://grilling until shared understanding, then publish or amend through skill://issue-triage. Do not start a checkout, mandate, or native batch until the operator runs /feature #N on an actionable issue.'
}

export function isAssistedFraming(reason: string): boolean {
  return reason === 'needs-framing'
}

export function featureSessionCwdMessage(cwd: string, instruction: string): string {
  return `session-cwd ${cwd}\n${instruction}`
}

function featureStoppedWithDiagnostics(reason: string, diagnostics: readonly Diagnostic[] | undefined): string {
  const head = `feature-stopped: ${reason}`
  if (diagnostics === undefined || diagnostics.length === 0) return head
  const lines = [head]
  for (const item of diagnostics) {
    const message = item.message.trim()
    if (message.length > 0) lines.push(message)
    const path = item.path?.trim()
    if (path !== undefined && path.length > 0) lines.push(path)
    lines.push(...detailPathMessages(item.detail))
  }
  return lines.join('\n')
}

/** Operator lines from already-built Diagnostic fields — no payload dump, reason enum unchanged. */
function detailPathMessages(detail: Diagnostic['detail']): string[] {
  if (!Array.isArray(detail)) return criterionDetailMessages(detail)
  return detail.flatMap((entry) => {
    const line = detailPathMessage(entry)
    return line === null ? [] : [line]
  })
}

function criterionDetailMessages(detail: Diagnostic['detail']): string[] {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return []
  const lines: string[] = []
  for (const [key, label] of [
    ['unknownCriterionIds', 'Unknown criteria'],
    ['orphanCriterionIds', 'Uncovered criteria'],
  ] as const) {
    const ids = key in detail ? detail[key] : undefined
    if (!Array.isArray(ids)) continue
    const valid = ids.filter((id): id is string => criterionIdSchema.safeParse(id).success)
    if (valid.length > 0) lines.push(`${label}: ${valid.join(', ')}`)
  }
  return lines
}

function detailPathMessage(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const path = 'path' in entry && typeof entry.path === 'string' ? entry.path.trim() : ''
  const message = 'message' in entry && typeof entry.message === 'string' ? entry.message.trim() : ''
  if (path.length > 0 && message.length > 0) return `${path} ${message}`
  if (message.length > 0) return message
  return path.length > 0 ? path : null
}
