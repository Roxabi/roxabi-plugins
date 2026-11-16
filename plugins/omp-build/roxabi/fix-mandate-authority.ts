import type {
  AcceptedOwnSpec,
  DecodedHistory,
  GitHubOptions,
  Json,
  MandatePayload,
  Scope,
  ScopedRecordRef,
} from '../dist/contracts.js'
import { effectiveMandateRole, projectRecoveryHistories, shippedProductVersion } from '../dist/contracts.js'
import { linkedIssueBinding } from './fix-checkpoint-binding.ts'
import { reconstructFixCheckpoint } from './fix-checkpoint-state.ts'
import type { FixActionResult, FixRecord, FixTarget } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import { type FixOnlyMandateDraft, resolveCorrectionMandate } from './fix-mandate-resolution.ts'
import {
  type CorrectionExecutionRights,
  completeRecord,
  type FixMandateView,
  mandateView,
} from './fix-mandate-types.ts'
import { extendObservedUwCausalContext } from './fix-uw-histories.ts'
import type { UwReadPort } from './uw-contract.ts'
import { readEffectiveFixConfig } from './workflow-config.ts'

export type FixAuthorityDecision = {
  status: 'reuse'
  mandate: FixMandateView
  execution: CorrectionExecutionRights
  sameScope: boolean
  uw: Scope
}
export function matchesRequiredFeatureMandate(
  required: ScopedRecordRef & { kind: 'mandate' },
  mandate: FixMandateView,
  acceptedSpec: AcceptedOwnSpec,
): boolean {
  return (
    required.kind === 'mandate' &&
    effectiveMandateRole(mandate.role, acceptedSpec) === 'feature' &&
    required.recordId === mandate.recordId &&
    required.scope.repository === mandate.repository &&
    required.scope.target === mandate.target &&
    acceptedSpec.ref.uw.repository === mandate.repository &&
    acceptedSpec.ref.uw.target === mandate.target
  )
}

function checkFixCheckpoint(
  history: DecodedHistory,
  trustedLiveRequest: Extract<FixRecord, { kind: 'fix-request' }> | undefined,
  histories: readonly DecodedHistory[],
): FixActionResult<void> {
  const all = [
    history,
    ...histories.filter(
      (item) =>
        item.source.scope.repository !== history.source.scope.repository ||
        item.source.scope.target !== history.source.scope.target,
    ),
  ]
  const projected = projectRecoveryHistories(all)
  if (!projected.ok) return failure(...recoveryDiagnosticStrings(projected.diagnostics))
  const [current, ...external] = projected.value
  if (current === undefined) return failure('fix-history-incomplete')
  const checkpoint = reconstructFixCheckpoint(current, trustedLiveRequest, external)
  if (checkpoint.status === 'blocked') return failure(...checkpoint.diagnostics)
  return { ok: true, value: undefined }
}

function decideSelectedAuthority(
  selected: {
    status: 'applicable'
    mandate: FixMandateView
    execution: CorrectionExecutionRights
    acceptedSpec: AcceptedOwnSpec
  },
  input: {
    target: FixTarget
    requiredFeatureMandate?: ScopedRecordRef & { kind: 'mandate' }
  },
): FixActionResult<FixAuthorityDecision> {
  if (selected.execution.landing !== false) return failure('fix-mandate-execution-denied')
  const mandate = selected.mandate
  if (
    input.requiredFeatureMandate !== undefined &&
    !matchesRequiredFeatureMandate(input.requiredFeatureMandate, mandate, selected.acceptedSpec)
  ) {
    return failure('feature-mandate-required')
  }
  return {
    ok: true,
    value: {
      status: 'reuse',
      mandate,
      execution: selected.execution,
      sameScope: mandate.repository === input.target.repository && mandate.target === input.target.target,
      uw: selected.acceptedSpec.ref.uw,
    },
  }
}

