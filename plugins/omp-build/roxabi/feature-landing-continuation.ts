import type { Diagnostic } from '../engine/record-values.ts'
import { type FeatureLandOutcome, featureLandOutcome, type LandingStatus } from '../skills/feature/workflow-outcome.js'
import type { ContinueFeatureResult, FeatureHoldNext } from './feature-contract.ts'

/**
 * What a native landing or CI watch exit leaves the feature. A merge, a red CI or a moved or
 * unapproved head goes back to the engine (`reenter`, named by its cause); a spent review bound and a
 * closed pull request end the feature; every other stop is a recoverable hold naming its next step.
 */
export type LandingContinuation = { kind: 'result'; result: ContinueFeatureResult } | { kind: 'reenter'; cause: string }

const FINAL_STOPS: ReadonlySet<string> = new Set(['review-bound', 'closed', 'stopped'])

export function landingContinuation(landed: LandingStatus): LandingContinuation {
  const outcome = featureLandOutcome(landed)
  const diagnostics = landingDiagnostics(landed)
  switch (outcome.action) {
    case 'start-watch':
    case 'reattach-watch':
      return typeof landed.watch === 'string' && landed.watch !== ''
        ? { kind: 'result', result: { kind: 'watch', command: landed.watch } }
        : held(statusOf(landed), 'feature-reentry', diagnostics)
    case 'report-merged':
      return { kind: 'reenter', cause: 'merged' }
    case 'next-review-step':
      return { kind: 'reenter', cause: outcome.ciFailed ? 'ci-failed' : (outcome.reason ?? 'next-review-step') }
    case 'review-if-unspent':
      return { kind: 'reenter', cause: outcome.reason }
    case 'stop':
      return stopContinuation(outcome, diagnostics)
    case 'blocked':
      return held(
        outcome.reason === 'unknown-land-status' ? `unknown-land-status:${outcome.status}` : outcome.reason,
        'diagnose-landing',
        diagnostics,
      )
  }
}

function stopContinuation(
  outcome: Extract<FeatureLandOutcome, { action: 'stop' }>,
  diagnostics: readonly Diagnostic[],
): LandingContinuation {
  if (outcome.reenter !== 'none') return held(outcome.reason, outcome.reenter, diagnostics)
  if (FINAL_STOPS.has(outcome.reason)) return { kind: 'result', result: { kind: 'terminal', reason: outcome.reason } }
  if (outcome.reason === 'mandate-refused') {
    return held(
      `mandate-refused:${outcome.mandateReason ?? 'unknown-binding'}`,
      'resolve-mandate-then-land',
      diagnostics,
    )
  }
  return held(outcome.reason, 'feature-reentry', diagnostics)
}

function held(reason: string, next: FeatureHoldNext, diagnostics: readonly Diagnostic[]): LandingContinuation {
  return {
    kind: 'result',
    result: { kind: 'blocked', reason, next, ...(diagnostics.length === 0 ? {} : { diagnostics }) },
  }
}

function statusOf(landed: LandingStatus): string {
  return typeof landed.status === 'string' && landed.status !== '' ? landed.status : 'unknown-land-status'
}

function landingDiagnostics(landed: LandingStatus): readonly Diagnostic[] {
  const message = typeof landed.error === 'string' ? landed.error.trim() : ''
  return message === '' ? [] : [{ code: statusOf(landed), message }]
}
