import type { Json } from '../../contracts.ts'
import type { Gh, Git } from './proof-base.ts'

/** Exact JS-leaf return; callers that expose a landing mandate publicly use the canonical contracts.ts decision. */
export type LandingMandateRead =
  | { admitted: true; recordId: string }
  | { admitted: false; reason: string; evidence?: Json }
export type NativeLandingCoordinates = { head: string; base: string; baseTip: string; automationLogin?: string }

export declare function evidenceText(evidence: Json | null | undefined): string
/** Shared landing-mandate check. A refusal never arms. */
export declare function currentLandingMandate(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  native: NativeLandingCoordinates,
  gitFn?: Git,
  gitCwd?: string,
): Promise<LandingMandateRead>
