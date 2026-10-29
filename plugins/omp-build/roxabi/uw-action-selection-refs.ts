import {
  canonicalValueDigest,
  implementationOutputSchema,
  planOutputSchema,
  recordsOf,
  resolveAdmittedCorrectionCriterionSource,
} from '../dist/contracts.js'
import type { ActionSpecInput } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'

import type { DeliveryDataRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

function recordRef(
  record: CanonicalRecord,
  selector: string,
  value: unknown,
  role: DeliveryDataRef['role'],
): DeliveryDataRef {
  return {
    source: 'record',
    record: {
      scope: { repository: record.repository, target: record.target },
      recordId: record.recordId,
      kind: record.kind,
    },
    selector,
    digest: canonicalValueDigest(value),
    role,
  }
}

function implementationRefs(
  record: CanonicalRecord,
  criteria: readonly { verification: string; evidence?: readonly { code: { commit: string } }[] }[],
  head: string,
  prefix = '/payload/structured/criteria',
): DeliveryDataRef[] {
  const refs: DeliveryDataRef[] = []
  criteria.forEach((declaration, index) => {
    refs.push(recordRef(record, `${prefix}/${index}`, declaration, 'implementation'))
    if (declaration.verification !== 'evidence' || declaration.evidence === undefined) return
    declaration.evidence.forEach((evidence, evidenceIndex) => {
      if (evidence.code.commit !== head) return
      refs.push(recordRef(record, `${prefix}/${index}/evidence/${evidenceIndex}`, evidence, 'criterion-evidence'))
    })
  })
  return refs
}

function planResultRefs(
  record: CanonicalRecord,
  body: { action: string; admission: { admitted: boolean } | null; actionId: string; structured: unknown },
  planActionId: string | null,
): Result<DeliveryDataRef[]> {
  if (body.admission !== null && body.admission.admitted !== true) return { ok: true, value: [] }
  if (planActionId === null || body.actionId !== planActionId || body.structured === null)
    return { ok: true, value: [] }
  const plan = planOutputSchema.safeParse(body.structured)
  if (!plan.success) return actionFailure('action-input-missing', 'Current plan result is not a plan')
  return { ok: true, value: [recordRef(record, '/payload/structured', plan.data, 'plan')] }
}

function implementResultRefs(
  record: CanonicalRecord,
  body: {
    action: string
    admission: { admitted: boolean; remoteTip?: string | null } | null
    structured: unknown
    exactInputs?: { planActionId?: string | null; mandateId?: string | null }
  },
  head: string,
  planActionId: string | null,
  mandateId: string,
): Result<DeliveryDataRef[]> {
  if (
    body.action !== 'implement' ||
    body.admission === null ||
    body.admission.admitted !== true ||
    body.admission.remoteTip !== head
  ) {
    return { ok: true, value: [] }
  }
  if (
    planActionId === null ||
    body.exactInputs?.planActionId !== planActionId ||
    body.exactInputs.mandateId !== mandateId
  ) {
    return { ok: true, value: [] }
  }
  const implemented = implementationOutputSchema.safeParse(body.structured)
  if (!implemented.success)
    return actionFailure('criterion-declaration-absent', 'Implementation has no readable criterion declarations')
  return { ok: true, value: implementationRefs(record, implemented.data.criteria, head) }
}

export function refsFor(
  record: CanonicalRecord,
  head: string,
  planActionId: string | null,
  mandateId: string,
): Result<DeliveryDataRef[]> {
  if (record.kind !== 'action-receipt' || record.payload.phase !== 'result') return { ok: true, value: [] }
  if (record.payload.action === 'plan') return planResultRefs(record, record.payload, planActionId)
  if (record.payload.action !== 'implement') return { ok: true, value: [] }
  return implementResultRefs(record, record.payload, head, planActionId, mandateId)
}

function appendLineage(refs: DeliveryDataRef[], lineage: readonly CanonicalRecord[]): void {
  for (const item of lineage) {
    if (
      !refs.some(
        (ref) =>
          ref.role === 'correction-lineage' &&
          ref.record.recordId === item.recordId &&
          ref.record.scope.repository === item.repository &&
          ref.record.scope.target === item.target,
      )
    )
      refs.push(recordRef(item, '/payload', item.payload, 'correction-lineage'))
  }
}

export function gatherCorrectionRefs(
  request: UwActionRequest,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  authenticate: (record: CanonicalRecord) => Result<CanonicalRecord>,
  planActionId: string | null,
  spec: ActionSpecInput | undefined,
  gathered: { refs: DeliveryDataRef[]; selected: CanonicalRecord[] },
): Result<true> {
  if (spec?.kind !== 'accepted' || planActionId === null) return { ok: true, value: true }
  for (const history of histories) {
    for (const record of recordsOf(history)) {
      if (
        record.kind !== 'fix-result' ||
        record.payload.candidateGitSHA !== request.code.head ||
        record.payload.criterionReceipt === undefined
      )
        continue
      const authenticated = authenticate(record)
      if (!authenticated.ok) return authenticated
      const source = resolveAdmittedCorrectionCriterionSource(record, histories, {
        head: request.code.head,
        planActionId,
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          kind: 'mandate',
          recordId: mandate.recordId,
        },
        ownSpec: spec.effective.own,
      })
      if (source === null) continue
      gathered.selected.push(record)
      gathered.refs.push(
        ...implementationRefs(record, source.criteria, request.code.head, '/payload/criterionReceipt/criteria'),
      )
      appendLineage(gathered.refs, source.lineage)
    }
  }
  return { ok: true, value: true }
}
