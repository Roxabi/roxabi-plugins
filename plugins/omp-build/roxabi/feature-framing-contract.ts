import type { ContextEvent, ContextEventResult, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Gh } from '../adapters/github/types.ts'
import type {
  FramingInvocationBinding,
  FramingProcedureManifest,
  FramingStage,
} from '../engine/framing-context-schema.ts'
import type { Result } from '../engine/result.ts'
import type { Scope } from '../engine/schema-primitives.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { ContinueFeatureInput } from './feature-contract.ts'
import type { FramedHandoffPreparation } from './feature-framing-handoff.ts'
import type { PinnedFileRef, PluginPinPort, TrustedHostPluginPin } from './uw-action-contract.ts'
import type { OperatorPort, UwOperations } from './uw-contract.ts'
import type { FramingEffect } from './uw-framing-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

export type FramingSourceRequest = { kind: 'free-text'; acceptedArgs: string } | { kind: 'issue'; uw: Scope }

export type FramingPhase =
  | { kind: 'loading' }
  | { kind: 'interview'; stage: FramingStage; waitingQuestion: string | null }
  | { kind: 'proposal-ready'; digest: string }
  | { kind: 'confirming' }
  | { kind: 'committing' }
  | { kind: 'awaiting-human-move' }
  | { kind: 'destination-check' }
  | { kind: 'continuing' }
  | { kind: 'closed'; reason: string }
  | { kind: 'blocked'; reason: string }

/** The one canonical read-only model tool Root registers; procedures and index name only this tool. */
export const FRAMING_SUBMIT_TOOL = 'omp_build_framing_submit'

declare const framingLeaseBrand: unique symbol
/** Host-only nominal handle. It carries no authority outside the controller's private registry. */
export type FramingLease = Readonly<{ [framingLeaseBrand]: true; generation: number }>

/** No result carries an approval, effect, checkout or delivery capability. */
export type FramingSubmissionResult = Readonly<{
  status: 'accepted' | 'waiting' | 'refused'
  indexRef: string
  diagnostics: readonly UwDiagnostic[]
}>

/** Immutable business ticket. Consumption state stays private to the one controller. */
export type PendingFramingHandoff = Readonly<{
  ticketId: string
  invocation: FramingInvocationBinding
  proposalDigest: string
  preparation: FramedHandoffPreparation
  effects: readonly FramingEffect[]
  sourceSession: Readonly<{ sessionId: string; agentId: string; cwd: string }>
  detailRefs: readonly Readonly<{ reference: string; digest: string }>[]
  procedures: FramingProcedureManifest
}>

/** Readonly policy snapshot for Root gates and lifecycle. It is never model or JSON authority. */
export type FramingControllerView = Readonly<{
  generation: number
  phase: FramingPhase
  source: FramingSourceRequest
  sessionId: string
  agentId: string
  indexRef: string | null
  /** Revoked or terminal leases keep denying until settled and idle, or until explicit replacement. */
  revoked: boolean
  /** Present only while a written aggregate waits for a genuine human-observed `/move`. */
  pendingMove: Readonly<{ root: Scope; destination: string }> | null
}>

export type FramingController = Readonly<{
  /** Synchronous: claims the owner slot and arms the read-only loading gate before any await. */
  begin(source: FramingSourceRequest, ctx: ExtensionContext): FramingLease
  start(lease: FramingLease): Promise<void>
  project(event: ContextEvent, ctx: ExtensionContext): Promise<ContextEventResult | undefined>
  /** Read-only and strictly parsed: may stage a proposal, never opens UI, writes, checks out, moves or delivers. */
  submit(
    input: unknown,
    actual: { ctx: ExtensionContext; toolCallId: string; signal: AbortSignal },
  ): Promise<FramingSubmissionResult>
  /** The sole genuine human surface: a fresh public shortcut context, no selection arguments. */
  act(ctx: ExtensionContext): Promise<void>
  /**
   * Lifecycle cancellation: revokes and aborts the current lease, which keeps denying (`view().revoked`)
   * until its in-flight work settles and the root session is idle. Calling it again on a revoked or
   * terminal lease only completes that settlement.
   */
  cancel(reason: string): void
  view(): FramingControllerView | null
  /** True when this receiving context is the root session the current framing lease governs. */
  governs(ctx: ExtensionContext): boolean
}>

export type FramingProcedurePorts = {
  plugin: PluginPinPort
  readPinnedFile(ref: PinnedFileRef): Promise<Result<Uint8Array>>
}
/** Root's actual per-context confirmation capability (`createOperatorConfirmation`). */
export type FramingOperator = OperatorPort & { cancel(): void }

/** One exact attachment to Root's single per-extension owner slot. */
export type FramingOwnerClaim = Readonly<{
  /** Root's host-monotonic generation for this attachment. */
  generation: number
  /** Exact current occupant and generation. */
  isCurrent(): boolean
  /** Clears the slot only while this attachment is still the exact occupant. */
  release(): void
}>

export type FeatureFramingControllerHost = Readonly<{
  owner: Readonly<{
    extensionInstanceId: string
    /**
     * Synchronously replaces the ONE owner slot occupant (cancelling its predecessor). Root calls
     * `revoke` ONLY on explicit replacement by another occupant; the lease is then aborted and released
     * immediately. Ordinary lifecycle cancellation goes through `FramingController.cancel`.
     */
    claim(revoke: (reason: string) => void): FramingOwnerClaim
  }>
  /** Public `pi.sendUserMessage`; the controller passes the exact accepted text unchanged. */
  sendUserMessage: ExtensionAPI['sendUserMessage']
  status(message: string): void
  /** Fresh cwd-bound installed pin and pinned-byte readers (`createProductionInputPorts`). */
  procedurePorts(location: Readonly<{ cwd: string }>): FramingProcedurePorts
  /** Fresh per-context confirmation capability; only `act` ever requests it. */
  operator(ctx: ExtensionContext): FramingOperator
  /** Actual installed UW factory bound to the receiving context and the given operator. */
  uw(input: Readonly<{ ctx: ExtensionContext; operator: OperatorPort }>): Promise<UwOperations>
  gh: Gh
  git: GitRunner
  pluginPin?: TrustedHostPluginPin
  /** Root's fresh ordinary same-UW continuation and delivery; called once per consumed ticket. */
  continueFeature(
    input: Readonly<{ ctx: ExtensionContext; continuation: ContinueFeatureInput; operator: FramingOperator }>,
  ): Promise<void>
}>
