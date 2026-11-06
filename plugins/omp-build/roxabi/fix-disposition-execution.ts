import {
  assessCauseDispositions,
  type CanonicalRecord,
  type CauseDispositionPayload,
  canonicalValueDigest,
  type DecodedHistory,
  type DispositionSource,
  type PreparedCauseCapture,
  type Ref,
  readCauseDispositionHeads,
  readCauseHistoryClosure,
  type Scope,
  type UwGraphObservation,
  validateCauseDispositionRecords,
} from '../dist/contracts.js'
import type { FixActionResult, FixIdentity, PreparedFix } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { dispositionSourceScopes, saveDisposition } from './fix-disposition-persistence.ts'
import type { FixDispositionStore } from './fix-disposition-store.ts'

export type PersistedDispositions = {
  refs: Ref<'cause-disposition'>[]
  pending: boolean
  executable: ReadonlyMap<string, Ref<'cause-disposition'>>
}

export async function loadDispositionHistories(
  store: FixDispositionStore,
  scopes: Map<string, Scope>,
): Promise<FixActionResult<readonly DecodedHistory[]>> {
  const loaded = await store.read([...scopes.values()]).catch(() => null)
  if (loaded === null) return failure('correction-disposition-history-unavailable')
  if (!loaded.ok) return failure(...loaded.diagnostics.map((item) => item.code))
  const closure = await readCauseHistoryClosure(loaded.value, async (required) => {
    const result = await store.read(required).catch(() => null)
    if (result === null)
      return {
        ok: false as const,
        reason: 'unreadable' as const,
        diagnostics: [
          { code: 'correction-disposition-history-unavailable', message: 'Disposition history unavailable' },
        ],
        histories: [],
      }
    return result.ok
      ? { ok: true as const, scopes: [...required], histories: [...result.value], records: [] }
      : { ok: false as const, reason: 'unreadable' as const, diagnostics: result.diagnostics, histories: [] }
  })
  if (!closure.ok) return failure(...closure.diagnostics.map((item) => item.code))
  return { ok: true, value: closure.histories }
}

function reuseDispositionHead(
  head: Extract<CanonicalRecord, { kind: 'cause-disposition' }>,
  original: Scope,
  refs: Ref<'cause-disposition'>[],
  executable: Map<string, Ref<'cause-disposition'>>,
): boolean {
  const ref: Ref<'cause-disposition'> = { scope: original, kind: 'cause-disposition', recordId: head.recordId }
  refs.push(ref)
  if (
    head.payload.subject.kind === 'cause' &&
    head.payload.outcome.state === 'final' &&
    head.payload.outcome.disposition === 'fix-original'
  )
    executable.set(head.payload.subject.cause.id, ref)
  return head.payload.outcome.state === 'pending-blocking'
}

function rawCaptureMatches(capture: PreparedCauseCapture, source: DispositionSource): boolean {
  if (capture.kind !== 'raw') return true
  if (source.kind !== 'retained-output' || source.contributions.length !== capture.sources.length) return false
  const sourceKeys = source.contributions.map((item) => `${item.repository}\0${item.target}\0${item.recordId}`)
  const captureKeys = capture.sources.map((item) => `${item.scope.repository}\0${item.scope.target}\0${item.recordId}`)
  return (
    new Set(sourceKeys).size === sourceKeys.length &&
    !sourceKeys.some((key) => !captureKeys.includes(key)) &&
    !capture.sources.some((item) => item.kind !== 'contribution')
  )
}

