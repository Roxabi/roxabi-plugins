import type { ContinueFeatureResult, FeatureCommandHost, FeatureFixTerminal } from './feature-contract.ts'
import type { FeatureCurrent } from './feature-host-ownership.ts'
import { featureErrorMessage } from './feature-presentation.ts'
import { recordStartNotActivated } from './feature-start-executions.ts'

type Deliver = (
  reference: string,
  result: ContinueFeatureResult,
  host: FeatureCommandHost,
  current?: FeatureCurrent,
) => Promise<void>
function observeFeatureTerminal(
  reference: string,
  host: FeatureCommandHost,
  terminal: Promise<FeatureFixTerminal>,
  deliver: Deliver,
  current: FeatureCurrent,
): void {
  const owns: FeatureCurrent = () => current() && !host.featureContinuationInhibited()
  if (current.transfer) owns.transfer = current.transfer
  void terminal
    .then(async (result) => {
      if (result.status !== 'complete' || !owns()) return
      const next = await host.workflow.continueFeature({
        cwd: host.cwd,
        reference,
        control: 'continue',
        principal: false,
        owned: owns,
        ...(host.uw === undefined ? {} : { read: host.uw, uw: host.uw }),
        ...(host.pluginPin === undefined ? {} : { pluginPin: host.pluginPin }),
      })
      if (!owns()) {
        if (next.kind === 'action') recordStartNotActivated(next.start)
        return
      }
      await deliver(reference, next, host, owns)
    })
    .catch(async (error: unknown) => {
      if (owns()) await host.send(featureErrorMessage(error))
    })
}

export async function continueAfterFix(
  reference: string,
  fix: Extract<ContinueFeatureResult, { kind: 'fix' }>,
  host: FeatureCommandHost,
  deliver: Deliver,
  current?: () => boolean,
): Promise<void> {
  if (host.startFix === undefined) {
    await host.send('feature-stopped: fix-unavailable')
    return
  }
  const run = await host.startFix(fix, current)
  observeFeatureTerminal(reference, host, run.terminal, deliver, run.current)
}

export async function continueAfterAdmittedCiCorrection(
  reference: string,
  result: Extract<ContinueFeatureResult, { kind: 'admitted-ci-correction' }>,
  host: FeatureCommandHost,
  deliver: Deliver,
  current?: () => boolean,
): Promise<void> {
  if (host.startAdmittedCiCorrection === undefined) {
    await host.send('feature-stopped: ci-correction-unavailable')
    return
  }
  const run = await host.startAdmittedCiCorrection(
    {
      reference: result.reference,
      attributionRecordId: result.attributionRecordId,
      uw: result.uw,
    },
    current,
  )
  observeFeatureTerminal(reference, host, run.terminal, deliver, run.current)
}
