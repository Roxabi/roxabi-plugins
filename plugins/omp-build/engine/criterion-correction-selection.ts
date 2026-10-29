import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs, PinnedFileRef } from './action-input-schema.ts'
import { resolveAdmittedCorrectionCriterionSource } from './correction-criterion-source.ts'
import { correctionObservationAuthenticationDiagnostics } from './correction-observation-authentication.ts'
import { evidenceDigest } from './criterion-admission.ts'
import {
  type CriterionDeclaration,
  type CriterionEvidence,
  criterionDeclarationSchema,
  type EvidenceRef,
} from './criterion-evidence-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'

type Ref = ActionInputs['manifest']['deliveryData'][number]
type Selection = { declarations: CriterionDeclaration[]; evidence: { ref: EvidenceRef; value: CriterionEvidence }[] }

function pointer(value: unknown, selector: string): unknown {
  let current = value
  for (const raw of selector.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) current = current[Number(key)]
    else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key))
      current = Object.getOwnPropertyDescriptor(current, key)?.value
    else return undefined
  }
  return current
}

function pinnedLineage(records: readonly CanonicalRecord[], inputs: ActionInputs): boolean {
  return records.every((item) =>
    inputs.manifest.deliveryData.some(
      (pin) =>
        pin.role === 'correction-lineage' &&
        pin.selector === '/payload' &&
        pin.record.recordId === item.recordId &&
        pin.record.kind === item.kind &&
        pin.record.scope.repository === item.repository &&
        pin.record.scope.target === item.target &&
        pin.digest === canonicalValueDigest(item.payload),
    ),
  )
}

export function appendCorrectionSelection(
  ref: Ref,
  histories: readonly DecodedHistory[],
  inputs: ActionInputs,
  planActionId: string,
  mandateId: string,
  specVersion: string,
  pins: readonly PinnedFileRef[],
  diagnostics: Diagnostic[],
  selected: Selection,
): void {
  const history = historyFor(ref.record.scope, histories)
  const bound = history === null ? null : bindExternalRef(ref.record, history)
  const fix = bound?.ok && bound.value.kind === 'fix-result' ? bound.value : null
  const source =
    fix === null
      ? null
      : resolveAdmittedCorrectionCriterionSource(fix, histories, {
          head: inputs.manifest.code.head,
          planActionId,
          mandateId,
          specVersion,
        })
  const value = fix === null ? undefined : pointer(fix, ref.selector)
  if (source === null || value === undefined || canonicalValueDigest(value) !== ref.digest) {
    diagnostics.push(
      diagnostic('unconfirmed', `Correction delivery ${ref.record.recordId} is not an authenticated current source`),
    )
    return
  }
  if (!pinnedLineage(source.lineage, inputs)) {
    diagnostics.push(
      diagnostic('mismatch', `Correction delivery ${ref.record.recordId} lacks its authenticated lineage pins`),
    )
    return
  }
  if (ref.role !== 'implementation') return
  const declaration = criterionDeclarationSchema.safeParse(value)
  if (!declaration.success) return
  selected.declarations.push(declaration.data)
  if (declaration.data.verification !== 'evidence') return
  for (const item of declaration.data.evidence) {
    if (item.code.commit !== inputs.manifest.code.head) {
      diagnostics.push(diagnostic('mismatch', `Evidence ${item.id} is not the admitted current head`))
      continue
    }
    diagnostics.push(...correctionObservationAuthenticationDiagnostics(item, histories, pins, source.contribution))
    selected.evidence.push({
      ref: { receipt: ref.record, evidenceId: item.id, digest: evidenceDigest(item) },
      value: item,
    })
  }
}
