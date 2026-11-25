import type { Diagnostic } from './record-values.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { MandatePayload } from './workflow-mandate-schema.ts'

export function effectiveMandateRole(
  storedRole: MandatePayload['role'],
  accepted: AcceptedOwnSpec,
): MandatePayload['role'] {
  return storedRole === 'fix-only' ? 'fix-only' : accepted.children.length > 0 ? 'epic' : 'feature'
}

export type MandateRefusal =
  | 'missing'
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
  | { status: 'refused'; reason: MandateRefusal; evidence: Diagnostic[] }
