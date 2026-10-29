import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'
import type { OperatorPort, UwOperations } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations, type InstalledUwOperationsOptions } from '../roxabi/uw-installed-operations.ts'
import { hostPluginPin } from './host-plugin-pin.ts'
import type { UwOperationsFactory } from './omp-uw-command.ts'

export function installedUwRequest(
  ctx: Pick<ExtensionContext, 'cwd' | 'localProtocolOptions'>,
  operator: OperatorPort,
  pin: TrustedHostPluginPin | undefined = hostPluginPin(),
): InstalledUwOperationsOptions {
  const artifactsDir = ctx.localProtocolOptions?.getArtifactsDir?.() ?? null
  return {
    cwd: ctx.cwd,
    operator,
    artifactsDir,
    ...(pin === undefined ? {} : { pluginPin: pin }),
  }
}

export function createHostUwOperations(
  ctx: Pick<ExtensionContext, 'cwd' | 'localProtocolOptions'>,
  operator: OperatorPort,
  pin?: TrustedHostPluginPin,
): Promise<UwOperations> {
  return Promise.resolve(createInstalledUwOperations(installedUwRequest(ctx, operator, pin)))
}

export function hostUwFactory(pin?: TrustedHostPluginPin) {
  return (input: { cwd: string; operator: OperatorPort; artifactsDir: string | null }) =>
    createHostUwOperations(
      { cwd: input.cwd, localProtocolOptions: { getArtifactsDir: () => input.artifactsDir } },
      input.operator,
      pin,
    )
}

export async function resolveFeatureUw(
  ctx: Pick<ExtensionContext, 'cwd' | 'localProtocolOptions'>,
  operator: Parameters<UwOperationsFactory>[0]['operator'],
  factory: UwOperationsFactory | undefined,
  pin?: TrustedHostPluginPin,
): Promise<UwOperations> {
  if (factory === undefined) return createHostUwOperations(ctx, operator, pin)
  return factory({
    cwd: ctx.cwd,
    operator,
    artifactsDir: ctx.localProtocolOptions?.getArtifactsDir?.() ?? null,
  })
}
