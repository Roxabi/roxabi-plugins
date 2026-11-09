import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingProposal } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { FramingEffectGuard, FramingOperationResult, PreparedFramingProposal } from './uw-framing-contract.ts'
import { verifySealedCut } from './uw-framing-executor-check.ts'
import {
  createFramingJournal,
  type FramingEffectOutcome,
  type FramingMemberFacts,
  type FramingStep,
  settleFraming,
} from './uw-framing-executor-journal.ts'
import { createEffect, edgeEffect, metadataEffect } from './uw-framing-native-effects.ts'
import { planFraming } from './uw-framing-plan.ts'
import type { FramingExecutorPorts, FramingPublicationPorts } from './uw-framing-ports.ts'
import { reservePreparedFramingProposal } from './uw-framing-prepare.ts'
import { bindingEffect, claimEffect, identityEffect, intentEffect } from './uw-framing-publication-effects.ts'
import { resultEffect } from './uw-framing-result-effect.ts'
import {
  located,
  message,
  outcome,
  type Progress,
  type RunContext,
  repositoryDiagnostic,
} from './uw-framing-run-context.ts'

function repositoryOf(proposal: FramingProposal): string {
  return proposal.target.kind === 'existing' ? proposal.target.uw.repository : proposal.target.repository
}
function refused(diagnostics: readonly UwDiagnostic[]): Extract<FramingOperationResult, { status: 'refused' }> {
  return Object.freeze({
    status: 'refused' as const,
    effects: Object.freeze([]) as readonly [],
    diagnostics: Object.freeze([...diagnostics]),
  })
}
function dispatch(ctx: RunContext, step: FramingStep, progress: Progress): Promise<FramingEffectOutcome> {
  switch (step.kind) {
    case 'create':
      return createEffect(ctx, step, progress)
    case 'publish-intent':
      return intentEffect(ctx, step, progress)
    case 'publish-binding':
      return bindingEffect(ctx, step, progress)
    case 'publish-claim':
      return claimEffect(ctx, step, progress)
    case 'publish-identity':
      return identityEffect(ctx, step, progress)
    case 'patch':
    case 'labels':
      return metadataEffect(ctx, step, progress)
    case 'parent-child':
    case 'blocker':
      return edgeEffect(ctx, step, progress)
    case 'publish-result':
      return resultEffect(ctx, step, progress)
  }
}

async function perform(ctx: RunContext, step: FramingStep): Promise<FramingEffectOutcome> {
  const progress: Progress = { attempted: false }
  try {
    return await dispatch(ctx, step, progress)
  } catch (error) {
    const scope = ctx.state.members.get(step.member ?? ctx.rootKey)?.scope ?? null
    return outcome(progress.attempted ? 'outcome-unknown' : 'failed-before-effect', scope, [
      located(ctx, scope, 'framing-effect-error', message(error)),
    ])
  }
}

function memberFacts(ctx: RunContext): ReadonlyMap<FramingMemberKey, FramingMemberFacts> {
  return new Map(
    ctx.proposal.members.map((planned): [FramingMemberKey, FramingMemberFacts] => {
      const run = ctx.state.members.get(planned.key)
      return [
        planned.key,
        {
          scope: run?.scope ?? null,
          intent: planned.key === ctx.rootKey && ctx.state.intent !== null,
          bound: (run?.binding ?? null) !== null,
          claimed: (run?.claim ?? null) !== null,
        },
      ]
    }),
  )
}

