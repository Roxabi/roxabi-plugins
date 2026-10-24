import type { Diagnostic } from './record-values.ts'
import type { MandateRecord, PauseBinding } from './workflow-control.ts'

export type MandateRefusal =
  | 'missing'
  | 'paused'
  | 'abandoned'
  | 'revoked'
  | 'unsupported'
  | 'config-invalid'
  | 'ambiguous'
  | 'incomplete'
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
