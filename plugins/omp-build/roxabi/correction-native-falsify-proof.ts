import { realpathSync } from 'node:fs'

import type { ActionResult, Json } from '../dist/contracts.js'
import type { NativeChildResult } from '../omp/review-runtime/contracts.js'
import {
  type AppliedCauseContext,
  actionOutput,
  actionTask,
  citedStageRecords,
  failed,
  indexContext,
  type ObservedProof,
  observedProof,
  registeredCorrectionTask,
  taskName,
} from './correction-action'
import type { CorrectionEffectResult } from './correction-execution-contract'
import type { CorrectionNativeRuntime } from './correction-native-runtime'
import type { CorrectionCause } from './fix-domain'
import { nativeFixProfileByAction } from './native-review-profiles'

export type FalsificationGuard = AppliedCauseContext['guards'][number]
export type FalsificationFact = {
  guardId: string
  intendedScenario: string
  removed: boolean
  proofFailed: boolean
  proofToolCallId: string | null
  proofUnavailableReason: string | null
}

type PerturbedGuard = {
  batch: Json
  child: NativeChildResult
  contributionIds: readonly string[]
  fact: FalsificationFact
  output: ActionResult
  skippedReason: string | null
}

type RestoredProof = {
  batch: Json
  child: NativeChildResult
  contributionIds: readonly string[]
  output: ActionResult
  proof: ObservedProof | null
}

export async function perturbGuard(
  runtime: CorrectionNativeRuntime,
  cause: CorrectionCause,
  applied: AppliedCauseContext,
  guard: FalsificationGuard,
  expectedHead: string,
): Promise<CorrectionEffectResult<PerturbedGuard>> {
  const state = await runtime.git.expectedCleanHead()
  if (!state.ok) return state
  if (state.value.head !== expectedHead) return failed('terminal', 'falsification-commit-binding-invalid')
  const stageRecords = citedStageRecords(runtime.records, [
    runtime.options.decision.recordId,
    ...applied.contributionIds,
  ])
  if (stageRecords === null) return failed('terminal', 'correction-context-unmanifested')
  const draft = actionTask(
    taskName('falsify', cause.id, `-${guard.guardId}`),
    nativeFixProfileByAction.falsify,
    `For correction cause ${cause.id}, falsify only confirmed production guard ${guard.guardId} named by the index in ${runtime.options.prepared.cwd}. Make one surgical declared-path perturbation, assess the actual observed failure scenario, surgically restore before yielding, and do not commit or push. Return exactly one fact for guard ${guard.guardId}.`,
    `one production-guard falsification for ${cause.id}:${guard.guardId}`,
    { purpose: 'fix-falsify', causeId: cause.id, occurrence: 'perturbed' },
  )
  const registered = await registeredCorrectionTask(
    runtime.options.operations,
    runtime.options.prepared.target,
    state.value.head,
    draft,
    stageRecords,
    runtime.options.prepared.subject,
    runtime,
  )
  if (!registered.ok) return registered
  const perturbed = await runtime.dispatch({
    phase: 'falsify',
    causeId: cause.id,
    task: registered.value,
    contextRefs: stageRecords.map((record) => record.recordId),
    context: indexContext(stageRecords.map((record) => record.recordId)),
  })
  if (!perturbed.ok) return perturbed
  const interpreted = actionOutput(perturbed.value)
  if (!interpreted.ok) return interpreted
  const { output, child } = interpreted.value
  if (!('facts' in output) || output.facts.length !== 1) return failed('terminal', 'falsification-guard-fact-invalid')
  const fact = output.facts[0]
  if (fact === undefined || fact.guardId !== guard.guardId || fact.intendedScenario !== guard.intendedScenario)
    return failed('terminal', 'falsification-guard-fact-invalid')
  const clean = await runtime.git.expectedCleanHead()
  if (!clean.ok || clean.value.head !== expectedHead) return failed('terminal', 'native-falsifier-restoration-unproven')
  return {
    ok: true,
    value: {
      batch: perturbed.value.native.raw,
      child,
      contributionIds: perturbed.value.contributionIds,
      fact,
      output,
      skippedReason: output.skippedReason,
    },
  }
}

export async function restoreFalsificationProof(
  runtime: CorrectionNativeRuntime,
  cause: CorrectionCause,
  applied: AppliedCauseContext,
  guard: FalsificationGuard,
  perturbationContributionIds: readonly string[],
  expectedHead: string,
): Promise<CorrectionEffectResult<RestoredProof>> {
  const state = await runtime.git.expectedCleanHead()
  if (!state.ok) return state
  if (state.value.head !== expectedHead) return failed('terminal', 'falsification-commit-binding-invalid')
  const stageRecords = citedStageRecords(runtime.records, [
    runtime.options.decision.recordId,
    ...applied.contributionIds,
    ...perturbationContributionIds,
  ])
  if (stageRecords === null) return failed('terminal', 'correction-context-unmanifested')
  const draft = actionTask(
    taskName('restore-proof', cause.id, `-${guard.guardId}`),
    nativeFixProfileByAction.apply,
    `After native surgical restoration of production guard ${guard.guardId} for correction cause ${cause.id}, run only the same semantic repository-native proof named by the index in ${runtime.options.prepared.cwd}. Do not edit, commit, push, or alter files. Return outcome applied with no commits, empty proofPaths, and an empty guard inventory.`,
    `restored proof for ${cause.id}:${guard.guardId}`,
    { purpose: 'fix-revalidate', causeId: cause.id, occurrence: 'restored' },
  )
  const registered = await registeredCorrectionTask(
    runtime.options.operations,
    runtime.options.prepared.target,
    state.value.head,
    draft,
    stageRecords,
    runtime.options.prepared.subject,
    runtime,
  )
  if (!registered.ok) return registered
  const restored = await runtime.dispatch({
    phase: 'restore-proof',
    causeId: cause.id,
    task: registered.value,
    contextRefs: stageRecords.map((record) => record.recordId),
    context: indexContext(stageRecords.map((record) => record.recordId)),
  })
  if (!restored.ok) return restored
  const interpreted = actionOutput(restored.value)
  if (!interpreted.ok) return interpreted
  const { output, child } = interpreted.value
  if (
    !('outcome' in output) ||
    output.outcome !== 'applied' ||
    output.commitSHAs.length !== 0 ||
    output.guardInventory.length !== 0
  )
    return failed('terminal', 'falsification-restored-proof-invalid')
  const proof = observedProof(
    child,
    { purpose: 'fix-revalidate', causeId: cause.id, occurrence: 'restored', guardId: null },
    output.proofToolCallId,
    output.proofUnavailableReason,
    runtime.options.prepared.cwd,
    realpathSync,
  )
  if (!proof.ok) return proof
  const clean = await runtime.git.expectedCleanHead()
  if (!clean.ok || clean.value.head !== expectedHead)
    return failed('terminal', 'falsification-restored-proof-state-changed')
  if (proof.value !== null && proof.value.exitCode === 0) {
    runtime.options.onCriterionSource?.({
      phase: 'restore-proof',
      causeId: cause.id,
      head: expectedHead,
      contributionIds: restored.value.contributionIds,
      child,
    })
  }
  return {
    ok: true,
    value: {
      batch: restored.value.native.raw,
      child,
      contributionIds: restored.value.contributionIds,
      output,
      proof: proof.value,
    },
  }
}
