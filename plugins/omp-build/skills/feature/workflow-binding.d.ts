import type { Gh } from './proof-base.ts'

export type LandingMandateRefusal =
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
  | 'proof-pin-drift'
  | 'unbound'
  | 'conflict'
  | 'incomplete'
  | 'unknown-binding'
  | 'incompatible'
  | 'unsafe'
  | 'materially-changed'
export type BindingClaim = { issue?: number; branch?: string; base?: string }
export type SelectedBinding = { ok: true; recordId: string } | { ok: false; reason: string }

export declare function mandateReason(reason: string | null | undefined): LandingMandateRefusal
export declare function bindingRefusalReason(reason: string | null | undefined): LandingMandateRefusal
export declare function confirmSelectedBinding(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  claim?: BindingClaim,
): Promise<SelectedBinding>
