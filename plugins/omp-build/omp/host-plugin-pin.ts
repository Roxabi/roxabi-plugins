import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { defaultGh } from '../roxabi/feature-engine.ts'
import type { TrustedHostPluginPin } from '../roxabi/plugin-pin-contract.ts'
import { activePin, invalidateActivation } from './tooling-pin-state.ts'

export type HostPluginPin = TrustedHostPluginPin
const composed = new WeakMap<object, HostPluginPin>()

/** Trusted composition is owned by the extension instance, never the process. */
export function bindHostPluginPin(owner: object, pin: HostPluginPin | undefined): void {
  invalidateActivation(owner)
  if (pin === undefined) composed.delete(owner)
  else composed.set(owner, Object.freeze({ ...pin }))
}

export function composedHostPluginPin(owner: object): HostPluginPin | undefined {
  return composed.get(owner)
}

/** Resolve once per root operation; the inactive and composed paths never call GitHub. */
export async function hostPluginPin(owner: object, ctx: ExtensionContext): Promise<HostPluginPin | undefined> {
  return composed.get(owner) ?? activePin(owner, ctx, defaultGh())
}
