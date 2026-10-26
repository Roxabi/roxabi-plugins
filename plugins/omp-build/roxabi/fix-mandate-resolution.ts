import type {
  CanonicalRecord,
  DecodedHistory,
  ExternalRecordRef,
  FixMandateAssessment,
  Json,
  Scope,
} from '../dist/contracts.js'
import {
  assessFixMandate,
  buildFixOnlyMandate,
  kindSchema,
  resolveAcceptedSpec,
  resolveBoundWork,
} from '../dist/contracts.js'
import type { FixActionResult, FixTarget } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import {
  type CorrectionExecutionRights,
  completeRecord,
  diagnosticCodes,
  type FixMandateView,
  MANDATE_REFUSAL,
  mandateView,
} from './fix-mandate-types.ts'

export function correctionHistories(input: {
  history: DecodedHistory
  linkedIssueHistory: DecodedHistory | null
  externalHistories?: readonly DecodedHistory[]
}): DecodedHistory[] {
  const histories = [input.history]
  if (input.linkedIssueHistory !== null && input.linkedIssueHistory !== input.history)
    histories.push(input.linkedIssueHistory)
  for (const extra of input.externalHistories ?? []) {
    if (!histories.includes(extra)) histories.push(extra)
  }
  return histories
}

export function acceptedSpecOf(
  mandate: CanonicalRecord,
  histories: readonly DecodedHistory[],
): FixActionResult<{ body: string; digest: string }> {
  if (mandate.kind !== 'mandate') return failure('fix-mandate-unrecognized')
  const resolved = resolveAcceptedSpec(mandate, histories)
  if (!resolved.ok) {
    if (MANDATE_REFUSAL[resolved.reason] !== true) return failure('fix-mandate-unrecognized')
    return failure(`fix-mandate-refused:${resolved.reason}`, ...diagnosticCodes(resolved.evidence))
  }
  if (resolved.spec.body.length === 0 || !/^[0-9a-f]{64}$/.test(resolved.spec.digest)) {
    return failure('fix-mandate-unrecognized')
  }
  return { ok: true, value: { body: resolved.spec.body, digest: resolved.spec.digest } }
}

export function boundCorrection(
  input: { target: FixTarget; branch: string | null; base: string | null },
  histories: readonly DecodedHistory[],
  currentSpec: { body: string; digest: string } | null,
): FixActionResult<
  { status: 'standalone' } | { status: 'applicable'; recordId: string; body: string; digest: string }
> {
  if (input.target.kind !== 'pull-request') return { ok: true, value: { status: 'standalone' } }
  if (input.branch === null || input.base === null) return failure('fix-mandate-refused:unknown-binding')
  const resolved = resolveBoundWork({
    use: 'correction',
    explicitSelection: true,
    pullRequest: { repository: input.target.repository, target: input.target.target },
    histories,
    native: { branch: input.branch, base: input.base },
    currentSpec,
  })
  if (resolved.status === 'standalone') return { ok: true, value: { status: 'standalone' } }
  if (resolved.status === 'refused') {
    if (MANDATE_REFUSAL[resolved.reason] !== true) return failure('fix-mandate-unrecognized')
    return failure(`fix-mandate-refused:${resolved.reason}`, ...diagnosticCodes(resolved.evidence))
  }
  if (resolved.drift !== 'settled') return failure('fix-bound-spec-unsettled')
  const spec = resolved.acceptedSpec
  if (!resolved.permissions.correct || spec.body.length === 0 || !/^[0-9a-f]{64}$/.test(spec.digest)) {
    return failure('fix-mandate-unrecognized')
  }
  return {
    ok: true,
    value: { status: 'applicable', recordId: resolved.mandate.recordId, body: spec.body, digest: spec.digest },
  }
}

type CorrectionMandateInput = {
  target: FixTarget
  history: DecodedHistory
  linkedIssueHistory: DecodedHistory | null
  linkedIssueScopes: readonly Scope[]
  externalHistories?: readonly DecodedHistory[]
  branch: string | null
  base: string | null
  currentSpec: { body: string; digest: string } | null
  evidenceDigest?: string | null
}

type BoundCorrection =
  | { status: 'standalone' }
  | { status: 'applicable'; recordId: string; body: string; digest: string }

type SelectedCorrectionMandate = FixMandateAssessment | { status: 'missing' }

type ResolvedCorrectionMandate =
  | {
      status: 'applicable'
      mandate: FixMandateView
      execution: CorrectionExecutionRights
      acceptedSpec: { body: string; digest: string }
    }
  | { status: 'missing' }

function selectCorrectionMandate(
  input: CorrectionMandateInput,
  bound: BoundCorrection,
): FixActionResult<SelectedCorrectionMandate> {
  const assessed: FixMandateAssessment = assessFixMandate({
    target: {
      scope: { repository: input.target.repository, target: input.target.target },
      kind: input.target.kind,
      branch: input.branch,
      base: input.base,
    },
    history: input.history,
    linkedIssueHistory: input.linkedIssueHistory,
    linkedIssueScopes: input.target.kind === 'pull-request' ? [] : input.linkedIssueScopes,
    externalHistories: input.externalHistories ?? [],
    evidenceDigest: input.evidenceDigest ?? null,
  })
  if (assessed.status === 'refused' && assessed.reason === 'missing' && publishableMissing(input, assessed.evidence)) {
    return bound.status === 'applicable'
      ? failure('fix-mandate-refused:ambiguous')
      : { ok: true, value: { status: 'missing' } }
  }
  return { ok: true, value: assessed }
}

