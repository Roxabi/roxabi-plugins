import type { GitHubOptions, Json, ScopedRecordRef } from '../dist/contracts.js'
import type { NativePort, ReviewAuthority } from './fix-contract.ts'
import type { DebtEvidence } from './fix-domain'
import type { Gh } from './fix-entry-target-core.ts'
import type { UwReadPort } from './uw-contract.ts'

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
  uw: UwReadPort
  gh?: Gh
}
