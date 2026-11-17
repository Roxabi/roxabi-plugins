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

export type FeatureCurrent = (() => boolean) & { transfer?: (owner: OwnedFeature) => void }

/** Bind continuation authority to exactly one owner, moving it only at a successful handoff. */
export function featureCurrent(key: object, owner: OwnedFeature, canContinue: () => boolean): FeatureCurrent {
  let expected = owner
  const current: FeatureCurrent = () => canContinue() && ownedFeatureFor(key) === expected
  current.transfer = (successor) => {
    expected = successor
  }
  return current
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

export function isOwnedFeatureWatch(key: object, controller: AbortController): boolean {
  return ownedWatches.get(key) === controller
}

export function settleOwnedFeatureWatch(key: object, controller: AbortController): boolean {
  if (ownedWatches.get(key) !== controller) return false
  ownedWatches.delete(key)
  return true
}
