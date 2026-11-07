import { realpathSync } from 'node:fs'
import type { ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { featureSessionCwdMessage, featureStopMessage } from './feature-presentation.ts'

function sameRealpath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

export async function deliverSessionCwd(
  result: Extract<ContinueFeatureResult, { kind: 'session-cwd' }>,
  host: FeatureCommandHost,
): Promise<void> {
  const stop = featureStopMessage(result)
  if (stop !== null) {
    await host.send(`session-cwd ${host.cwd}\n${stop}`)
    return
  }
  if (sameRealpath(result.path, host.cwd)) {
    await host.send('feature-stopped: session-cwd-already-current')
    return
  }
  await host.send(featureSessionCwdMessage(result.path, result.instruction))
}
