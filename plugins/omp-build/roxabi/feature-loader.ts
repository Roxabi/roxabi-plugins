import type { FeatureWorkflow } from './feature-contract.ts'
import type { publishFeatureNativeResult as PublishFeatureNativeResult } from './feature-result.ts'
import type { consumeWatchExit as ConsumeWatchExit } from './feature-watch.ts'
import type {
  continueFeature as ContinueFeature,
  requestFeatureSessionPause as RequestFeatureSessionPause,
} from './workflow.ts'

// Keep the Feature-only installed modules behind this boundary so unrelated
// extension commands remain available when the Feature distribution is unavailable.
const WORKFLOW_SPECIFIER = new URL('../roxabi/workflow.ts', import.meta.url).href
const RESULT_SPECIFIER = new URL('../roxabi/feature-result.ts', import.meta.url).href
const WATCH_SPECIFIER = new URL('../roxabi/feature-watch.ts', import.meta.url).href

function isCallable<T>(value: unknown): value is T {
  return typeof value === 'function'
}

export async function loadFeatureWorkflow(): Promise<FeatureWorkflow> {
  try {
    const [workflowModule, resultModule, watchModule] = await Promise.all([
      import(WORKFLOW_SPECIFIER),
      import(RESULT_SPECIFIER),
      import(WATCH_SPECIFIER),
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
