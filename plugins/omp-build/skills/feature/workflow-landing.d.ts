import type { Gh, Git } from './proof-base.ts'
import type { ProofSummary } from './proof-context.ts'
import type { LandingConfig, LandingMode } from './workflow-readiness.js'

export type LandingResult = {
  status: string
  mode?: LandingMode
  watch?: string
  reason?: string
  producer?: 'candidate' | 'semctx' | 'assertledger'
  disarmed?: true
  armed?: boolean
  proof?: ProofSummary
  error?: string
}
export type LandPrOptions = {
  gh?: Gh
  git?: Git
  requiredContexts?: readonly string[]
  landing?: LandingConfig
  sleep?: (ms: number) => Promise<void>
}
export declare function landPr(
  cwd: string,
  pr: number | string | null | undefined,
  options?: LandPrOptions,
): Promise<LandingResult>
