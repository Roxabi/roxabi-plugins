import type { ContinueFeatureInput, ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { featureErrorMessage } from './feature-presentation.ts'

export async function continueWithParentCoverage(
  host: FeatureCommandHost,
  input: ContinueFeatureInput,
  result: ContinueFeatureResult,
  principalDispatch: boolean,
): Promise<ContinueFeatureResult | undefined> {
  if (
    principalDispatch ||
    result.kind !== 'blocked' ||
    result.coverageRequest === undefined ||
    host.requestParentCoverage === undefined
  )
    return result
  const parentCoverage = await host.requestParentCoverage(result.coverageRequest)
  if (parentCoverage.kind !== 'proposed') return result
  try {
    return await host.workflow.continueFeature({
      ...input,
      parentCoverage: parentCoverage.coverage,
      parentCoverageBasis: result.coverageRequest,
    })
  } catch (error) {
    await host.send(featureErrorMessage(error))
    return undefined
  }
}
