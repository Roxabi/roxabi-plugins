import type { Diagnostic } from './record-values.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { MandateRecord, PauseBinding } from './workflow-control.ts'
import type { MandatePayload } from './workflow-mandate-schema.ts'

export function effectiveMandateRole(
  storedRole: MandatePayload['role'],
  accepted: AcceptedOwnSpec,
): MandatePayload['role'] {
  return storedRole === 'fix-only' ? 'fix-only' : accepted.children.length > 0 ? 'epic' : 'feature'
}

export type MandateRefusal =
  | 'missing'
  | 'paused'
  | 'abandoned'
  | 'revoked'
  | 'unsupported'
  | 'config-invalid'
  | 'ambiguous'
  | 'incomplete'
  | 'incompatible-format'
  | 'unconfirmed'
  | 'unknown-binding'
  | 'incompatible'
  | 'unsafe'
  | 'materially-changed'
  | 'missing-history'

export type MandateSelection =
  | { status: 'applicable'; mandate: MandateRecord }
  | { status: 'refused'; reason: 'paused'; evidence: Diagnostic[]; pause: PauseBinding }
  | { status: 'refused'; reason: Exclude<MandateRefusal, 'paused'>; evidence: Diagnostic[] }
