import type {
  IssueRef,
  IssueWriteObservation,
  IssueWriteResult,
  IssueWriter,
  NativeIssueWritePlan,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { Scope } from '../engine/record-values.ts'
import { type FramingMemberRun, nativeDiagnostic } from './uw-framing-executor-check.ts'
import type { FramingEffectOutcome, FramingStep } from './uw-framing-executor-journal.ts'
import {
  located,
  member,
  message,
  nativeOf,
  outcome,
  type Progress,
  point,
  type RunContext,
  readOf,
  recheck,
  type StepOf,
  scoped,
  writeDiagnostics,
} from './uw-framing-run-context.ts'
import { issueRef } from './uw-operation-observation.ts'

function emptyRelations(): NativeIssueWritePlan['relations'] {
  return { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] }
}
function refOf(scope: Scope): IssueRef {
  const ref = issueRef(scope)
  if (ref === null) throw new Error(`framing-scope-not-issue:${scope.target}`)
  return ref
}
/** The guarded writer for one step; a guard refusal before the primitive is remembered as no effect. */
function writerFor(ctx: RunContext, step: FramingStep) {
  let guardRefused = false
  const writer = ctx.ports.guardedWriter(async () => {
    try {
      await ctx.guard.check(point(ctx, step, 'before-effect'))
    } catch (error) {
      guardRefused = true
      throw error
    }
  })
  return { writer, guardRefused: () => guardRefused }
}

async function afterReadback(ctx: RunContext, step: FramingStep, scope: Scope): Promise<FramingEffectOutcome> {
  try {
    await ctx.guard.check(point(ctx, step, 'after-readback'))
  } catch (error) {
    return outcome('applied-readback-unconfirmed', scope, [
      nativeDiagnostic(scope, 'framing-guard-changed', message(error)),
    ])
  }
  return outcome('confirmed', scope, [])
}

/** Map one single-primitive writer result; a guard refusal before the primitive is never an effect. */
async function writerOutcome(
  ctx: RunContext,
  step: FramingStep,
  scope: Scope,
  result: IssueWriteResult,
  guardRefused: () => boolean,
  confirm: (observed: IssueWriteObservation) => void,
): Promise<FramingEffectOutcome> {
  if (result.status === 'written') {
    confirm(result.observed)
    return afterReadback(ctx, step, scope)
  }
  const diagnostics = writeDiagnostics(ctx, scope, result.diagnostics)
  if (result.status === 'refused') return outcome('failed-before-effect', scope, diagnostics)
  if (result.completed.length > 0) return outcome('applied-readback-unconfirmed', scope, diagnostics)
  return outcome(guardRefused() ? 'failed-before-effect' : 'outcome-unknown', scope, diagnostics)
}

/** An unknown create keeps a null Scope; only a trusted partial create names its issue. */
async function createOutcome(
  ctx: RunContext,
  step: StepOf<'create'>,
  run: FramingMemberRun,
  repository: string,
  result: Awaited<ReturnType<IssueWriter['create']>>,
  guardRefused: () => boolean,
): Promise<FramingEffectOutcome> {
  if (result.status === 'written') {
    const scope = ctx.ports.scopeOf(result.observed.issue)
    run.scope = scope
    run.native = result.observed
    run.records = []
    run.head = null
    return afterReadback(ctx, step, scope)
  }
  const diagnostics = writeDiagnostics(ctx, null, result.diagnostics)
  if (result.status === 'refused') return outcome('failed-before-effect', null, diagnostics)
  if (result.status === 'uncertain')
    return outcome(guardRefused() ? 'failed-before-effect' : 'outcome-unknown', null, diagnostics)
  const issue = result.issue
  const trusted =
    result.completed.includes('create') &&
    issue.repository === repository &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0
  if (!trusted) return outcome('outcome-unknown', null, diagnostics)
  run.scope = ctx.ports.scopeOf(issue)
  return outcome('applied-readback-unconfirmed', run.scope, writeDiagnostics(ctx, run.scope, result.diagnostics))
}

