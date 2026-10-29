export type OwnedFeature = {
  reference: string
  cwd: string
  pausable: boolean
}

const ownedFeatures = new WeakMap<object, OwnedFeature>()
const ownedWatches = new WeakMap<object, AbortController>()

export function rememberFeatureOwner(key: object, owned: OwnedFeature): void {
  ownedFeatures.set(key, owned)
}

export function releaseFeatureOwner(key: object): void {
  ownedFeatures.delete(key)
}

export function ownedFeatureFor(key: object): OwnedFeature | undefined {
  return ownedFeatures.get(key)
}

export function startOwnedFeatureWatch(key: object): AbortController {
  abortOwnedFeatureWatch(key)
  const controller = new AbortController()
  ownedWatches.set(key, controller)
  return controller
}

/** Ephemeral only. Pause, abandon, and session end abort the owned watch; nothing is written to disk. */
export function abortOwnedFeatureWatch(key: object): void {
  const controller = ownedWatches.get(key)
  if (controller === undefined) return
  ownedWatches.delete(key)
  controller.abort()
}

export function settleOwnedFeatureWatch(key: object, controller: AbortController): boolean {
  if (ownedWatches.get(key) !== controller) return false
  ownedWatches.delete(key)
  return true
}
