import { framingObservationDigest, sameScope } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingReceiptPayload, FramingReceiptRef } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import type { UwRead } from './uw-contract.ts'
import { buildFramingResultPayload } from './uw-framing-commit.ts'
import { type FramingMemberRun, nativeDiagnostic, sameRecordRef } from './uw-framing-executor-check.ts'
import type { FramingEffectOutcome } from './uw-framing-executor-journal.ts'
import { memberDrift } from './uw-framing-journal-drift.ts'
import { receiptOutcome } from './uw-framing-publication-effects.ts'
import {
  confirmedClaim,
  confirmedIntent,
  type Failure,
  freshRead,
  member,
  outcome,
  type Progress,
  type RunContext,
  readOf,
  type StepOf,
  scoped,
} from './uw-framing-run-context.ts'

type ResultPayload = Extract<FramingReceiptPayload, { phase: 'result' }>
type Cut = { ok: true; rootRead: UwRead; reads: ReadonlyMap<FramingMemberKey, UwRead> } | Failure
/** Every member from the same complete cut. */
async function finalCut(ctx: RunContext, rootScope: Scope): Promise<Cut> {
  const fresh = await freshRead(ctx, rootScope)
  if (!fresh.ok) return fresh
  const rootRead = fresh.read
  const observed = rootRead.observedReader
  if (rootRead.observation.status !== 'complete' || observed === undefined)
    return {
      ok: false,
      diagnostics: [
        nativeDiagnostic(rootScope, 'framing-result-unreadable', 'A complete same-cut observation is required'),
      ],
    }
  const reads = new Map<FramingMemberKey, UwRead>()
  for (const run of ctx.state.members.values()) {
    const scope = scoped(run)
    const read = sameScope(scope, rootScope) ? rootRead : await observed.readUw(scope)
    if (read.observation !== rootRead.observation)
      return {
        ok: false,
        diagnostics: [
          nativeDiagnostic(scope, 'framing-result-unreadable', 'Members must be read from the same complete cut'),
        ],
      }
    reads.set(run.planned.key, read)
  }
  return { ok: true, rootRead, reads }
}

function boundMember(run: FramingMemberRun) {
  const claim = confirmedClaim(run)
  return { key: run.planned.key, scope: scoped(run), claim, binding: run.binding ?? claim }
}

/** The result is built only after every member holds the exact expected prefix in one complete cut. */
async function resultPayload(
  ctx: RunContext,
  rootScope: Scope,
): Promise<{ ok: true; intent: FramingReceiptRef; payload: ResultPayload; histories: UwRead['histories'] } | Failure> {
  const cut = await finalCut(ctx, rootScope)
  if (!cut.ok) return cut
  for (const run of ctx.state.members.values()) {
    const drift = await memberDrift(ctx.state, run, readOf(cut.reads, run.planned.key))
    if (drift.length > 0) return { ok: false, diagnostics: drift }
  }
  const intent = confirmedIntent(ctx)
  const payload = await buildFramingResultPayload({
    proposal: ctx.proposal,
    intent,
    members: ctx.proposal.members.map((planned) => boundMember(member(ctx, planned.key))),
    identities: ctx.proposal.members.flatMap((planned) => member(ctx, planned.key).identities),
    rootRead: cut.rootRead,
  })
  if (!payload.ok) return payload
  return { ok: true, intent, payload: payload.value, histories: cut.rootRead.histories }
}

function completeMembership(
  read: UwRead,
  key: FramingMemberKey,
  intent: FramingReceiptRef,
  result: FramingReceiptRef,
): boolean {
  const membership = read.admission.aggregate
  return (
    membership.status === 'complete' &&
    membership.member === key &&
    sameRecordRef(membership.intent, intent) &&
    sameRecordRef(membership.result, result)
  )
}

/** Written only when every member reads back complete under this exact intent and result. */
async function confirmResult(
  ctx: RunContext,
  rootScope: Scope,
  intent: FramingReceiptRef,
  result: FramingReceiptRef,
  payload: ResultPayload,
): Promise<FramingEffectOutcome> {
  const unconfirmed = (diagnostics: readonly UwDiagnostic[]) =>
    outcome('applied-readback-unconfirmed', rootScope, diagnostics, [result])
  const after = await finalCut(ctx, rootScope)
  if (!after.ok) return unconfirmed(after.diagnostics)
  for (const run of ctx.state.members.values()) {
    if (!completeMembership(readOf(after.reads, run.planned.key), run.planned.key, intent, result))
      return unconfirmed([
        nativeDiagnostic(
          scoped(run),
          'framing-result-unconfirmed',
          'The complete aggregate result was not read back for every member',
        ),
      ])
  }
  if (after.rootRead.observation.status !== 'complete')
    return unconfirmed([nativeDiagnostic(rootScope, 'framing-result-unreadable', 'The post-result cut is incomplete')])
  ctx.written = Object.freeze({
    kind: ctx.proposal.input.kind,
    root: rootScope,
    intent,
    result,
    members: payload.members,
    coverageIntents: Object.freeze(payload.coverage.map((item) => ({ ...item, aggregateResult: result }))),
    observationDigest: framingObservationDigest(after.rootRead.observation),
  })
  return outcome('confirmed', rootScope, [], [result])
}

export async function resultEffect(
  ctx: RunContext,
  step: StepOf<'publish-result'>,
  progress: Progress,
): Promise<FramingEffectOutcome> {
  const rootScope = scoped(member(ctx, ctx.rootKey))
  const prepared = await resultPayload(ctx, rootScope)
  if (!prepared.ok) return outcome('failed-before-effect', rootScope, prepared.diagnostics)
  progress.attempted = true
  const published = await ctx.publication.receipt({
    scope: rootScope,
    operationId: ctx.opId,
    proposalDigest: ctx.digest,
    effectId: step.effectId,
    member: null,
    payload: prepared.payload,
    histories: prepared.histories,
    guard: ctx.guard,
  })
  if (published.status !== 'confirmed') return receiptOutcome(published, rootScope, () => undefined)
  return confirmResult(ctx, rootScope, prepared.intent, published.ref, prepared.payload)
}