export async function persistCauseDispositions(
  prepared: Pick<PreparedFix, 'causeContext'> & { capture: PreparedCauseCapture; graph: UwGraphObservation },
  source: DispositionSource,
  identity: FixIdentity,
  store: FixDispositionStore,
): Promise<FixActionResult<PersistedDispositions>> {
  const recordSource = source.kind === 'decision' ? source.decision : source.contributions[0]
  if (prepared.capture === undefined || prepared.graph === undefined)
    return failure('correction-disposition-capture-or-graph-missing')
  const capture = prepared.capture.kind === 'action' ? prepared.capture.input : null
  if (!rawCaptureMatches(prepared.capture, source)) return failure('correction-disposition-raw-capture-mismatch')
  if (recordSource === undefined) return failure('correction-disposition-source-missing')
  const decisionScope = { repository: recordSource.repository, target: recordSource.target }
  const scopeMap = new Map<string, typeof decisionScope>()
  const addScope = (scope: typeof decisionScope) => scopeMap.set(`${scope.repository}\0${scope.target}`, scope)
  addScope(decisionScope)
  addScope(prepared.causeContext.original)
  addScope(prepared.causeContext.effective.own.sourceAccepted.scope)
  for (const ref of prepared.causeContext.effective.versionVector) addScope(ref.sourceAccepted.scope)
  if (capture !== null) addScope(capture.record.scope)
  dispositionSourceScopes(source, addScope)
  const loaded = await loadDispositionHistories(store, scopeMap)
  if (!loaded.ok) return loaded
  const catalogues = await store.catalogues(loaded.value)
  const operations = loaded.value.flatMap((history) => history.operations)
  const heads = readCauseDispositionHeads({ uw: prepared.causeContext.original, histories: loaded.value, catalogues })
  if (!heads.ok) return failure(...heads.diagnostics.map((item) => item.code))
  const records = operations.flatMap((operation) =>
    operation.status === 'complete' && operation.authority !== 'foreign' && operation.record !== null
      ? [operation.record]
      : [],
  )
  const invalid = validateCauseDispositionRecords({ records, histories: loaded.value, catalogues })
  if (invalid.length) return failure(...invalid.map((item) => item.code))
  const assessment = assessCauseDispositions({
    context: prepared.causeContext,
    capture,
    graph: prepared.graph,
    source,
    histories: loaded.value,
    catalogues,
    adjudications: [],
  })
  if (!assessment.ok) return failure(...assessment.diagnostics.map((item) => item.code))
  return persistAssessedOutcomes(
    assessment.value.outcomes,
    assessment.value.executableCauseIds,
    heads.value,
    prepared.causeContext.original,
    identity,
    store,
    loaded.value,
    operations,
  )
}

async function persistAssessedOutcomes(
  outcomes: CauseDispositionPayload[],
  executableCauseIds: string[],
  heads: readonly Extract<CanonicalRecord, { kind: 'cause-disposition' }>[],
  original: Scope,
  identity: FixIdentity,
  store: FixDispositionStore,
  histories: readonly DecodedHistory[],
  operations: DecodedHistory['operations'],
): Promise<FixActionResult<PersistedDispositions>> {
  const refs: Ref<'cause-disposition'>[] = []
  const executable = new Map<string, Ref<'cause-disposition'>>()
  const errors: string[] = []
  let pending = false
  for (const outcome of outcomes) {
    const head = heads.find(
      (item) =>
        canonicalValueDigest([item.payload.origin, item.payload.basis.versionVector, item.payload.subject]) ===
        canonicalValueDigest([outcome.origin, outcome.basis.versionVector, outcome.subject]),
    )
    if (head !== undefined) {
      const headPending = reuseDispositionHead(head, original, refs, executable)
      pending ||= headPending
      continue
    }
    pending ||= outcome.outcome.state === 'pending-blocking'
    const saved = await saveDisposition(outcome, original, identity, store, histories, operations)
    if (!saved.ok) {
      errors.push(...saved.diagnostics)
      continue
    }
    const ref: Ref<'cause-disposition'> = {
      scope: original,
      kind: 'cause-disposition',
      recordId: saved.value.recordId,
    }
    refs.push(ref)
    if (outcome.subject.kind === 'cause' && executableCauseIds.includes(outcome.subject.cause.id))
      executable.set(outcome.subject.cause.id, ref)
  }
  if (errors.length > 0) return failure(...errors)
  return {
    ok: true,
    value: {
      refs,
      executable,
      pending,
    },
  }
}
