/** Trusted host composition only. Not argv, env, tool JSON, or a model claim. */
export type HostPluginPin = {
  repository: string
  commit: string
  installedRoot: string
}

let bound: HostPluginPin | undefined

/** Last trusted composition wins for this process. Unset leaves B's ordinary tooling-pin path. */
export function bindHostPluginPin(pin: HostPluginPin | undefined): void {
  bound = pin
}

export function hostPluginPin(): HostPluginPin | undefined {
  return bound
}
