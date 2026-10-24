import { realpathSync } from 'node:fs'

import type { ActionResult, Json } from '../dist/contracts.js'
import type { NativeChildResult } from '../omp/review-runtime/contracts.js'
import {
  type AppliedCauseContext,
  actionOutput,
  actionTask,
  causePaths,
  correctionActionContext,
  failed,
  type ObservedProof,
  observedProof,
  taskName,
} from './correction-action'
import type { CorrectionEffectResult, CorrectionFalsificationResult } from './correction-execution-contract'
import type { CorrectionNativeRuntime } from './correction-native-runtime'
import type { CorrectionCause } from './fix-domain'
import { nativeFixProfileByAction } from './native-review-profiles'

type FalsificationGuard = AppliedCauseContext['guards'][number]
type FalsificationFact = {
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

type FalsificationProgress = {
  facts: CorrectionFalsificationResult['facts']
  raw: Json[]
  contributionIds: string[]
  skippedReason: string | undefined
}

async function perturbGuard(
  runtime: CorrectionNativeRuntime,
  cause: CorrectionCause,
  applied: AppliedCauseContext,
  guard: FalsificationGuard,
  expectedHead: string,
): Promise<CorrectionEffectResult<PerturbedGuard>> {
  const task = actionTask(
    taskName('falsify', cause.id, `-${guard.guardId}`),
    nativeFixProfileByAction.falsify,
    `For correction cause ${cause.id}, falsify only confirmed production guard ${JSON.stringify(guard)} in ${runtime.options.prepared.cwd}. Original approved cause JSON: ${applied.causeJSON}. Use the same semantic proof identity as actual selected apply proof ${JSON.stringify(applied.proof)}; declared apply proofPaths: ${JSON.stringify(applied.proofPaths)}. Make one surgical declared-path perturbation, assess the actual observed failure scenario, surgically restore before yielding, and do not commit or push. Return exactly one fact for guard ${guard.guardId}.`,
    `one production-guard falsification for ${cause.id}:${guard.guardId}`,
    { purpose: 'fix-falsify', causeId: cause.id, occurrence: 'perturbed' },
  )
  const perturbed = await runtime.dispatch({
    phase: 'falsify',
    causeId: cause.id,
    task,
    contextRefs: [runtime.options.decisionId, ...applied.contributionIds],
    context: correctionActionContext(applied.causeJSON, applied.proofPaths, applied.proof),
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

async function restoreFalsificationProof(
  runtime: CorrectionNativeRuntime,
  cause: CorrectionCause,
  applied: AppliedCauseContext,
  guard: FalsificationGuard,
  perturbationContributionIds: readonly string[],
  expectedHead: string,
): Promise<CorrectionEffectResult<RestoredProof>> {
  const task = actionTask(
    taskName('restore-proof', cause.id, `-${guard.guardId}`),
    nativeFixProfileByAction.apply,
    `After native surgical restoration of production guard ${guard.guardId} for correction cause ${cause.id}, run only the same semantic repository-native proof in ${runtime.options.prepared.cwd}. Original approved cause JSON: ${applied.causeJSON}. The selected apply proof was ${JSON.stringify(applied.proof)} with declared proofPaths ${JSON.stringify(applied.proofPaths)}. Do not edit, commit, push, or alter files. Return outcome applied with no commits, empty proofPaths, and an empty guard inventory.`,
    `restored proof for ${cause.id}:${guard.guardId}`,
    { purpose: 'fix-revalidate', causeId: cause.id, occurrence: 'restored' },
  )
  const restored = await runtime.dispatch({
    phase: 'restore-proof',
    causeId: cause.id,
    task,
    contextRefs: [runtime.options.decisionId, ...applied.contributionIds, ...perturbationContributionIds],
    context: correctionActionContext(applied.causeJSON, applied.proofPaths, applied.proof),
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

function falsificationFact(
  guard: FalsificationGuard,
  fact: FalsificationFact,
  proof: ObservedProof,
  restoredProof: ObservedProof,
): CorrectionFalsificationResult['facts'][number] | null {
  const detail = `perturbedExit=${proof.exitCode}; restoredExit=${restoredProof.exitCode}`
  if (fact.proofFailed && proof.exitCode !== 0)
    return {
      guardId: guard.guardId,
      guard: guard.productionGuard,
      intendedScenario: guard.intendedScenario,
      removedProductionGuard: true,
      proofFailedIntendedScenario: true,
      proofToolCallId: proof.toolCallId,
      proofUnavailableReason: null,
      detail,
    }
  if (!fact.proofFailed && proof.exitCode === 0)
    return {
      guardId: guard.guardId,
      guard: guard.productionGuard,
      intendedScenario: guard.intendedScenario,
      removedProductionGuard: true,
      proofFailedIntendedScenario: false,
      proofToolCallId: proof.toolCallId,
      proofUnavailableReason: null,
      detail,
    }
  return null
}

async function falsifyGuard(
  runtime: CorrectionNativeRuntime,
  cause: CorrectionCause,
  applied: AppliedCauseContext,
  guard: FalsificationGuard,
  expectedHead: string,
  progress: FalsificationProgress,
): Promise<CorrectionEffectResult<void>> {
  const perturbed = await perturbGuard(runtime, cause, applied, guard, expectedHead)
  if (!perturbed.ok) return perturbed
  progress.contributionIds.push(...perturbed.value.contributionIds)
  progress.raw.push({
    causeId: cause.id,
    guardId: guard.guardId,
    guard,
    contributionIds: [...perturbed.value.contributionIds],
    batch: perturbed.value.batch,
    output: perturbed.value.output,
    proofEvidence: perturbed.value.child.proofEvidence,
  })
  const { fact, child } = perturbed.value
  if (perturbed.value.skippedReason !== null || !fact.removed) {
    progress.skippedReason ??= perturbed.value.skippedReason ?? 'no production guard identified'
    return { ok: true, value: undefined }
  }
  const proof = observedProof(
    child,
    { purpose: 'fix-falsify', causeId: cause.id, occurrence: 'perturbed', guardId: guard.guardId },
    fact.proofToolCallId,
    fact.proofUnavailableReason,
    runtime.options.prepared.cwd,
    realpathSync,
  )
  if (!proof.ok) return proof
  if (proof.value === null) {
    progress.skippedReason ??= fact.proofUnavailableReason ?? 'falsification-proof-unavailable'
    return { ok: true, value: undefined }
  }
  const restored = await restoreFalsificationProof(
    runtime,
    cause,
    applied,
    guard,
    perturbed.value.contributionIds,
    expectedHead,
  )
  if (!restored.ok) return restored
  progress.contributionIds.push(...restored.value.contributionIds)
  progress.raw.push({
    causeId: cause.id,
    guardId: guard.guardId,
    restoredContributionIds: [...restored.value.contributionIds],
    restored: restored.value.batch,
    restoredOutput: restored.value.output,
    proofEvidence: restored.value.child.proofEvidence,
    restoredProof: restored.value.proof,
  })
  if (restored.value.proof === null || restored.value.proof.exitCode !== 0) {
    progress.skippedReason ??= 'falsification-restored-proof-inconclusive'
    return { ok: true, value: undefined }
  }
  const observed = falsificationFact(guard, fact, proof.value, restored.value.proof)
  if (observed === null) progress.skippedReason ??= 'falsification-semantic-evidence-conflict'
  else progress.facts.push(observed)
  return { ok: true, value: undefined }
}

export async function falsifyCorrectionAction(
  runtime: CorrectionNativeRuntime,
  cause: CorrectionCause,
  commitSHAs: readonly string[],
): Promise<CorrectionEffectResult<CorrectionFalsificationResult>> {
  const paths = causePaths(cause.paths)
  if (paths === null) return failed('terminal', 'falsification-paths-invalid')
  const state = await runtime.git.expectedCleanHead()
  if (!state.ok) return state
  if (commitSHAs.length !== 1 || commitSHAs[0] !== state.value.head || !runtime.ownedCommits.includes(state.value.head))
    return failed('terminal', 'falsification-commit-binding-invalid')
  const applied = runtime.appliedByCause.get(cause.id)
  if (applied === undefined) return failed('terminal', 'falsification-guard-inventory-missing')
  if (applied.proof === null)
    return {
      ok: true,
      value: {
        facts: [],
        contributionIds: [],
        skippedReason: applied.proofUnavailableReason ?? 'apply-proof-unavailable',
        raw: { causeId: cause.id, selectedApplyProof: null, proofUnavailableReason: applied.proofUnavailableReason },
      },
    }
  if (applied.guards.length === 0)
    return {
      ok: true,
      value: { facts: [], contributionIds: [], skippedReason: 'no production guard identified', raw: { guards: [] } },
    }
  const progress: FalsificationProgress = { facts: [], raw: [], contributionIds: [], skippedReason: undefined }
  for (const guard of applied.guards) {
    const falsified = await falsifyGuard(runtime, cause, applied, guard, state.value.head, progress)
    if (!falsified.ok) return falsified
  }
  return {
    ok: true,
    value: {
      facts: progress.facts,
      raw: progress.raw,
      contributionIds: progress.contributionIds,
      ...(progress.skippedReason === undefined ? {} : { skippedReason: progress.skippedReason }),
    },
  }
}
