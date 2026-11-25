import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { OperatorPort, UwOperations } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import type { UwOperationsFactory } from './omp-uw-command.ts'

export function hostUwFactory(): UwOperationsFactory {
  return createInstalledUwOperations
}

export async function resolveFeatureUw(
  ctx: Pick<ExtensionContext, 'cwd'>,
  operator: OperatorPort,
  factory: UwOperationsFactory | undefined,
): Promise<UwOperations> {
  return (factory ?? createInstalledUwOperations)({ cwd: ctx.cwd, operator })
}
