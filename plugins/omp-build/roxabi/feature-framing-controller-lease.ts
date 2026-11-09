import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { FramingStage } from '../engine/framing-context-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic, UwLocation } from '../engine/uw-diagnostics.ts'
import type { FramingMaterialCapture, FramingSlotSelection } from '../engine/uw-framing-schema.ts'
import type {
  FeatureFramingControllerHost,
  FramingLease,
  FramingOwnerClaim,
  FramingPhase,
  FramingSourceRequest,
  FramingSubmissionResult,
  PendingFramingHandoff,
} from './feature-framing-contract.ts'
import type { FramingProcedures } from './feature-framing-procedures.ts'
import type { OperatorPort, UwRead } from './uw-contract.ts'
import type { FramingOperationResult, PreparedFramingProposal } from './uw-framing-contract.ts'
import { reservePreparedFramingProposal } from './uw-framing-prepare.ts'

export type FramingOrigin = Readonly<{
  sessionId: string
  agentId: string
  cwd: string
  sessionFile: string | undefined
  artifactsDir: string | null
}>
export type DetailRef = Readonly<{ reference: string; digest: string }>
export type RegisteredQuestion = Readonly<{
  toolCallId: string
  question: string
  stage: FramingStage
  kind: 'question' | 'wayfinder-offer'
}>
export type AcceptedDecision = Readonly<{ questionEntryId: string; answerEntryId: string; decision: string }>
export type AcceptedTerm = Readonly<{ term: string; meaning: string; stage: FramingStage }>
export type AcceptedModule = Readonly<{ name: string; interface: string; seam: string }>
export type NativeObservation = Readonly<{
  nativeParent: Scope | null
  children: readonly Scope[]
  blockers: readonly Scope[]
}>
/** One operator-selected existing issue, resolved by the host and read from a complete observation. */
export type BoundSelection = Readonly<{
  key: string
  uw: Scope
  selection: Extract<FramingSlotSelection, { kind: 'operator-reference' }>
  sourceBodySha256: string
  observed: NativeObservation
  title: string
  body: string
  analysis: UwRead['parsed']['analysis']
}>

/** Private, mutable lease state. Never exported through the controller API or the model index. */
export type LeaseState = {
  readonly handle: FramingLease
  readonly source: FramingSourceRequest
  readonly claim: FramingOwnerClaim
  readonly origin: FramingOrigin
  readonly ctx: ExtensionContext
  readonly readOnlyOperator: OperatorPort
  repository: string | null
  phase: FramingPhase
  stage: FramingStage
  revision: number
  started: boolean
  revoked: boolean
  finalized: boolean
  inflight: number
  submitting: boolean
  acting: boolean
  procedures: FramingProcedures | null
  sourceRead: UwRead | null
  sourceBasis: string | null
  index: DetailRef | null
  indexedBranch: string | null
  details: DetailRef[]
  token: Readonly<{ value: string; revision: number; stage: FramingStage }> | null
  shape: 'leaf' | 'parent' | null
  designed: boolean
  questions: RegisteredQuestion[]
  decisions: Record<FramingStage, AcceptedDecision[]>
  terms: AcceptedTerm[]
  modules: AcceptedModule[]
  materials: FramingMaterialCapture[]
  nextMaterial: number
  selections: BoundSelection[]
  proposal: Readonly<{ prepared: PreparedFramingProposal; revision: number }> | null
  revokeEffects: (() => void) | null
  outcome: FramingOperationResult | null
  ticket: PendingFramingHandoff | null
  ticketConsumed: boolean
}

export type ControllerCore = {
  readonly host: FeatureFramingControllerHost
  current: LeaseState | null
}

export function isRootContext(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}

export function captureOrigin(ctx: ExtensionContext): FramingOrigin {
  const manager = ctx.sessionManager
  return Object.freeze({
    sessionId: manager.getSessionId(),
    agentId: ctx.agent.id,
    cwd: ctx.cwd,
    sessionFile: manager.getSessionFile(),
    artifactsDir: manager.getArtifactsDir(),
  })
}

/** The receiving context is the same root session and agent; location is checked separately. */
export function sameSession(origin: FramingOrigin, ctx: ExtensionContext): boolean {
  return isRootContext(ctx) && ctx.agent.id === origin.agentId && ctx.sessionManager.getSessionId() === origin.sessionId
}

/** A captured `ctx.cwd` is never location proof alone: compare it and every live manager mapping. */
export function sameLocation(origin: FramingOrigin, ctx: ExtensionContext): boolean {
  const manager = ctx.sessionManager
  return (
    ctx.cwd === origin.cwd &&
    manager.getCwd() === origin.cwd &&
    manager.getSessionFile() === origin.sessionFile &&
    manager.getArtifactsDir() === origin.artifactsDir
  )
}

