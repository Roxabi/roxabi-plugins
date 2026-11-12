import type { Diagnostic } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FixActionResult } from './fix-contract.ts'
import type { UwRead } from './uw-contract.ts'

const SHOWN_REASONS = 3
const REASON_LENGTH = 400

function located(location: UwDiagnostic['location']): string {
  if (location.kind === 'repository') return location.repository
  return location.kind === 'record' ? location.ref.scope.target : location.uw.target
}

export function reasonLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, REASON_LENGTH)
}

/** Why this observation is incomplete, in operator words; empty when it is complete. */
export function observationReasons(observation: UwRead['observation']): string[] {
  if (observation.status !== 'incomplete') return []
  const lines = observation.diagnostics
    .slice(0, SHOWN_REASONS)
    .map((entry) => reasonLine(`${entry.code} ${located(entry.location)}: ${entry.message}`))
  const hidden = observation.diagnostics.length - SHOWN_REASONS
  return hidden > 0 ? [...lines, `${hidden} more incomplete observation diagnostics`] : lines
}

/**
 * Operator stop for a causal context that could not be composed: the stable codes first, then
 * the read's own reasons, so a failed GitHub read is named instead of flattened to a code.
 */
export function causalRefusal(
  causal: Extract<FixActionResult<unknown>, { ok: false }>,
  fallback = 'causal-history-unavailable',
): { reason: string; diagnostics: Diagnostic[] } {
  const lines = [...causal.diagnostics.slice(1), ...(causal.reasons ?? [])]
  return {
    reason: causal.diagnostics[0] ?? fallback,
    diagnostics: lines.map((message) => ({ code: message, message })),
  }
}
