import type {
  AcceptedOwnSpec,
  DecodedHistory,
  GitHubOptions,
  Json,
  MandatePayload,
  Scope,
  ScopedRecordRef,
} from '../dist/contracts.js'
import { effectiveMandateRole, shippedProductVersion } from '../dist/contracts.js'
import { linkedIssueBinding } from './fix-checkpoint-binding.ts'
import { reconstructFixCheckpoint } from './fix-checkpoint-state.ts'
import type { FixActionResult, FixRecord, FixTarget } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { type FixOnlyMandateDraft, resolveCorrectionMandate } from './fix-mandate-resolution.ts'
import {
  type CorrectionExecutionRights,
  completeRecord,
  type FixMandateView,
  mandateView,
} from './fix-mandate-types.ts'
import { extendObservedUwCausalContext, readFreshUwCausalContext } from './fix-uw-histories.ts'
import type { UwReadPort } from './uw-contract.ts'
import { readEffectiveFixConfig } from './workflow-config.ts'

export type FixAuthorityDecision =
  | { status: 'reuse'; mandate: FixMandateView; execution: CorrectionExecutionRights; sameScope: boolean; uw: Scope }
  | { status: 'successor'; antecedent: FixMandateView }
  | { status: 'missing' }
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
  const checkpoint = reconstructFixCheckpoint(
    history,
    trustedLiveRequest,
    histories.filter(
      (item) =>
        item.source.scope.repository !== history.source.scope.repository ||
        item.source.scope.target !== history.source.scope.target,
    ),
  )
  if (checkpoint.status === 'blocked') return failure(...checkpoint.diagnostics)
  return { ok: true, value: undefined }
}

function decideSelectedAuthority(
  selected:
    | { status: 'missing' }
    | {
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
  if (selected.status === 'missing') return { ok: true, value: { status: 'missing' } }
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
  if (linked.value.currentSpec === null && input.target.kind === 'pull-request') return failure('fix-own-uw-required')
  const causal =
    linked.value.currentSpec === null
      ? await readFreshUwCausalContext(
          { repository: input.target.repository, target: input.target.target },
          selectedHistories,
          input.options,
        )
      : await extendObservedUwCausalContext(linked.value.currentSpec.causal, selectedHistories, input.options)
  if (!causal.ok) return causal
  const checkpoint = checkFixCheckpoint(history, input.trustedLiveRequest, causal.value.histories)
  if (!checkpoint.ok) return checkpoint
  const selected = await resolveCorrectionMandate({
    target: input.target,
    history,
    linkedIssueHistory: linked.value.history,
    linkedIssueScopes: [],
    externalHistories: linked.value.externalHistories,
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
  if (again.value.status !== 'reuse' || again.value.mandate.recordId !== input.boundRecordId) {
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