/** Live mapping through the lease's own context getters, for phases without a receiving context. */
export function liveLocation(lease: LeaseState): boolean {
  const manager = lease.ctx.sessionManager
  return (
    manager.getSessionId() === lease.origin.sessionId &&
    manager.getCwd() === lease.origin.cwd &&
    manager.getSessionFile() === lease.origin.sessionFile &&
    manager.getArtifactsDir() === lease.origin.artifactsDir
  )
}

/** Registered lease, exact owner generation, not revoked and not finalized. */
export function live(core: ControllerCore, lease: LeaseState): boolean {
  return core.current === lease && !lease.revoked && !lease.finalized && lease.claim.isCurrent()
}

export function currentAt(core: ControllerCore, lease: LeaseState, ctx: ExtensionContext): boolean {
  return live(core, lease) && sameSession(lease.origin, ctx) && sameLocation(lease.origin, ctx)
}

export function terminal(phase: FramingPhase): boolean {
  return phase.kind === 'closed' || phase.kind === 'blocked'
}

export function currentStage(lease: LeaseState): FramingStage {
  return lease.phase.kind === 'interview' ? lease.phase.stage : lease.stage
}

export function framingDiagnostic(lease: LeaseState | null, code: string, message: string): UwDiagnostic {
  const location: UwLocation =
    lease?.source.kind === 'issue'
      ? { kind: 'native', uw: lease.source.uw, connection: 'state' }
      : { kind: 'repository', repository: lease?.repository ?? 'unbound' }
  return { code, message, location, related: [] }
}

/** Plain Roxabi diagnostics gain the lease location; UW diagnostics pass through unchanged. */
export function asUwDiagnostics(
  lease: LeaseState | null,
  diagnostics: readonly { code: string; message: string; location?: unknown }[],
): UwDiagnostic[] {
  return diagnostics.map((item) =>
    'location' in item && item.location !== undefined && 'related' in item
      ? (item as UwDiagnostic)
      : framingDiagnostic(lease, item.code, item.message),
  )
}

export function submission(
  lease: LeaseState | null,
  status: FramingSubmissionResult['status'],
  diagnostics: readonly UwDiagnostic[],
): FramingSubmissionResult {
  return Object.freeze({
    status,
    indexRef: lease?.index?.reference ?? '',
    diagnostics: Object.freeze([...diagnostics]),
  })
}

function disarm(lease: LeaseState): void {
  lease.token = null
  if (lease.proposal !== null) reservePreparedFramingProposal(lease.proposal.prepared)?.(false)
  lease.proposal = null
  const revokeEffects = lease.revokeEffects
  lease.revokeEffects = null
  revokeEffects?.()
}

/** Settled: no controller operation in flight and the root session is idle with nothing queued. */
function settled(lease: LeaseState): boolean {
  if (lease.inflight > 0) return false
  try {
    return lease.ctx.isIdle() && !lease.ctx.hasPendingMessages()
  } catch {
    return true
  }
}

export function finalize(core: ControllerCore, lease: LeaseState): void {
  if (lease.finalized) return
  lease.finalized = true
  disarm(lease)
  if (core.current === lease) core.current = null
  lease.claim.release()
}

export function maybeFinalize(core: ControllerCore, lease: LeaseState): void {
  if (!lease.finalized && (lease.revoked || terminal(lease.phase)) && settled(lease)) finalize(core, lease)
}

/** Terminal closure keeps denying until settlement; the first terminal reason is preserved. */
export function closeLease(
  core: ControllerCore,
  lease: LeaseState,
  phase: Extract<FramingPhase, { kind: 'closed' | 'blocked' }>,
  abortCtx?: ExtensionContext,
  message?: string,
): void {
  if (lease.finalized) return
  disarm(lease)
  const first = !terminal(lease.phase)
  if (first) lease.phase = phase
  if (abortCtx) abortCtx.abort()
  if (first) core.host.status(message ?? `feature-framing ${phase.kind}: ${phase.reason}`)
  maybeFinalize(core, lease)
}

export function blockLease(
  core: ControllerCore,
  lease: LeaseState,
  reason: string,
  abortCtx?: ExtensionContext,
  message?: string,
): void {
  closeLease(core, lease, { kind: 'blocked', reason }, abortCtx, message)
}

/** Cancellation or explicit replacement: revoke every capability and abort the root operation. */
export function revokeLease(core: ControllerCore, lease: LeaseState, reason: string): void {
  if (lease.finalized) return
  lease.revoked = true
  closeLease(core, lease, { kind: 'closed', reason }, lease.ctx)
}
