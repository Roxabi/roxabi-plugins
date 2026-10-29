import type {
  ActionInputManifest,
  ActionInputs,
  ActionPurpose,
  ActionSubject,
  DeliveryDataRef,
  PinnedFileRef,
  RecordInputRef,
} from '../engine/action-input-schema.ts'
import type { Json } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { PreparedReviewChunk } from './review-input-contract.ts'

export type {
  ActionInputManifest,
  ActionInputs,
  ActionPurpose,
  ActionSubject,
  DeliveryDataRef,
  PinnedFileRef,
  RecordInputRef,
} from '../engine/action-input-schema.ts'

export type InstalledPluginPin = {
  name: 'omp-build'
  version: string
  repository: string
  commit: string
  /** Git-relative plugin root at repository/commit, never an installed absolute path. */
  root: string
}

export type PluginPinPort = {
  resolveInstalledPluginPin(): Promise<Result<InstalledPluginPin>>
  readInstalledFile(path: string): Promise<Result<Uint8Array>>
}

/**
 * Trusted host composition only. Not command JSON, an LLM claim, or a new environment convention.
 * `installedRoot` is the private filesystem root used to byte-compare; it is not `InstalledPluginPin.root`.
 */
export type TrustedHostPluginPin = {
  repository: string
  commit: string
  installedRoot: string
}

export type UwActionRequest = {
  actionId: string
  purpose: ActionPurpose
  subject: ActionSubject
  code: ActionInputManifest['code']
  stageSources: readonly RecordInputRef[]
  expandedContext: readonly (RecordInputRef | PinnedFileRef)[]
}

/** Host-only local view. Excluded from the canonical manifest hash; included in the seal. */
export type ReviewActionProjection = Readonly<{
  taskName: string
  assignedChunk: number | null
  contextWindow: number
  chunks: readonly PreparedReviewChunk[]
}>

export type ReviewActionBatch = {
  actions: readonly { request: UwActionRequest; projection: ReviewActionProjection }[]
}

export type CurrentActionFacts = {
  spec: ActionInputManifest['spec']
  subject: ActionSubject
  acceptedSources: RecordInputRef[]
  deliveryData: DeliveryDataRef[]
  currentOutputs: RecordInputRef[]
  configuration: ActionInputManifest['configuration']
  /** Authenticated prior action for explicit fresh planner expansion. */
  expansionPrevious?: ActionInputs
}

export type UwInputReadPorts = {
  readCurrentActionFacts(request: UwActionRequest, reviewedFingerprint?: string): Promise<Result<CurrentActionFacts>>
  readCurrentActionFactsBatch?(
    requests: readonly UwActionRequest[],
    reviewedFingerprint?: string,
  ): Promise<Result<readonly { actionId: string; facts: CurrentActionFacts }[]>>
  readRecord(ref: RecordInputRef): Promise<Result<Json>>
  readAccountedRecord?(ref: RecordInputRef): Promise<Result<Json>>
  readPinnedFile(ref: PinnedFileRef): Promise<Result<Uint8Array>>
  readPinnedFiles?(refs: readonly PinnedFileRef[]): Promise<Result<readonly Uint8Array[]>>
  readCodeDiff(code: { repository: string; base: string; head: string }): Promise<Result<Uint8Array>>
  repositoryReferences(request: UwActionRequest): Promise<Result<PinnedFileRef[]>>
  plugin: PluginPinPort
}

export type ActionSnapshotStore = {
  create(input: {
    actionId: string
    files: readonly { path: string; bytes: Uint8Array }[]
  }): Promise<Result<{ indexPath: string; location: 'local' | 'worktree-gitdir' }>>
}

export type UwActionPorts = UwInputReadPorts & { snapshots: ActionSnapshotStore }

export type ResolvedActionInputs = {
  actionId: string
  inputs: ActionInputs
  files: readonly { path: string; bytes: Uint8Array }[]
}

/** Nominal host handle. A field-equal clone is not registered and cannot verify. */
export type ActionSnapshot = Readonly<{
  id: string
  actionId: string
  manifestDigest: string
  indexPath: string
  location: 'local' | 'worktree-gitdir'
  integrityDigest: string
}>

export type PreparedUwAction = { inputs: ActionInputs; snapshot: ActionSnapshot }