function confirmedMandate(input: CorrectionMandateInput, recordId: string): CanonicalRecord | null {
  return (
    completeRecord(input.history, recordId) ??
    (input.linkedIssueHistory ? completeRecord(input.linkedIssueHistory, recordId) : null)
  )
}

function boundSpecMatchesAcceptedSpec(
  bound: BoundCorrection,
  record: CanonicalRecord,
  acceptedSpec: { body: string; digest: string },
): boolean {
  return (
    bound.status !== 'applicable' ||
    (bound.recordId === record.recordId && bound.body === acceptedSpec.body && bound.digest === acceptedSpec.digest)
  )
}

function resolveSelectedCorrectionMandate(
  input: CorrectionMandateInput,
  histories: readonly DecodedHistory[],
  bound: BoundCorrection,
  selected: FixActionResult<SelectedCorrectionMandate>,
): FixActionResult<ResolvedCorrectionMandate> {
  if (!selected.ok) return failure(...selected.diagnostics)
  if (selected.value.status === 'missing') return { ok: true, value: { status: 'missing' } }
  if (selected.value.status === 'refused') return failure(`fix-mandate-refused:${selected.value.reason}`)
  const confirmed = confirmedMandate(input, selected.value.mandate.recordId)
  if (confirmed === null || JSON.stringify(confirmed) !== JSON.stringify(selected.value.mandate)) {
    return failure('fix-mandate-unconfirmed')
  }
  const view = mandateView(confirmed)
  if (!view.ok) return view
  const accepted = acceptedSpecOf(confirmed, histories)
  if (!accepted.ok) return accepted
  if (!boundSpecMatchesAcceptedSpec(bound, confirmed, accepted.value)) return failure('fix-mandate-unconfirmed')
  return {
    ok: true,
    value: {
      status: 'applicable',
      mandate: view.value,
      execution: selected.value.execution,
      acceptedSpec: accepted.value,
    },
  }
}

export async function resolveCorrectionMandate(
  input: CorrectionMandateInput,
): Promise<FixActionResult<ResolvedCorrectionMandate>> {
  if (!input.history.source.complete) return failure('fix-history-incomplete')
  if (input.linkedIssueHistory && !input.linkedIssueHistory.source.complete)
    return failure('fix-parent-history-incomplete')
  const histories = correctionHistories(input)
  const bound = boundCorrection(input, histories, input.currentSpec)
  if (!bound.ok) return failure(...bound.diagnostics)
  const selected = selectCorrectionMandate(input, bound.value)
  return resolveSelectedCorrectionMandate(input, histories, bound.value, selected)
}

export function publishableMissing(
  input: { target: FixTarget; history: DecodedHistory; linkedIssueHistory: DecodedHistory | null },
  evidence: readonly { code: string; message: string }[],
): boolean {
  if (input.target.kind === 'pull-request' && input.linkedIssueHistory !== null) return false
  if (
    !input.history.source.complete ||
    mandateClaim(input.history) ||
    (input.linkedIssueHistory !== null && mandateClaim(input.linkedIssueHistory))
  ) {
    return false
  }
  return evidence.some((item) => item.code === 'missing' && item.message === 'No mandate record exists')
}

export function mandateClaim(history: DecodedHistory): boolean {
  return history.operations.some(
    (operation) =>
      operation.kind === 'mandate' ||
      operation.claimedKinds.includes('mandate') ||
      operation.record?.kind === 'mandate',
  )
}

export type FixOnlyMandateDraft = {
  scope: Scope
  recordId: string
  runId: string
  operationId: string
  branch: string | null
  base: string
  candidateGitSHA: string | null
  productVersion: string
  work: { reference: string; body: string; lastEditedAt: string }
  config: { version: string; digest: string; effective: Json }
  parent: { scope: Scope; recordId: string; kind: string } | null
  antecedent: { scope: Scope; recordId: string; kind: string } | null
}

export function mandateRef(
  ref: { scope: Scope; recordId: string; kind: string } | null,
): FixActionResult<ExternalRecordRef | null> {
  if (ref === null) return { ok: true, value: null }
  const parsed = kindSchema.safeParse(ref.kind)
  if (!parsed.success) return failure('fix-only-mandate-unrecognized')
  return { ok: true, value: { scope: ref.scope, recordId: ref.recordId, kind: parsed.data } }
}

export async function buildConfirmedFixOnlyMandate(
  draft: FixOnlyMandateDraft,
): Promise<FixActionResult<CanonicalRecord>> {
  const parent = mandateRef(draft.parent)
  if (!parent.ok) return parent
  const antecedent = mandateRef(draft.antecedent)
  if (!antecedent.ok) return antecedent
  const built = buildFixOnlyMandate({
    scope: draft.scope,
    recordId: draft.recordId,
    runId: draft.runId,
    operationId: draft.operationId,
    branch: draft.branch,
    base: draft.base,
    lineageHead: draft.candidateGitSHA,
    productVersion: draft.productVersion,
    work: draft.work,
    config: draft.config,
    parent: parent.value,
    antecedent: antecedent.value,
  })
  if (!built.ok) return failure(...diagnosticCodes(built.diagnostics).map((code) => `fix-only-mandate:${code}`))
  const view = mandateView(built.value)
  if (!view.ok) return view
  if (view.value.role !== 'fix-only' || view.value.storedLanding !== false) return failure('fix-only-mandate-lands')
  return { ok: true, value: built.value }
}
