import {
  canonicalValueDigest,
  criterionDeclarationSchema,
  criterionVerdictSchema,
  recordsOf,
  specReportSchema,
} from '../dist/contracts.js'
import type { CodeVersion, CriterionDeclaration } from '../engine/criterion-evidence-schema.ts'
import type { CriterionVerdict } from '../engine/criterion-verdict-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Diagnostic, Scope } from '../engine/record-values.ts'
import { isGitSha } from './uw-action-result.ts'
import type { UwDeliveryDeclaration, UwDeliveryVerdict } from './uw-delivery-read.ts'

function admittedReview(record: CanonicalRecord): record is Extract<CanonicalRecord, { kind: 'review' }> {
  return record.kind === 'review'
}

function receiptResult(payload: object): boolean {
  if (!('format' in payload) || payload.format !== 'omp-build-action-receipt/2') return false
  if (!('phase' in payload) || payload.phase !== 'result') return false
  if (!('action' in payload) || payload.action !== 'implement') return false
  if (!('admission' in payload) || payload.admission === null || typeof payload.admission !== 'object') return false
  return 'admitted' in payload.admission && payload.admission.admitted === true
}

function admittedTip(payload: object, repository: string): CodeVersion | null {
  if (!('admission' in payload) || payload.admission === null || typeof payload.admission !== 'object') return null
  const admission = payload.admission
  if (!('remoteTip' in admission) || typeof admission.remoteTip !== 'string' || !isGitSha(admission.remoteTip))
    return null
  return { repository, commit: admission.remoteTip }
}

function criteriaOf(payload: object): unknown[] | null {
  if (!('structured' in payload) || payload.structured === null || typeof payload.structured !== 'object') return null
  if (!('criteria' in payload.structured) || !Array.isArray(payload.structured.criteria)) return null
  return payload.structured.criteria.length === 0 ? null : payload.structured.criteria
}

function pushCriteria(
  record: CanonicalRecord,
  uw: Scope,
  code: CodeVersion,
  criteria: readonly unknown[],
  declarations: UwDeliveryDeclaration[],
  diagnostics: Diagnostic[],
): void {
  for (const [index, item] of criteria.entries()) {
    const parsed = criterionDeclarationSchema.safeParse(item)
    if (!parsed.success) {
      diagnostics.push({
        code: 'criterion-declaration-absent',
        message: `${record.recordId} criterion ${index} is unreadable`,
      })
      continue
    }
    if (parsed.data.target.spec.uw.repository !== uw.repository || parsed.data.target.spec.uw.target !== uw.target)
      continue
    declarations.push(declarationRef(record, code, index, parsed.data))
  }
}

function declarationRef(
  record: CanonicalRecord,
  code: CodeVersion,
  index: number,
  value: CriterionDeclaration,
): UwDeliveryDeclaration {
  return {
    value,
    code,
    receipt: {
      source: 'record',
      record: {
        scope: { repository: record.repository, target: record.target },
        recordId: record.recordId,
        kind: record.kind,
      },
      selector: `/payload/structured/criteria/${index}`,
      digest: canonicalValueDigest(value),
    },
  }
}

function collectRecordDeclarations(
  record: CanonicalRecord,
  uw: Scope,
  declarations: UwDeliveryDeclaration[],
  diagnostics: Diagnostic[],
): void {
  if (record.kind !== 'action-receipt' || record.payload === null || typeof record.payload !== 'object') return
  if (!receiptResult(record.payload)) return
  const code = admittedTip(record.payload, record.repository)
  if (code === null) {
    diagnostics.push({
      code: 'criterion-declaration-absent',
      message: `${record.recordId} has no observed code version`,
    })
    return
  }
  const criteria = criteriaOf(record.payload)
  if (criteria === null) {
    diagnostics.push({
      code: 'criterion-declaration-absent',
      message: `${record.recordId} has no criterion declarations`,
    })
    return
  }
  pushCriteria(record, uw, code, criteria, declarations, diagnostics)
}

export function collectDeclarations(
  uw: Scope,
  histories: readonly DecodedHistory[],
  diagnostics: Diagnostic[],
): UwDeliveryDeclaration[] {
  const declarations: UwDeliveryDeclaration[] = []
  for (const history of histories) {
    for (const record of recordsOf(history)) collectRecordDeclarations(record, uw, declarations, diagnostics)
  }
  const tips = new Set(declarations.map((item) => item.code.commit))
  if (tips.size > 1) {
    diagnostics.push({
      code: 'criterion-declaration-absent',
      message: 'Multiple admitted delivery tips; current code was not selected',
    })
    declarations.splice(0)
  }
  return declarations
}

function reviewCommit(histories: readonly DecodedHistory[], inventoryId: string | null): string | null {
  const review = histories
    .flatMap((item) => recordsOf(item))
    .find(
      (item): item is Extract<CanonicalRecord, { kind: 'review' }> =>
        admittedReview(item) && inventoryId !== null && item.payload.inventoryIds.includes(inventoryId),
    )
  return review === undefined ? null : review.payload.candidateGitSHA
}

function pushVerdictRows(
  record: CanonicalRecord,
  rows: readonly unknown[],
  commit: string,
  verdicts: UwDeliveryVerdict[],
  diagnostics: Diagnostic[],
): void {
  for (const [index, item] of rows.entries()) {
    const parsed = criterionVerdictSchema.safeParse(item)
    if (!parsed.success) {
      diagnostics.push({ code: 'criterion-verdict-absent', message: 'Contribution criterion verdict is not readable' })
      continue
    }
    verdicts.push(verdictRef(record, parsed.data, commit, index))
  }
}

function verdictRef(
  record: CanonicalRecord,
  value: CriterionVerdict,
  commit: string,
  index: number,
): UwDeliveryVerdict {
  return {
    value,
    code: { repository: record.repository, commit },
    source: {
      source: 'record',
      record: {
        scope: { repository: record.repository, target: record.target },
        recordId: record.recordId,
        kind: record.kind,
      },
      selector: `/payload/structured/specRows/${index}`,
      digest: canonicalValueDigest(value),
    },
  }
}

function collectRecordVerdicts(
  record: CanonicalRecord,
  histories: readonly DecodedHistory[],
  tips: ReadonlySet<string>,
  verdicts: UwDeliveryVerdict[],
  diagnostics: Diagnostic[],
): void {
  if (record.kind !== 'contribution' || record.payload.host?.role !== 'R-review-spec') return
  const report = specReportSchema.safeParse(record.payload.structured)
  if (!report.success) {
    diagnostics.push({ code: 'criterion-verdict-absent', message: `${record.recordId} has no canonical spec report` })
    return
  }
  const commit = reviewCommit(histories, record.payload.inventoryId)
  if (commit === null || !isGitSha(commit) || (tips.size === 1 && !tips.has(commit))) {
    diagnostics.push({
      code: 'criterion-verdict-absent',
      message: `${record.recordId} is not a verdict at the admitted tip`,
    })
    return
  }
  pushVerdictRows(record, report.data.specRows, commit, verdicts, diagnostics)
}

export function collectVerdicts(
  histories: readonly DecodedHistory[],
  tips: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): UwDeliveryVerdict[] {
  const verdicts: UwDeliveryVerdict[] = []
  for (const history of histories) {
    for (const record of recordsOf(history)) collectRecordVerdicts(record, histories, tips, verdicts, diagnostics)
  }
  return verdicts
}
