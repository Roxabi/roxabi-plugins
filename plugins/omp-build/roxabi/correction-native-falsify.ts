import { realpathSync } from 'node:fs'

import type { Json } from '../dist/contracts.js'
import { type AppliedCauseContext, causePaths, failed, type ObservedProof, observedProof } from './correction-action'
import type { CorrectionEffectResult, CorrectionFalsificationResult } from './correction-execution-contract'
import {
  type FalsificationFact,
  type FalsificationGuard,
  perturbGuard,
  restoreFalsificationProof,
} from './correction-native-falsify-proof'
import type { CorrectionNativeRuntime } from './correction-native-runtime'
import type { CorrectionCause } from './fix-domain'

type FalsificationProgress = {
  facts: CorrectionFalsificationResult['facts']
  raw: Json[]
  contributionIds: string[]
  skippedReason: string | undefined
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
