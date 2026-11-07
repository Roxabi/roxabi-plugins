import type { IssueWriteObservation, WriteDiagnostic } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingProposal, FramingReceiptRef } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { UwRead } from './uw-contract.ts'
import type { FramingEffectGuard, WrittenFramingGraph } from './uw-framing-contract.ts'
import { type FramingMemberRun, type FramingRunState, nativeDiagnostic } from './uw-framing-executor-check.ts'
import type { FramingEffectOutcome, FramingStep } from './uw-framing-executor-journal.ts'
import { memberDrift } from './uw-framing-journal-drift.ts'
import type { FramingExecutorPorts, FramingPublicationPorts } from './uw-framing-ports.ts'
import { observation } from './uw-operation-observation.ts'

type Planned = FramingProposal['members'][number]
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export function repositoryDiagnostic(repository: string, code: string, text: string): UwDiagnostic {
  return { code, message: text, location: { kind: 'repository', repository }, related: [] }
}
export type Progress = { attempted: boolean }
export type Failure = { ok: false; diagnostics: readonly UwDiagnostic[] }
type Checked = { ok: true; reads: ReadonlyMap<FramingMemberKey, UwRead> } | Failure
export type StepOf<K extends FramingStep['kind']> = Extract<FramingStep, { kind: K }>

/** One confirmed run: the sealed aggregate, its confirmation, and the expected state advanced only by confirmed effects. */
export type RunContext = {
  proposal: FramingProposal
  digest: string
  opId: string
  rootKey: FramingMemberKey
  repository: string
  guard: FramingEffectGuard
  ports: FramingExecutorPorts
  publication: FramingPublicationPorts
  state: FramingRunState
  evidence: OperatorConfirmationEvidence
  written: WrittenFramingGraph | null
}
// Facts established by earlier confirmed effects. Each helper throws where that fact is used,
// so perform classifies it by the attempt mark: failed-before-effect before the primitive,
// outcome-unknown after the attempt. Never a fabricated value.
export function member(ctx: RunContext, key: FramingMemberKey): FramingMemberRun {
  const run = ctx.state.members.get(key)
  if (run === undefined) throw new Error(`framing-member-unplanned:${key}`)
  return run
}
export function scoped(run: FramingMemberRun): Scope {
  if (run.scope === null) throw new Error(`framing-member-unscoped:${run.planned.key}`)
  return run.scope
}
export function confirmedIntent(ctx: RunContext): FramingReceiptRef {
  if (ctx.state.intent === null) throw new Error('framing-intent-unconfirmed')
  return ctx.state.intent
}
export function confirmedClaim(run: FramingMemberRun): FramingReceiptRef {
  if (run.claim === null) throw new Error(`framing-claim-unconfirmed:${run.planned.key}`)
  return run.claim
}
export function plannedAllocation(run: FramingMemberRun): NonNullable<Planned['allocation']> {
  const allocation = run.planned.allocation
  if (allocation === null) throw new Error(`framing-allocation-missing:${run.planned.key}`)
  return allocation
}
export function readOf(reads: ReadonlyMap<FramingMemberKey, UwRead>, key: FramingMemberKey): UwRead {
  const read = reads.get(key)
  if (read === undefined) throw new Error(`framing-read-missing:${key}`)
  return read
}
export function nativeOf(read: UwRead): IssueWriteObservation {
  const native = observation(read)
  if (native === null) throw new Error(`framing-native-unobserved:${read.uw.target}`)
  return native
}
export function outcome(
  status: FramingEffectOutcome['status'],
  scope: Scope | null,
  diagnostics: readonly UwDiagnostic[],
  evidenceRefs: readonly ExternalRecordRef[] = [],
): FramingEffectOutcome {
  return { status, scope, evidenceRefs, diagnostics }
}
export function point(ctx: RunContext, step: FramingStep, at: 'before-effect' | 'after-readback') {
  return { operationId: ctx.opId, proposalDigest: ctx.digest, member: step.member, effectId: step.effectId, at }
}
export function located(ctx: RunContext, scope: Scope | null, code: string, text: string): UwDiagnostic {
  return scope === null ? repositoryDiagnostic(ctx.repository, code, text) : nativeDiagnostic(scope, code, text)
}
export function writeDiagnostics(
  ctx: RunContext,
  scope: Scope | null,
  values: readonly WriteDiagnostic[],
): UwDiagnostic[] {
  return values.map((value) =>
    located(ctx, value.issue === undefined ? scope : ctx.ports.scopeOf(value.issue), value.code, value.message),
  )
}
export async function freshRead(ctx: RunContext, scope: Scope): Promise<{ ok: true; read: UwRead } | Failure> {
  try {
    return { ok: true, read: await ctx.ports.read(scope) }
  } catch (error) {
    return { ok: false, diagnostics: [nativeDiagnostic(scope, 'framing-read-unavailable', message(error))] }
  }
}

/** Fresh complete reads of each involved member, compared with the exact confirmed prefix. */
export async function recheck(ctx: RunContext, keys: readonly FramingMemberKey[]): Promise<Checked> {
  const reads = new Map<FramingMemberKey, UwRead>()
  for (const key of new Set(keys)) {
    const run = member(ctx, key)
    if (run.scope === null) continue
    const fresh = await freshRead(ctx, run.scope)
    if (!fresh.ok) return fresh
    const drift = await memberDrift(ctx.state, run, fresh.read)
    if (drift.length > 0) return { ok: false, diagnostics: drift }
    reads.set(key, fresh.read)
  }
  return { ok: true, reads }
}
