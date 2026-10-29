import type { DecodedHistory, GitHubOptions, Json, Scope, ScopedRecordRef } from '../dist/contracts.js'
import { effectiveMandateRole, shippedProductVersion } from '../dist/contracts.js'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { MandatePayload } from '../engine/workflow-mandate-schema.ts'
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
  const checkpoint = reconstructFixCheckpoint(history, input.trustedLiveRequest)
  if (checkpoint.status === 'blocked') return failure(...checkpoint.diagnostics)
  const linked = await linkedIssueBinding(input.target, input.options, input.uw)
  if (!linked.ok) return linked
  const selected = await resolveCorrectionMandate({
    target: input.target,
    history,
    linkedIssueHistory: linked.value.history,
    linkedIssueScopes: [],
    externalHistories: linked.value.externalHistories,
    branch: linked.value.branch ?? input.branch,
    base: linked.value.base ?? input.base,
    currentSpec: linked.value.currentSpec,
  })
  if (!selected.ok) return selected
  if (selected.value.status === 'missing') return { ok: true, value: { status: 'missing' } }
  if (selected.value.execution.landing !== false) return failure('fix-mandate-execution-denied')
  const mandate = selected.value.mandate
  if (
    input.requiredFeatureMandate !== undefined &&
    !matchesRequiredFeatureMandate(input.requiredFeatureMandate, mandate, selected.value.acceptedSpec)
  ) {
    return failure('feature-mandate-required')
  }
  return {
    ok: true,
    value: {
      status: 'reuse',
      mandate,
      execution: selected.value.execution,
      sameScope: mandate.repository === input.target.repository && mandate.target === input.target.target,
      uw: selected.value.acceptedSpec.ref.uw,
    },
  }
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
