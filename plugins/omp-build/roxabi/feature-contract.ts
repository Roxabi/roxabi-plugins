import type { Gh } from '../adapters/github/types.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Diagnostic } from '../engine/record-values.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { AcceptedChildCommitment, ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { FramingSourceRequest } from './feature-framing-contract.ts'
import type { TrustedHostPluginPin } from './uw-action-contract.ts'
import type { UwOperationResult, UwOperations, UwReadPort } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

export type FeatureControl = 'select' | 'continue' | 'resume' | 'pause' | 'abandon' | 'new' | 'material-decision'

export type ParentCoverageRequest = {
  parent: ParentCoverage['parent']
  accepted: { own: AcceptedOwnSpec['ref']; metadata: ExternalRecordRef } | null
  inheritedOwnSpecRefs: AcceptedOwnSpec['inheritedOwnSpecRefs']
  criteria: readonly { id: string; statement: string }[]
  children: readonly {
    scope: AcceptedChildCommitment['scope']
    specVersion: string
    tier: AcceptedChildCommitment['tier']
    criteria: readonly { id: string; statement: string }[]
  }[]
}

export type ContinueFeatureResult =
  | {
      kind: 'blocked'
      reason: string
      diagnostics?: readonly Diagnostic[]
    }
  | { kind: 'paused'; confirmed: boolean; reason: string }
  | {
      kind: 'abandoned'
      confirmed: boolean
      failure?:
        | {
            phase: 'uw'
            status: Exclude<UwOperationResult['status'], 'abandoned' | 'deferred'>
            diagnostics: readonly Diagnostic[]
          }
        | { phase: 'disarm'; evidence: unknown }
    }
  | { kind: 'terminal'; reason: string; diagnostics?: readonly Diagnostic[] }
  | { kind: 'session-cwd'; path: string; instruction: string }
  | { kind: 'operator-decision'; reason: string }
  | { kind: 'framing'; source: FramingSourceRequest }

export type ContinueFeatureInput = {
  cwd: string
  reference: string
  control: FeatureControl
  principal: boolean
  git?: GitRunner
  gh?: Gh
  uw?: UwOperations
  read?: UwReadPort
  /** Trusted host composition only. Omit for the ordinary published pin. */
  pluginPin?: TrustedHostPluginPin
  /** Ephemeral owner fence for this command's admission; never persisted. */
  owned?: () => boolean
}

export type FeatureWorkflow = {
  continueFeature(input: ContinueFeatureInput): Promise<ContinueFeatureResult>
}

export type ParsedFeatureCommand =
  | { ok: true; control: FeatureControl; reference: string }
  | { ok: true; control: 'resolve-interruption'; reference: string; start?: string }
  | { ok: true; control: 'init'; args: readonly string[] }
  | { ok: false; reason: string }

export type FeatureCommandHost = {
  key: object
  cwd: string
  uw?: UwOperations
  git?: FeatureGit
  send: (text: string) => Promise<void>
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ) => Promise<{ code: number; killed: boolean; stdout?: string; stderr?: string }>
}

export type FeatureGit = (args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>
