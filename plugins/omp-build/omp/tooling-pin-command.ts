import { randomUUID } from 'node:crypto'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Gh } from '../adapters/github/types.ts'
import { defaultGh } from '../roxabi/feature-engine.ts'
import { sameLocation, sameSession } from '../roxabi/feature-framing-controller-lease.ts'
import type { ToolingPinActivationProposal } from '../roxabi/plugin-pin-contract.ts'
import { sha256Json } from '../roxabi/uw-action-result.ts'
import { composedHostPluginPin, hostPluginPin } from './host-plugin-pin.ts'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import { createOperatorConfirmation } from './omp-operator-confirmation.ts'
import { notifyOperator } from './omp-operator-confirmation-presenter.ts'
import { assertNoOwnedWork, observeToolingPin } from './tooling-pin-observation.ts'
import { activationGeneration, bindActivation, hasActivation } from './tooling-pin-state.ts'

async function bindConfirmedProposal(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  gh: Gh,
  proposal: ToolingPinActivationProposal,
  digest: string,
  generation: number,
): Promise<string> {
  const again = await observeToolingPin(pi, ctx, gh, proposal.operationId)
  if (sha256Json(again) !== digest) throw new Error('tooling-pin-proposal-changed')
  if (!sameSession(proposal.origin, ctx) || !sameLocation(proposal.origin, ctx))
    throw new Error('tooling-pin-origin-changed')
  if (composedHostPluginPin(pi) || hasActivation(pi)) throw new Error('tooling-pin-conflict')
  assertNoOwnedWork(pi)
  const pin = {
    repository: proposal.plugin.repository,
    commit: proposal.plugin.commit,
    installedRoot: proposal.installedRoot,
  }
  if (
    !bindActivation(pi, ctx, generation, {
      pin,
      origin: proposal.origin,
      commonDir: proposal.scope.gitCommonDir,
      targetRepository: proposal.scope.targetRepository,
      originUrl: proposal.scope.originUrl,
    })
  )
    throw new Error('tooling-pin-origin-changed')
  return 'activated'
}

async function activateToolingPin(pi: OmpBuildExtensionApi, ctx: ExtensionContext): Promise<void> {
  const operator = createOperatorConfirmation(ctx, { escape: 'defer' })
  operator.progress('/tooling-pin activate')
  try {
    if (hasActivation(pi)) throw new Error('tooling-pin-conflict')
    const generation = activationGeneration(pi)
    const gh = defaultGh()
    const operationId = `tooling-pin:${randomUUID()}`
    const proposal = await observeToolingPin(pi, ctx, gh, operationId)
    const digest = sha256Json(proposal)
    const result = await operator.executeConfirmed({ proposal, digest }, () =>
      bindConfirmedProposal(pi, ctx, gh, proposal, digest, generation),
    )
    if (result.status === 'confirmed') notifyOperator(ctx, 'tooling-pin: activated for this session')
    else notifyOperator(ctx, `tooling-pin: ${result.diagnostics.map((d) => d.code).join(', ')}`, 'warning')
  } catch (error) {
    notifyOperator(ctx, `tooling-pin: ${error instanceof Error ? error.message : String(error)}`, 'warning')
  } finally {
    operator.cancel()
  }
}

export function registerToolingPinCommand(pi: OmpBuildExtensionApi): void {
  pi.registerCommand('tooling-pin', {
    description: 'Inspect or confirm an isolated session tooling pin',
    async handler(args, ctx) {
      const command = args.trim()
      if (command === 'status') {
        const pin = await hostPluginPin(pi, ctx)
        notifyOperator(ctx, pin ? `tooling-pin: ${pin.repository}@${pin.commit}` : 'tooling-pin: ordinary shared pin')
        return
      }
      if (command !== 'activate') {
        notifyOperator(ctx, 'tooling-pin: use /tooling-pin status or /tooling-pin activate', 'warning')
        return
      }
      await activateToolingPin(pi, ctx)
    },
  })
}
