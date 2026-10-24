import type { DecodedHistory, GitHubOptions, Json, Scope, ScopedRecordRef } from '../dist/contracts.js'
import { shippedProductVersion } from '../dist/contracts.js'
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
import { readEffectiveFixConfig } from './workflow-config.ts'
import { readProofConfigPins } from './workflow-pins.ts'

export type FixAuthorityDecision =
  | { status: 'reuse'; mandate: FixMandateView; execution: CorrectionExecutionRights; sameScope: boolean }
  | { status: 'successor'; antecedent: FixMandateView }
  | { status: 'missing' }
export function matchesRequiredFeatureMandate(
  required: ScopedRecordRef & { kind: 'mandate' },
  mandate: FixMandateView,
  acceptedScope: string,
  correctionScope: string,
): boolean {
  return (
    required.kind === 'mandate' &&
    mandate.role === 'feature' &&
    required.recordId === mandate.recordId &&
    required.scope.repository === mandate.repository &&
    required.scope.target === mandate.target &&
    acceptedScope === correctionScope
  )
}

export async function decideFixAuthority(input: {
  target: FixTarget
  options: GitHubOptions
  readHistory: () => Promise<DecodedHistory>
  branch: string | null
  base: string | null
  correctionScope: string
  requiredFeatureMandate?: ScopedRecordRef & { kind: 'mandate' }
  trustedLiveRequest?: Extract<FixRecord, { kind: 'fix-request' }>
}): Promise<FixActionResult<FixAuthorityDecision>> {
  const history = await input.readHistory()
  if (!history.source.complete) return failure('fix-history-incomplete')
  const checkpoint = reconstructFixCheckpoint(history, input.trustedLiveRequest)
  if (checkpoint.status === 'blocked') return failure(...checkpoint.diagnostics)
  const linked = await linkedIssueBinding(input.target, input.options)
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
    !matchesRequiredFeatureMandate(
      input.requiredFeatureMandate,
      mandate,
      selected.value.acceptedSpec.body,
      input.correctionScope,
    )
  ) {
    return failure('feature-mandate-required')
  }
  if (mandate.role === 'fix-only' && selected.value.acceptedSpec.body !== input.correctionScope) {
    return { ok: true, value: { status: 'successor', antecedent: mandate } }
  }
  return {
    ok: true,
    value: {
      status: 'reuse',
      mandate,
      execution: selected.value.execution,
      sameScope: mandate.repository === input.target.repository && mandate.target === input.target.target,
    },
  }
}

export async function confirmFixContinuation(input: {
  target: FixTarget
  options: GitHubOptions
  readHistory: () => Promise<DecodedHistory>
  branch: string | null
  base: string | null
  correctionScope: string
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
  work: { reference: string; body: string; lastEditedAt: string }
  parent: FixMandateView['parent']
  antecedent: FixMandateView['antecedent']
}): Promise<FixActionResult<FixOnlyMandateDraft>> {
  let productVersion: string
  try {
    productVersion = shippedProductVersion()
  } catch {
    return failure('fix-product-version-unreadable')
  }
  if (!/^[0-9a-f]{40}$/.test(input.commit) || input.work.body.length === 0 || input.work.lastEditedAt.length === 0) {
    return failure('fix-config-unreadable')
  }
  const config = await readEffectiveFixConfig({ cwd: input.cwd, commit: input.commit, git: input.git })
  if (!config.ok) return failure(`fix-config-${config.reason}`, ...config.diagnostics.map((item) => item.code))
  let pins: { sourceCommit: string; path: string; blob: string | null }[]
  try {
    pins = await readProofConfigPins(input.git, input.cwd, input.commit)
  } catch (error) {
    return failure(`fix-proof-pins-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
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
      work: input.work,
      config: { version: config.version, digest: config.digest, effective: config.effective as Json },
      proofPins: pins,
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
