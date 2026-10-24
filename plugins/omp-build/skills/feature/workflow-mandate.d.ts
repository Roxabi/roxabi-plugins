import type { Json } from '../../contracts.ts'
import type { Admission } from './proof-admission.ts'
import type { Gh, Git, ProofConfigPin, Refusal } from './proof-base.ts'

/** Exact JS-leaf return; callers that expose a landing mandate publicly use the canonical contracts.ts decision. */
export type LandingMandateRead =
  | { admitted: true; recordId: string; proofPins: ProofConfigPin[] }
  | { admitted: false; reason: string; evidence?: Json }
export type NativeLandingCoordinates = { head: string; base: string; baseTip: string }
export type ReviewBinding = { head: string | null; at: string | null; input: string | null }

export declare function evidenceText(evidence: Json | null | undefined): string
export declare function liveProofPins(gitCwd: string, gitFn: Git, baseTip: string): Promise<ProofConfigPin[]>
/** Shared landing-mandate check. A refusal never arms. */
export declare function currentLandingMandate(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  native: NativeLandingCoordinates,
  gitFn?: Git,
  gitCwd?: string,
): Promise<LandingMandateRead>
export declare function admitCurrentReviewBinding(
  cwd: string,
  pr: number | string,
  records: ReviewBinding,
  ghFn: Gh,
  gitFn: Git | undefined,
  proofPins?: readonly ProofConfigPin[],
): Promise<Admission | Refusal>
export declare function hasFreshReviewInput(
  cwd: string,
  pr: number | string,
  records: ReviewBinding,
  options?: { gh?: Gh; git?: Git; proofPins?: readonly ProofConfigPin[] },
): Promise<boolean>
