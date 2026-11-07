import type { IssueRef, IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { Scope } from '../engine/record-values.ts'
import type { FramingReceiptPayload, FramingReceiptRef } from '../engine/uw-framing-receipt-schema.ts'
import type { UwRead } from './uw-contract.ts'
import type { FramingEffectOutcome } from './uw-framing-executor-journal.ts'
import type { FramingReceiptPublication } from './uw-framing-identity.ts'
import {
  confirmedClaim,
  confirmedIntent,
  member,
  nativeOf,
  outcome,
  type Progress,
  plannedAllocation,
  type RunContext,
  readOf,
  recheck,
  type StepOf,
  scoped,
} from './uw-framing-run-context.ts'

type NativePayload = Extract<FramingReceiptPayload, { phase: 'intent' }>['native']
const FORMAT = 'omp-build-framing-receipt/1' as const
function nativePayload(observed: IssueWriteObservation): NativePayload {
  const ref = (value: IssueRef) => ({ repository: value.repository, number: value.number })
  return {
    issue: ref(observed.issue),
    title: observed.title,
    body: observed.body,
    updatedAt: observed.updatedAt,
    nativeState: { state: observed.nativeState.state, stateReason: observed.nativeState.stateReason },
    labels: [...observed.labels],
    parent: observed.parent === null ? null : ref(observed.parent),
    children: observed.children.map(ref),
    blockers: observed.blockers.map(ref),
  }
}
function publicationStatus(status: string): FramingEffectOutcome['status'] {
  if (status === 'refused') return 'failed-before-effect'
  return status === 'partial' ? 'applied-readback-unconfirmed' : 'outcome-unknown'
}
function mergedHistories(...reads: (UwRead | undefined)[]) {
  const seen = new Set<string>()
  return reads
    .flatMap((read) => read?.histories ?? [])
    .filter((history) => {
      const key = `${history.source.scope.repository}\u0000${history.source.scope.target}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
export function receiptOutcome(
  published: FramingReceiptPublication,
  scope: Scope,
  confirm: (ref: FramingReceiptRef) => void,
): FramingEffectOutcome {
  if (published.status === 'confirmed') {
    confirm(published.ref)
    return outcome('confirmed', scope, [], [published.ref])
  }
  return outcome(
    publicationStatus(published.status),
    scope,
    published.diagnostics,
    published.ref === undefined ? [] : [published.ref],
  )
}

export async function intentEffect(
  ctx: RunContext,
  step: StepOf<'publish-intent'>,
  progress: Progress,
): Promise<FramingEffectOutcome> {
  const root = member(ctx, ctx.rootKey)
  const checked = await recheck(ctx, [ctx.rootKey])
  if (!checked.ok) return outcome('failed-before-effect', root.scope, checked.diagnostics)
  progress.attempted = true
  const scope = scoped(root)
  const read = readOf(checked.reads, ctx.rootKey)
  const published = await ctx.publication.receipt({
    scope,
    operationId: ctx.opId,
    proposalDigest: ctx.digest,
    effectId: step.effectId,
    member: ctx.rootKey,
    payload: {
      format: FORMAT,
      phase: 'intent',
      root: scope,
      proposal: ctx.proposal,
      proposalDigest: ctx.digest,
      confirmation: ctx.evidence,
      native: nativePayload(nativeOf(read)),
    },
    histories: read.histories,
    guard: ctx.guard,
  })
  return receiptOutcome(published, scope, (ref) => {
    ctx.state.intent = ref
    root.records.push(ref.recordId)
  })
}

export async function bindingEffect(
  ctx: RunContext,
  step: StepOf<'publish-binding'>,
  progress: Progress,
): Promise<FramingEffectOutcome> {
  const run = member(ctx, step.member)
  const checked = await recheck(ctx, [run.planned.key, ctx.rootKey])
  if (!checked.ok) return outcome('failed-before-effect', run.scope, checked.diagnostics)
  progress.attempted = true
  const scope = scoped(run)
  const published = await ctx.publication.receipt({
    scope,
    operationId: ctx.opId,
    proposalDigest: ctx.digest,
    effectId: step.effectId,
    member: run.planned.key,
    payload: {
      format: FORMAT,
      phase: 'member-binding',
      intent: confirmedIntent(ctx),
      member: run.planned.key,
      memberDigest: run.planned.memberDigest,
    },
    histories: mergedHistories(checked.reads.get(run.planned.key), checked.reads.get(ctx.rootKey)),
    guard: ctx.guard,
  })
  return receiptOutcome(published, scope, (ref) => {
    run.binding = ref
    run.records.push(ref.recordId)
  })
}

export async function claimEffect(
  ctx: RunContext,
  step: StepOf<'publish-claim'>,
  progress: Progress,
): Promise<FramingEffectOutcome> {
  const run = member(ctx, step.member)
  const root = member(ctx, ctx.rootKey)
  const checked = await recheck(ctx, [run.planned.key, ctx.rootKey])
  if (!checked.ok) return outcome('failed-before-effect', root.scope, checked.diagnostics)
  progress.attempted = true
  const rootScope = scoped(root)
  const read = readOf(checked.reads, run.planned.key)
  const published = await ctx.publication.receipt({
    scope: rootScope,
    operationId: ctx.opId,
    proposalDigest: ctx.digest,
    effectId: step.effectId,
    member: run.planned.key,
    payload: {
      format: FORMAT,
      phase: 'member-claim',
      intent: confirmedIntent(ctx),
      member: run.planned.key,
      ordinal: run.planned.ordinal,
      memberDigest: run.planned.memberDigest,
      scope: scoped(run),
      slot: run.planned.slot.kind,
      binding: run.planned.key === ctx.rootKey ? null : run.binding,
      native: nativePayload(nativeOf(read)),
    },
    histories: mergedHistories(checked.reads.get(ctx.rootKey), read),
    guard: ctx.guard,
  })
  return receiptOutcome(published, rootScope, (ref) => {
    run.claim = ref
    root.records.push(ref.recordId)
  })
}

export async function identityEffect(
  ctx: RunContext,
  step: StepOf<'publish-identity'>,
  progress: Progress,
): Promise<FramingEffectOutcome> {
  const run = member(ctx, step.member)
  const checked = await recheck(ctx, [run.planned.key])
  if (!checked.ok) return outcome('failed-before-effect', run.scope, checked.diagnostics)
  const allocation = plannedAllocation(run)
  const predecessor =
    step.event === 'retire-proposed' && allocation.assignments.length > 0 ? run.allocated : allocation.ledgerHead
  progress.attempted = true
  const scope = scoped(run)
  const claim = confirmedClaim(run)
  const published = await ctx.publication.identity({
    uw: scope,
    operationId: ctx.opId,
    authorization: {
      kind: 'framing-member',
      intent: confirmedIntent(ctx),
      claim,
      binding: run.binding ?? claim,
      member: run.planned.key,
      memberDigest: run.planned.memberDigest,
      confirmation: ctx.evidence,
    },
    plan: allocation,
    predecessor,
    event: step.event,
    effectId: step.effectId,
    guard: ctx.guard,
  })
  if (published.status !== 'confirmed')
    return outcome(
      publicationStatus(published.status),
      scope,
      published.diagnostics,
      published.predecessor === undefined ? [] : [published.predecessor],
    )
  run.head = published.predecessor
  run.records.push(published.predecessor.recordId)
  run.identities.push(published.predecessor)
  if (step.event === 'allocate') run.allocated = published.predecessor
  return outcome('confirmed', scope, [], [published.predecessor])
}