/** One confirmed aggregate run: exactly one plan, one journal, and no retry, rollback, or alternate home. */
function createFramingRun(
  prepared: PreparedFramingProposal,
  guard: FramingEffectGuard,
  ports: FramingExecutorPorts,
  publication: FramingPublicationPorts,
) {
  const { proposal, digest } = prepared
  const opId = proposal.operationId
  const rootKey = proposal.input.root
  const repository = repositoryOf(proposal)
  let active: { ctx: RunContext; journal: ReturnType<typeof createFramingJournal> } | null = null

  const settle = (diagnostics: readonly UwDiagnostic[]): FramingOperationResult => {
    if (active === null) return refused(diagnostics)
    return settleFraming({
      effects: active.journal.effects(),
      rootKey,
      root: active.ctx.state.members.get(rootKey)?.scope ?? null,
      members: memberFacts(active.ctx),
      diagnostics,
    })
  }

  return {
    settle,
    /** The single confirmed action: post-UI recheck, then the planned effects until the first non-confirmed one. */
    async run(evidence: OperatorConfirmationEvidence): Promise<FramingOperationResult> {
      if (evidence.operationId !== opId || evidence.proposalDigest !== digest)
        return refused([
          repositoryDiagnostic(
            repository,
            'operator-confirmation-mismatch',
            'Confirmation evidence does not bind this exact aggregate',
          ),
        ])
      try {
        await guard.check({
          operationId: opId,
          proposalDigest: digest,
          member: null,
          effectId: `${opId}:confirmation`,
          at: 'confirmation',
        })
      } catch (error) {
        return refused([repositoryDiagnostic(repository, 'framing-guard-refused', message(error))])
      }
      const verified = await verifySealedCut(proposal, ports.read)
      if (!verified.ok) return refused(verified.diagnostics)
      const plan = planFraming(proposal, verified.value)
      const ctx: RunContext = {
        proposal,
        digest,
        opId,
        rootKey,
        repository,
        guard,
        ports,
        publication,
        state: { proposal, members: plan.members, intent: null },
        evidence,
        written: null,
      }
      const journal = createFramingJournal(plan.steps)
      active = { ctx, journal }
      for (const [index, step] of plan.steps.entries()) {
        const result = await perform(ctx, step)
        journal.record(index, result)
        if (result.status !== 'confirmed') return settle(result.diagnostics)
      }
      if (ctx.written === null)
        return settle([
          repositoryDiagnostic(repository, 'framing-result-unconfirmed', 'The aggregate result was not confirmed'),
        ])
      return Object.freeze({ status: 'written' as const, value: ctx.written, effects: journal.effects() })
    },
  }
}

/**
 * Frame one prepared aggregate. Reserve its exact seal synchronously before any
 * await; only a no-action defer restores it. The operator confirms the original
 * aggregate once; every effect has fresh checks, and partial or uncertain effects
 * stop the run with holds.
 */
export async function executeFraming(
  prepared: PreparedFramingProposal,
  guard: FramingEffectGuard,
  ports: FramingExecutorPorts,
): Promise<FramingOperationResult> {
  const settleReservation = reservePreparedFramingProposal(prepared)
  const repository = repositoryOf(prepared.proposal)
  if (settleReservation === null)
    return refused([
      repositoryDiagnostic(
        repository,
        'framing-proposal-unsealed',
        'Only a fresh prepared aggregate can be framed, exactly once',
      ),
    ])
  let deferred = false
  try {
    const result = await executeReservedFraming(prepared, guard, ports)
    deferred = result.status === 'deferred'
    return result
  } finally {
    settleReservation(deferred)
  }
}

async function executeReservedFraming(
  prepared: PreparedFramingProposal,
  guard: FramingEffectGuard,
  ports: FramingExecutorPorts,
): Promise<FramingOperationResult> {
  const repository = repositoryOf(prepared.proposal)
  const publication = ports.framingPublication
  if (publication === undefined)
    return refused([
      repositoryDiagnostic(
        repository,
        'framing-publication-unavailable',
        'The installed framing publisher is not composed',
      ),
    ])
  const { proposal, digest } = prepared
  try {
    await guard.check({
      operationId: proposal.operationId,
      proposalDigest: digest,
      member: null,
      effectId: `${proposal.operationId}:confirmation`,
      at: 'confirmation',
    })
  } catch (error) {
    return refused([repositoryDiagnostic(repository, 'framing-guard-refused', message(error))])
  }
  const before = await verifySealedCut(proposal, ports.read)
  if (!before.ok) return refused(before.diagnostics)
  const run = createFramingRun(prepared, guard, ports, publication)
  let started = false
  try {
    const confirmed = await ports.operator.executeConfirmed(prepared, (evidence) => {
      started = true
      return run.run(evidence)
    })
    if (confirmed.status === 'confirmed') return confirmed.value
    if (confirmed.status === 'deferred' && !started) {
      await guard.check({
        operationId: proposal.operationId,
        proposalDigest: digest,
        member: null,
        effectId: `${proposal.operationId}:confirmation`,
        at: 'confirmation',
      })
      return { status: 'deferred', effects: [], diagnostics: confirmed.diagnostics }
    }
    return started ? run.settle(confirmed.diagnostics) : refused(confirmed.diagnostics)
  } catch (error) {
    const diagnostic = repositoryDiagnostic(repository, 'framing-executor-interrupted', message(error))
    return started ? run.settle([diagnostic]) : refused([diagnostic])
  }
}
