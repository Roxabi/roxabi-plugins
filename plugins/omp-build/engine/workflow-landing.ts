import type { Diagnostic, Scope } from './record-values.ts'
import type { MandateRecord } from './workflow-control.ts'

export type LandingRefusal =
  | 'missing'
  | 'fix-only'
  | 'paused'
  | 'abandoned'
  | 'stale'
  | 'unsupported'
  | 'unconfirmed'
  | 'foreign'
  | 'ambiguous'
  | 'revoked'
  | 'material-spec'
  | 'config-drift'
  | 'unbound'
  | 'conflict'
  | 'incomplete'
  | 'unknown-binding'
  | 'incompatible'
  | 'unsafe'
  | 'materially-changed'
  | 'missing-history'

export type LandingMandateDecision =
  | { ok: true; recordId: string; scope: Scope; mandate: MandateRecord }
  | { ok: false; reason: LandingRefusal; evidence: Diagnostic[] }
