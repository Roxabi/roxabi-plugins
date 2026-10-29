import type { GitHubOptions, Json, ScopedRecordRef } from '../dist/contracts.js'
import type { NativePort, ReviewAuthority } from './fix-contract.ts'
import type { DebtEvidence } from './fix-domain'
import type { Gh } from './fix-entry-target-core.ts'
import type { TrustedHostPluginPin } from './uw-action-contract.ts'
import type { UwOperations, UwReadPort } from './uw-contract.ts'

export type DefaultFixEntry = {
  cwd: string
  args?: string
  reference?: string
  scope?: string
  rawOperatorRequest?: Json
  reviewId?: string
  requiredFeatureMandate?: ScopedRecordRef & { kind: 'mandate' }
  contextWindow?: number
  debtEvidence?: DebtEvidence
  native: NativePort
  workflow: ReviewAuthority
  github?: GitHubOptions
  /** Shared S5 backend reader; never synthesized from issue prose. */
  operations: UwOperations
  uw: UwReadPort
  /** Trusted host composition only. Omit for the ordinary published pin. */
  pluginPin?: TrustedHostPluginPin
  gh?: Gh
}
