import { criterionIdSchema } from '../dist/contracts.js'
import type { Diagnostic } from '../engine/record-values.ts'
import { safeOperatorError } from '../omp/omp-operator-confirmation-field.ts'
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
      return result.next === undefined
        ? featureStoppedWithDiagnostics(result.reason, result.diagnostics)
        : withDiagnostics(`feature-held: ${result.reason}\nnext: ${result.next}`, result.diagnostics)
    case 'operator-decision':
      return `feature-stopped: operator-decision:${result.reason}`
    case 'terminal':
      return result.reason === 'done'
        ? withDiagnostics('feature-done: done', result.diagnostics)
        : featureStoppedWithDiagnostics(result.reason, result.diagnostics)
    case 'paused':
      return featurePauseMessage(result)
    case 'abandoned':
      if (result.confirmed) return 'feature-abandoned'
      if (result.failure?.phase === 'uw') {
        const diagnostics = result.failure.diagnostics.map(
          (item) => `${safeOperatorError(item.code)}: ${safeOperatorError(item.message)}`,
        )
        return [`feature-stopped: abandon-unconfirmed: uw-${result.failure.status}`, ...diagnostics].join('\n')
      }
      if (result.failure?.phase === 'disarm')
        return [
          'feature-stopped: abandon-unconfirmed: uw-abandoned; disarm-unconfirmed',
          ...disarmMessages(result.failure.evidence),
        ].join('\n')
      return 'feature-stopped: abandon-unconfirmed'
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

export function featurePauseMessage(result: Extract<ContinueFeatureResult, { kind: 'paused' }>): string {
  if (result.confirmed === true) return `pause-confirmed: ${result.reason}`
  const safe = result.reason.toLowerCase().includes('disarmed') ? 'pause-unconfirmed' : result.reason
  return `pause-unconfirmed: ${safe}`
}

/** Project an already-decided workflow result without changing its owner. */
export function featureResultStatus(reference: string, result: ContinueFeatureResult): string | undefined {
  if (result.kind === 'blocked') {
    return result.next === undefined
      ? `UW ${reference} · ${result.reason} · next: inspect and resolve`
      : `UW ${reference} · held: ${result.reason} · next: ${result.next} · session end pauses`
  }
  if (result.kind === 'paused') {
    return result.confirmed
      ? `UW ${reference} · paused (${result.reason}) · next: /feature resume ${reference}`
      : `UW ${reference} · pause unconfirmed (${result.reason}) · next: inspect`
  }
  return undefined
}

function isMoveInstruction(result: Extract<ContinueFeatureResult, { kind: 'session-cwd' }>): boolean {
  return result.path.startsWith('/') && result.instruction === `/move ${result.path}`
}

export function featureSessionCwdMessage(cwd: string, instruction: string): string {
  return `session-cwd ${cwd}\n${instruction}`
}

/** Project only documented disarm fields; the retained evidence itself is not an operator payload. */
function disarmMessages(evidence: unknown): string[] {
  if (!isObject(evidence)) return []
  const lines: string[] = []
  if (evidence.note === 'pull-request-list-incomplete') lines.push(evidence.note)
  if (Array.isArray(evidence.disarmed)) {
    for (const item of evidence.disarmed) {
      reportDisarmEvidence(lines, item, 'disarm')
      if (isObject(item) && isObject(item.result)) {
        const pr = pullRequestLabel(item)
        reportDisarmEvidence(lines, item.result, `disarm${pr} result`)
      }
    }
  }
  if (isObject(evidence.discovery)) {
    for (const part of ['own', 'children'] as const) {
      reportDiscovery(lines, evidence.discovery[part], part)
    }
  }
  return lines
}

function reportDiscovery(lines: string[], discovery: unknown, part: string): void {
  if (!isObject(discovery)) return
  if (discovery.incomplete === true) lines.push(`${part} discovery incomplete`)
  if (!Array.isArray(discovery.evidence)) {
    reportDisarmEvidence(lines, discovery.evidence, `${part} discovery`)
    return
  }
  for (const item of discovery.evidence) {
    if (!isObject(item)) continue
    const source = item.source === 'linked' || item.source === 'branch' ? ` ${item.source}` : ''
    reportDisarmEvidence(lines, item, `${part} discovery${source}`)
    if (Array.isArray(item.ownership)) {
      for (const owner of item.ownership) reportDisarmEvidence(lines, owner, `${part} ownership`)
    }
  }
}

function pullRequestLabel(value: Record<string, unknown>): string {
  return typeof value.pr === 'number' && Number.isSafeInteger(value.pr) && value.pr > 0 ? ` PR #${value.pr}` : ''
}

function reportDisarmEvidence(lines: string[], value: unknown, label: string): void {
  if (!isObject(value)) return
  const pr = pullRequestLabel(value)
  const status = codedDisarmField(value.status)
  const reason = codedDisarmField(value.reason)
  const code = codedDisarmField(value.code)
  const message = typeof value.error === 'string' ? value.error : value.message
  const error = typeof message === 'string' ? `: ${safeOperatorError(message)}` : ''
  const state = ['disarmed', 'unarmed', 'closed', 'merged'].filter((name) => value[name] === true).join(' ')
  const description = [status, reason, code, state].filter(Boolean).join(' ')
  if (description || error || pr) lines.push(`${label}${pr}${description ? ` ${description}` : ''}${error}`)
}

function codedDisarmField(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z-]*$/.test(value) ? value : ''
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function featureStoppedWithDiagnostics(reason: string, diagnostics: readonly Diagnostic[] | undefined): string {
  return withDiagnostics(`feature-stopped: ${reason}`, diagnostics)
}

function withDiagnostics(head: string, diagnostics: readonly Diagnostic[] | undefined): string {
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