export async function decideFixAuthority(input: {
  target: FixTarget
  options: GitHubOptions
  readHistory: () => Promise<DecodedHistory>
  branch: string | null
  base: string | null
  uw: UwReadPort
  requiredFeatureMandate?: ScopedRecordRef & { kind: 'mandate' }
  trustedLiveRequest?: Extract<FixRecord, { kind: 'fix-request' }>
}): Promise<FixActionResult<FixAuthorityDecision>> {
  const history = await input.readHistory()
  if (!history.source.complete) return failure('fix-history-incomplete')
  const linked = await linkedIssueBinding(input.target, input.options, input.uw)
  if (!linked.ok) return linked
  const selectedHistories = [
    history,
    ...(linked.value.history === null ? [] : [linked.value.history]),
    ...linked.value.externalHistories,
  ]
  if (linked.value.currentSpec === null) return failure('fix-own-uw-required')
  const causal = await extendObservedUwCausalContext(linked.value.currentSpec.causal, selectedHistories, input.options)
  if (!causal.ok) return causal
  // The merge proved native source equality. Use the exact causal representations for
  // Core's identity/coherence checks, rather than mixing raw and effective operations.
  const inCausal = (item: DecodedHistory) =>
    causal.value.histories.find(
      (candidate) =>
        candidate.source.scope.repository === item.source.scope.repository &&
        candidate.source.scope.target === item.source.scope.target,
    )
  const effectiveHistory = inCausal(history)
  const effectiveLinked = linked.value.history === null ? null : inCausal(linked.value.history)
  const effectiveExternal = linked.value.externalHistories.map(inCausal)
  if (
    effectiveHistory === undefined ||
    effectiveLinked === undefined ||
    effectiveExternal.some((item) => item === undefined)
  )
    return failure('fix-own-uw-unsettled', 'fix-history-observation-drift')
  const checkpoint = checkFixCheckpoint(effectiveHistory, input.trustedLiveRequest, causal.value.histories)
  if (!checkpoint.ok) return checkpoint
  const selected = await resolveCorrectionMandate({
    target: input.target,
    history: effectiveHistory,
    linkedIssueHistory: effectiveLinked,
    externalHistories: effectiveExternal.filter((item): item is DecodedHistory => item !== undefined),
    causal: causal.value,
    branch: linked.value.branch ?? input.branch,
    base: linked.value.base ?? input.base,
    currentSpec: linked.value.currentSpec,
  })
  if (!selected.ok) return selected
  return decideSelectedAuthority(selected.value, input)
}

export async function confirmFixContinuation(input: {
  target: FixTarget
  options: GitHubOptions
  readHistory: () => Promise<DecodedHistory>
  branch: string | null
  base: string | null
  uw: UwReadPort
  boundRecordId: string
  requiredFeatureMandate?: ScopedRecordRef & { kind: 'mandate' }
  trustedLiveRequest?: Extract<FixRecord, { kind: 'fix-request' }>
}): Promise<FixActionResult<void>> {
  const again = await decideFixAuthority(input)
  if (!again.ok) return again
  if (again.value.mandate.recordId !== input.boundRecordId) {
    return failure('fix-mandate-changed')
  }
  if (again.value.execution.landing !== false) return failure('fix-mandate-execution-denied')
  return { ok: true, value: undefined }
}

export async function loadFixOnlyDraft(input: {
  cwd: string
  commit: string
  git: (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  scope: Scope
  recordId: string
  runId: string
  operationId: string
  branch: string | null
  base: string
  candidateGitSHA: string | null
  ownSpec: Extract<MandatePayload, { role: 'fix-only' }>['ownSpec']
  tier: Extract<MandatePayload, { role: 'fix-only' }>['tier']
  children: Extract<MandatePayload, { role: 'fix-only' }>['children']
  inheritedOwnSpecRefs: MandatePayload['inheritedOwnSpecRefs']
  coverage: MandatePayload['coverage']
  parent: FixMandateView['parent']
  antecedent: FixMandateView['antecedent']
}): Promise<FixActionResult<FixOnlyMandateDraft>> {
  let productVersion: string
  try {
    productVersion = shippedProductVersion()
  } catch {
    return failure('fix-product-version-unreadable')
  }
  if (!/^[0-9a-f]{40}$/.test(input.commit)) {
    return failure('fix-config-unreadable')
  }
  const config = await readEffectiveFixConfig({ cwd: input.cwd, commit: input.commit, git: input.git })
  if (!config.ok) return failure(`fix-config-${config.reason}`, ...config.diagnostics.map((item) => item.code))
  return {
    ok: true,
    value: {
      scope: input.scope,
      recordId: input.recordId,
      runId: input.runId,
      operationId: input.operationId,
      branch: input.branch,
      base: input.base,
      candidateGitSHA: input.candidateGitSHA,
      productVersion,
      ownSpec: input.ownSpec,
      tier: input.tier,
      children: input.children,
      inheritedOwnSpecRefs: input.inheritedOwnSpecRefs,
      coverage: input.coverage,
      config: { version: config.version, digest: config.digest, effective: config.effective as Json },
      parent: input.parent,
      antecedent: input.antecedent,
    },
  }
}

export function confirmPublishedMandate(history: DecodedHistory, recordId: string): FixActionResult<FixMandateView> {
  const record = completeRecord(history, recordId)
  if (record === null) return failure('fix-only-mandate-unconfirmed')
  const view = mandateView(record)
  if (!view.ok) return view
  if (view.value.role !== 'fix-only' || view.value.storedLanding !== false) return failure('fix-only-mandate-lands')
  return view
}
