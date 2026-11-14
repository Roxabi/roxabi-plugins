import type { Gh } from '../adapters/github/types.ts'
import { applyCiWatchExit } from '../skills/feature/workflow-watch.js'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { defaultGh, isRecord } from './feature-engine.ts'
import { landingContinuation } from './feature-landing-continuation.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'
import { continueFeatureAfterLanding } from './workflow.ts'
import type { GitRunner } from './workflow-checkout.ts'

type WatchExitInput = {
  cwd: string
  pr: number
  code: number
  reference: string
  gh?: Gh
  git?: GitRunner
  uw?: Parameters<typeof continueFeatureAfterLanding>[0]['uw']
}

function reenterFeature(input: WatchExitInput, cause: string): Promise<ContinueFeatureResult> {
  return continueFeatureAfterLanding(
    {
      cwd: input.cwd,
      reference: input.reference,
      control: 'continue',
      principal: false,
      gh: input.gh,
      git: input.git,
      uw: input.uw,
      read: createInstalledUwReadPort({ cwd: input.cwd, gh: input.gh }),
    },
    cause,
  )
}

/** A watcher stop ends the feature only while GitHub still shows the pull request CLOSED. */
async function pullRequestClosed(input: WatchExitInput): Promise<boolean> {
  try {
    const gh = input.gh ?? defaultGh()
    const parsed: unknown = JSON.parse(await gh(input.cwd, ['pr', 'view', String(input.pr), '--json', 'state']))
    return isRecord(parsed) && parsed.state === 'CLOSED'
  } catch {
    return false
  }
}

export async function consumeWatchExit(input: WatchExitInput): Promise<ContinueFeatureResult> {
  if (input.reference.trim().length === 0) return { kind: 'blocked', reason: 'watch-reference-missing' }
  const landed = await applyCiWatchExit(input.cwd, input.pr, input.code, {
    gh: input.gh,
    git: input.git,
    stopPublication: 'engine',
  })
  if (landed.status === 'stopped' && !(await pullRequestClosed(input)))
    return reenterFeature(input, 'watch-stop-unconfirmed')
  const next = landingContinuation(landed)
  return next.kind === 'result' ? next.result : reenterFeature(input, next.cause)
}
