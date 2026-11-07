import {
  bindExternalRef,
  type GitHubOptions,
  readCauseDispositionHeads,
  readCauseHistoryClosure,
  readComposedWorkflowHistory,
  resolveAdjudicationContext,
  resolveAdjudicationSources,
  resolveSpecEffective,
  validateCauseDispositionRecords,
} from '../dist/contracts.js'
import type { ObservationRef } from '../engine/criterion-evidence-schema.ts'
import type { CauseContext } from '../engine/finding-target.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import { defaultGh } from './feature-engine.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { UwReadPort } from './uw-contract.ts'

export type AdjudicationRead = {
  disposition: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  histories: DecodedHistory[]
  catalogues: ReviewClassCatalogues
  context: CauseContext
}
const same = (a: Scope, b: Scope) => a.repository === b.repository && a.target === b.target
function failure(errors: readonly { code: string }[]): never {
  throw new Error(errors.map((item) => item.code).join(',') || 'cause-source-invalid')
}
function home(histories: readonly DecodedHistory[], scope: Scope): DecodedHistory {
  const found = histories.find((item) => same(item.source.scope, scope))
  if (!found) throw new Error('cause-history-missing')
  return found
}

function validateDispositionHistory(
  ref: ExternalRecordRef & { kind: 'cause-disposition' },
  histories: DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): void {
  const own = home(histories, ref.scope)
  const records = own.operations.flatMap((item) =>
    item.status === 'complete' && item.authority !== 'foreign' && item.record !== null ? [item.record] : [],
  )
  const validation = validateCauseDispositionRecords({ records, histories, catalogues })
  if (validation.length) failure(validation)
  const heads = readCauseDispositionHeads({ uw: ref.scope, histories, catalogues })
  if (!heads.ok) failure(heads.diagnostics)
  if (!heads.value.some((item) => item.recordId === ref.recordId)) throw new Error('cause-disposition-stale')
}

function sourceScopes(
  disposition: AdjudicationRead['disposition'],
  context: CauseContext,
  references: readonly ObservationRef[],
): Scope[] {
  const subject = disposition.payload.subject
  const source =
    subject.kind === 'cause'
      ? subject.decision
      : subject.kind === 'retained-finding'
        ? subject.contribution
        : subject.source
  const scopes = [
    context.original,
    source.scope,
    context.effective.own.sourceAccepted.scope,
    disposition.payload.origin.sourceAccepted.scope,
    ...references.flatMap((item) => (item.source === 'record' ? [item.record.scope] : [])),
  ]
  return [...new Map(scopes.map((scope) => [`${scope.repository}\0${scope.target}`, scope])).values()]
}

export async function readAdjudicationPending(
  ref: ExternalRecordRef & { kind: 'cause-disposition' },
  reader: UwReadPort,
  github: GitHubOptions,
  references: readonly ObservationRef[] = [],
): Promise<AdjudicationRead> {
  const initial = await readComposedWorkflowHistory([ref.scope], github)
  if (!initial.ok) failure(initial.diagnostics)
  const bound = bindExternalRef(ref, home(initial.histories, ref.scope))
  if (!bound.ok) failure(bound.diagnostics)
  if (bound.value.kind !== 'cause-disposition') throw new Error('cause-kind-mismatch')
  const disposition = bound.value
  const original = await reader.readUw(ref.scope)
  if (original.accepted.status !== 'accepted') throw new Error('correction-spec-not-accepted')
  if (original.observation.status !== 'complete') throw new Error('cause-observation-incomplete')
  const effective = resolveSpecEffective({
    mode: 'current',
    own: original.accepted.value.ref,
    histories: original.observation.histories,
    graph: original.observation.graph,
  })
  if (!effective.ok) failure(effective.diagnostics)
  const currentContext = { original: ref.scope, effective: effective.value }
  const loaded = await readComposedWorkflowHistory(sourceScopes(disposition, currentContext, references), github)
  if (!loaded.ok) failure(loaded.diagnostics)
  const closure = await readCauseHistoryClosure(loaded.histories, (needed) =>
    readComposedWorkflowHistory(needed, github),
  )
  if (!closure.ok) failure(closure.diagnostics)
  const histories = closure.histories
  const catalogues = await loadReviewClassCatalogues({ histories, cwd: github.cwd, gh: github.gh ?? defaultGh() })
  const rebound = bindExternalRef(ref, home(histories, ref.scope))
  if (!rebound.ok || JSON.stringify(rebound.value) !== JSON.stringify(disposition))
    throw new Error('cause-disposition-stale')
  const origin = resolveAdjudicationContext({ pending: disposition, histories, catalogues })
  if (!origin.ok) failure(origin.diagnostics)
  const context = origin.value
  const inputs = resolveAdjudicationSources({ pending: disposition, histories, context })
  if (!inputs.ok) failure(inputs.diagnostics)
  validateDispositionHistory(ref, histories, catalogues)
  return { disposition, histories, context, catalogues }
}
