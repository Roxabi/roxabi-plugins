import { buildRecord } from './record-construction.ts'
import { specDigest } from './record-digests.ts'
import type { ExternalRecordRef, ProofConfigPin } from './record-references.ts'
import type { Diagnostic, Json, Scope } from './record-values.ts'
import type { Result } from './result.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { MandateRefusal } from './workflow-mandate.ts'

export type FixMandateAssessment =
  | { status: 'applicable'; mandate: MandateRecord; execution: { correct: true; landing: false } }
  | { status: 'refused'; reason: MandateRefusal; evidence: Diagnostic[] }

export function buildFixOnlyMandate(draft: {
  scope: Scope
  recordId: string
  runId: string
  operationId: string
  branch: string | null
  base: string
  lineageHead: string | null
  productVersion: string
  work: { reference: string; body: string; lastEditedAt: string }
  config: { version: string; digest: string; effective: Json }
  proofPins: ProofConfigPin[]
  parent: ExternalRecordRef | null
  antecedent: ExternalRecordRef | null
}): Result<MandateRecord> {
  return buildRecord({
    kind: 'mandate',
    version: 1,
    repository: draft.scope.repository,
    target: draft.scope.target,
    recordId: draft.recordId,
    runId: draft.runId,
    operationId: draft.operationId,
    payload: {
      role: 'fix-only',
      branch: draft.branch,
      base: draft.base,
      lineageHead: draft.lineageHead,
      run: null,
      children: null,
      permissions: { landing: false, correct: true },
      config: {
        productVersion: draft.productVersion,
        version: draft.config.version,
        digest: draft.config.digest,
        effective: draft.config.effective,
      },
      proofPins: draft.proofPins,
      parent: draft.parent,
      antecedent: draft.antecedent,
      spec: {
        reference: draft.work.reference,
        body: draft.work.body,
        bodySha256: specDigest(draft.work.body),
        lastEditedAt: draft.work.lastEditedAt,
      },
    },
  })
}
