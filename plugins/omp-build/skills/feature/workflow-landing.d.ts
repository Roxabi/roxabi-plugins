import type { Gh, Git } from './review-base.ts'
import type { LandingConfig, LandingMode } from './workflow-readiness.js'

export type LandingResult = {
  status: string
  mode?: LandingMode
  watch?: string
  reason?: string
  disarmed?: true
  armed?: boolean
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
