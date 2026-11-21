import type { ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'

type Correction = Extract<ContinueFeatureResult, { kind: 'fix' | 'admitted-ci-correction' }>

export function correctionSuccessor(
  next: Correction,
  host: FeatureCommandHost,
  current: () => boolean,
  deliver: (result: ContinueFeatureResult, current?: () => boolean) => Promise<void>,
) {
  return async () => {
    if (!current()) return
    try {
      await deliver(next, current)
    } catch (error) {
      if (current()) {
        try {
          await host.send(
            `feature-stopped: correction-delivery-failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        } catch (notification) {
          throw new AggregateError([error, notification], 'Correction delivery and notification failed', {
            cause: error,
          })
        }
      }
      throw error
    }
  }
}
