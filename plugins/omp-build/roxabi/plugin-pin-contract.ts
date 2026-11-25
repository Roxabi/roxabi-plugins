import type { Result } from '../engine/result.ts'
import type { FramingOrigin } from './feature-framing-controller-lease.ts'

export type { PinnedFileRef } from '../engine/action-input-refs.ts'

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