export async function createEffect(
  ctx: RunContext,
  step: StepOf<'create'>,
  progress: Progress,
): Promise<FramingEffectOutcome> {
  const run = member(ctx, step.member)
  const slot = run.planned.slot
  if (slot.kind !== 'new')
    return outcome('failed-before-effect', run.scope, [
      located(ctx, run.scope, 'framing-plan-invalid', 'Only a new slot is created'),
    ])
  const checked = await recheck(ctx, step.member === ctx.rootKey ? [] : [ctx.rootKey])
  if (!checked.ok) return outcome('failed-before-effect', null, checked.diagnostics)
  const { writer, guardRefused } = writerFor(ctx, step)
  progress.attempted = true
  const result = await writer.create({
    repository: slot.repository,
    title: run.input.title,
    body: run.planned.renderedBody,
    labels: { add: [], remove: [] },
    relations: emptyRelations(),
  })
  return createOutcome(ctx, step, run, slot.repository, result, guardRefused)
}
export async function metadataEffect(
  ctx: RunContext,
  step: StepOf<'patch' | 'labels'>,
  progress: Progress,
): Promise<FramingEffectOutcome> {
  const run = member(ctx, step.member)
  const checked = await recheck(ctx, [run.planned.key])
  if (!checked.ok) return outcome('failed-before-effect', run.scope, checked.diagnostics)
  const current = nativeOf(readOf(checked.reads, run.planned.key))
  const scope = scoped(run)
  const plan: NativeIssueWritePlan =
    step.kind === 'patch'
      ? {
          repository: scope.repository,
          title: run.input.title,
          body: run.planned.renderedBody,
          labels: { add: [], remove: [] },
          relations: emptyRelations(),
        }
      : {
          repository: scope.repository,
          body: current.body,
          labels: { add: step.add, remove: step.remove },
          relations: emptyRelations(),
        }
  const { writer, guardRefused } = writerFor(ctx, step)
  progress.attempted = true
  const result = await writer.update(refOf(scope), plan, current)
  return writerOutcome(ctx, step, scope, result, guardRefused, (observed) => {
    run.native = observed
  })
}

async function parentEngagement(ctx: RunContext, parent: IssueRef, scope: Scope): Promise<FramingEffectOutcome | null> {
  try {
    await ctx.ports.guardParent(parent)
    return null
  } catch (error) {
    return outcome('failed-before-effect', scope, [nativeDiagnostic(scope, 'framing-parent-engaged', message(error))])
  }
}

export async function edgeEffect(
  ctx: RunContext,
  step: StepOf<'parent-child' | 'blocker'>,
  progress: Progress,
): Promise<FramingEffectOutcome> {
  const from = member(ctx, step.member)
  const to = member(ctx, step.kind === 'parent-child' ? step.child : step.blocker)
  const checked = await recheck(ctx, [from.planned.key, to.planned.key])
  if (!checked.ok) return outcome('failed-before-effect', from.scope, checked.diagnostics)
  const current = nativeOf(readOf(checked.reads, from.planned.key))
  const scope = scoped(from)
  const target = refOf(scoped(to))
  const source = refOf(scope)
  const engaged = step.kind === 'parent-child' ? await parentEngagement(ctx, source, scope) : null
  if (engaged !== null) return engaged
  const relations =
    step.kind === 'parent-child'
      ? { ...emptyRelations(), addChildren: [target] }
      : { ...emptyRelations(), addBlockers: [target] }
  const plan: NativeIssueWritePlan = {
    repository: scope.repository,
    body: current.body,
    labels: { add: [], remove: [] },
    relations,
  }
  const { writer, guardRefused } = writerFor(ctx, step)
  progress.attempted = true
  const result = await writer.update(source, plan, current)
  return writerOutcome(ctx, step, scope, result, guardRefused, (observed) => {
    from.native = observed
    if (step.kind === 'parent-child' && to.native !== null) to.native = { ...to.native, parent: source }
  })
}
