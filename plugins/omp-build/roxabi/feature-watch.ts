import type { Gh } from '../adapters/github/types.ts'
import { featureLandOutcome } from '../skills/feature/workflow-outcome.js'
import { applyCiWatchExit } from '../skills/feature/workflow-watch.js'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { continueFeature } from './workflow.ts'
import type { GitRunner } from './workflow-checkout.ts'

function reenterFeature(input: {
  cwd: string
  reference: string
  gh?: Gh
  git?: GitRunner
}): Promise<ContinueFeatureResult> {
  return continueFeature({
    cwd: input.cwd,
    reference: input.reference,
    control: 'continue',
    principal: false,
    gh: input.gh,
    git: input.git,
  })
}

export async function consumeWatchExit(input: {
  cwd: string
  pr: number
  code: number
  reference: string
  gh?: Gh
  git?: GitRunner
}): Promise<ContinueFeatureResult> {
  if (input.reference.trim().length === 0) return { kind: 'blocked', reason: 'watch-reference-missing' }
  const landed = await applyCiWatchExit(input.cwd, input.pr, input.code, { gh: input.gh, git: input.git })
  const outcome = featureLandOutcome(landed)
  if (outcome.action === 'start-watch' || outcome.action === 'reattach-watch') {
    const watch = 'watch' in landed && typeof landed.watch === 'string' ? landed.watch : null
    return watch === null ? { kind: 'blocked', reason: 'watch-missing' } : { kind: 'watch', command: watch }
  }
  if (outcome.action === 'stop' || outcome.action === 'blocked') return { kind: 'terminal', reason: outcome.reason }
  return reenterFeature({ cwd: input.cwd, reference: input.reference, gh: input.gh, git: input.git })
}
