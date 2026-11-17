import type { FeatureWorkflow } from './feature-contract.ts'
import type { publishFeatureNativeResult as PublishFeatureNativeResult } from './feature-result.ts'
import type { consumeWatchExit as ConsumeWatchExit } from './feature-watch.ts'
import type {
  continueFeature as ContinueFeature,
  requestFeatureSessionPause as RequestFeatureSessionPause,
} from './workflow.ts'

// Keep the Feature-only installed modules behind this boundary so unrelated
// extension commands remain available when the Feature distribution is unavailable.
// Literal imports keep these lazy modules in OMP's current module graph; computed URLs split owners.
function isCallable<T>(value: unknown): value is T {
  return typeof value === 'function'
}

export async function loadFeatureWorkflow(): Promise<FeatureWorkflow> {
  try {
    const [workflowModule, resultModule, watchModule] = await Promise.all([
      import('./workflow.ts'),
      import('./feature-result.ts'),
      import('./feature-watch.ts'),
    ])
    const { continueFeature, requestFeatureSessionPause } = workflowModule
    const { publishFeatureNativeResult } = resultModule
    const { consumeWatchExit } = watchModule
    if (
      !isCallable<typeof ContinueFeature>(continueFeature) ||
      !isCallable<typeof ConsumeWatchExit>(consumeWatchExit) ||
      !isCallable<typeof PublishFeatureNativeResult>(publishFeatureNativeResult) ||
      !isCallable<typeof RequestFeatureSessionPause>(requestFeatureSessionPause)
    ) {
      throw new Error('feature-workflow-unavailable')
    }
    const workflow = {
      continueFeature,
      consumeWatchExit,
      publishFeatureNativeResult,
      requestFeatureSessionPause,
    } satisfies FeatureWorkflow
    return workflow
  } catch (error) {
    if (error instanceof Error && error.message === 'feature-workflow-unavailable') throw error
    throw new Error('feature-workflow-unavailable')
  }
}
