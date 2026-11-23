import type {
  ActionInputManifest,
  ActionInputs,
  ActionPurpose,
  ActionSubject,
  DeliveryDataRef,
  PinnedFileRef,
  RecordInputRef,
} from '../engine/action-input-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Json } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { ActionOperands } from '../engine/workflow-action-operands.ts'
import type { FramingOrigin } from './feature-framing-controller-lease.ts'

export type {
  ActionInputManifest,
  ActionInputs,
  ActionPurpose,
  ActionSubject,
  DeliveryDataRef,
  PinnedFileRef,
  RecordInputRef,
} from '../engine/action-input-schema.ts'
export type ReviewRootRef = ExternalRecordRef & { kind: 'review-attempt' }
export type CorrectionRootRef = Readonly<{ inventory: ReviewRootRef; requestId: string }>
export type SelectedReview = { root: ReviewRootRef; fingerprint: string }

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
 * Trusted host composition or genuine operator-confirmed session activation only.
 * `installedRoot` is the private filesystem root used to byte-compare; it is not `InstalledPluginPin.root`.
 */
export type TrustedHostPluginPin = {
  repository: string
  commit: string
  installedRoot: string
}

export type ToolingPinActivationProposal = Readonly<{
  format: 'omp-build-tooling-pin-activation/1'
  operationId: string
  plugin: InstalledPluginPin
  installedRoot: string
  packageDigest: string
  scope: Readonly<{ targetRepository: string; gitCommonDir: string; originUrl: string; lifetime: 'session' }>
  source: Readonly<{
    repository: string
    variable: 'OMP_BUILD_TOOLING_SHA'
    defaultBranch: string
    defaultHead: string
  }>
  shared: Readonly<{ repository: string; commit: string; status: 'mismatch' }>
  origin: FramingOrigin
}>
export type PreparedToolingPinActivation = Readonly<{ proposal: ToolingPinActivationProposal; digest: string }>

export type UwActionRequest = {
  actionId: string
  purpose: ActionPurpose
  subject: ActionSubject
  code: ActionInputManifest['code']
  stageSources: readonly RecordInputRef[]
  expandedContext: readonly (RecordInputRef | PinnedFileRef)[]
  operands?: ActionOperands
}

export type CurrentActionFacts = {
  spec: ActionInputManifest['spec']
  subject: ActionSubject
  acceptedSources: RecordInputRef[]
  deliveryData: DeliveryDataRef[]
  /** Host-only discovery seeds derived from the selected authenticated plan. */
  plannedPaths: readonly string[]
  operands?: ActionOperands
  currentOutputs: RecordInputRef[]
  configuration: ActionInputManifest['configuration']
  /** Authenticated prior action for explicit fresh planner expansion. */
  expansionPrevious?: ActionInputs
}

export type UwInputReadPorts = {
  readCurrentActionFacts(
    request: UwActionRequest,
    reviewedFingerprint?: string,
    reviewedRoot?: ReviewRootRef,
    correctionRoot?: CorrectionRootRef,
  ): Promise<Result<CurrentActionFacts>>
  readCurrentActionFactsBatch?(
    requests: readonly UwActionRequest[],
    reviewedFingerprint?: string,
    reviewedRoot?: ReviewRootRef,
  ): Promise<Result<readonly { actionId: string; facts: CurrentActionFacts }[]>>
  readRecord(ref: RecordInputRef): Promise<Result<Json>>
  /** One fresh history observation per invocation; every reference is independently validated. */
  readRecords(refs: readonly RecordInputRef[]): Promise<Result<readonly Json[]>>
  readAccountedRecord?(ref: RecordInputRef): Promise<Result<Json>>
  readPinnedFile(ref: PinnedFileRef): Promise<Result<Uint8Array>>
  readPinnedFiles?(refs: readonly PinnedFileRef[]): Promise<Result<readonly Uint8Array[]>>
  readCodeDiff(code: { repository: string; base: string; head: string }): Promise<Result<Uint8Array>>
  repositoryReferences(request: UwActionRequest, plannedPaths: readonly string[]): Promise<Result<PinnedFileRef[]>>
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
