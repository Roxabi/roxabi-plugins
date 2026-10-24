import type { Diagnostic } from '../engine/record-values.ts'

/**
 * Pre-selection assisted framing only (`needs-framing`).
 * Never used for `needs-scope`: that can follow an already-published mandate/checkout,
 * and this copy must not deny durable history or imply the same unchanged ref will pass.
 */
export function featureAssistedFramingMessage(): string {
  return 'Frame with skill://grilling until shared understanding, then publish or amend through skill://issue-triage. Do not start a checkout, mandate, or native batch until the operator runs /feature #N on an actionable issue.'
}

export function isAssistedFraming(reason: string): boolean {
  return reason === 'needs-framing'
}

export function featureSessionCwdMessage(cwd: string, instruction: string): string {
  return `session-cwd ${cwd}\n${instruction}`
}

export function pauseUnconfirmed(reason: string): string {
  const safe = reason.toLowerCase().includes('disarmed') ? 'pause-unconfirmed' : reason
  return `pause-unconfirmed: ${safe}`
}

export function featureStoppedWithDiagnostics(reason: string, diagnostics: readonly Diagnostic[] | undefined): string {
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
  if (!Array.isArray(detail)) return []
  return detail.flatMap((entry) => {
    const line = detailPathMessage(entry)
    return line === null ? [] : [line]
  })
}

function detailPathMessage(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const path = 'path' in entry && typeof entry.path === 'string' ? entry.path.trim() : ''
  const message = 'message' in entry && typeof entry.message === 'string' ? entry.message.trim() : ''
  if (path.length > 0 && message.length > 0) return `${path} ${message}`
  if (message.length > 0) return message
  return path.length > 0 ? path : null
}
