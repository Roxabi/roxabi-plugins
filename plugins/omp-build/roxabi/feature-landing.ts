import type { Gh } from '../adapters/github/types.ts'
import { landPr } from '../skills/feature/workflow-landing.js'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { Contracts, History, Scope } from './feature-engine.ts'
import type { GitRunner } from './workflow-pins.ts'

type Delivery = {
  number: number
  scope: Scope
  head: string
  branch: string
  base: string
  history: History
  issueScope: Scope
}

/** Actual shape read by featureLandOutcome; no coordinator protocol is added. */
export type NativeLanding = { status: string; watch?: string }

/** Performs landing admission and returns the untouched native landing outcome. */
export async function landFeature(input: {
  loaded: Contracts
  history: History
  parents: readonly History[]
  delivery: Delivery | null
  gh: Gh
  git: GitRunner
  cwd: string
}): Promise<ContinueFeatureResult | NativeLanding> {
  if (input.delivery === null) return { kind: 'blocked', reason: 'land-requires-pull-request' }
  const selected = input.loaded.selectApplicableMandate(input.history, input.parents)
  if (selected.status !== 'applicable' || selected.mandate === null) {
    return {
      kind: 'blocked',
      reason: selected.status === 'refused' ? `mandate-${selected.reason}` : 'mandate-missing',
    }
  }
  return landPr(input.cwd, input.delivery.number, { gh: input.gh, git: input.git })
}
