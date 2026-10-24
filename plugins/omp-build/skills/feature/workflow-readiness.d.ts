import type { Gh, Git, Refusal } from './proof-base.ts'

export type LandingMode = 'native' | 'merge-on-green'
export type LandingConfig = { mode: LandingMode; required_checks: string[] }
export type LandingParseOptions = { mergeOnGreenWorkflow?: boolean }
export type LandingBase = { name: string; tip: string }
export type LandingBaseRead = LandingBase | { name: string; refusal: Refusal }

export declare function parseLanding(stackText: string, options?: LandingParseOptions): LandingConfig
export declare function readLandingAt(cwd: string, at: string): LandingConfig
export declare function readLanding(cwd: string, options: { base: string }): LandingConfig
export declare function fetchBase(cwd: string, name: string, gitFn: Git, ghFn: Gh): Promise<LandingBaseRead>
export declare function resolveLandingBase(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  gitFn: Git,
): Promise<LandingBaseRead>
