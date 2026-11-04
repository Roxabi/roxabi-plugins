import {
  assessCauseDispositions,
  type CanonicalRecord,
  canonicalValueDigest,
  type DecodedHistory,
  type DispositionSource,
  type Ref,
  readCauseDispositionHeads,
  readCauseHistoryClosure,
  type Scope,
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

async function loadDispositionHistories(
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

export async function persistCauseDispositions(
  prepared: Pick<PreparedFix, 'causeContext'>,
  source: DispositionSource,
  identity: FixIdentity,
  store: FixDispositionStore,
): Promise<FixActionResult<PersistedDispositions>> {
  const recordSource = source.kind === 'decision' ? source.decision : source.contributions[0]
  if (recordSource === undefined) return failure('correction-disposition-source-missing')
  const decisionScope = { repository: recordSource.repository, target: recordSource.target }
  const scopeMap = new Map<string, typeof decisionScope>()
  const addScope = (scope: typeof decisionScope) => scopeMap.set(`${scope.repository}\0${scope.target}`, scope)
  addScope(decisionScope)
  addScope(prepared.causeContext.original)
  addScope(prepared.causeContext.effective.own.sourceAccepted.scope)
  dispositionSourceScopes(source, addScope)
  const loaded = await loadDispositionHistories(store, scopeMap)
  if (!loaded.ok) return loaded
  const operations = loaded.value.flatMap((history) => history.operations)
  const heads = readCauseDispositionHeads({ uw: prepared.causeContext.original, histories: loaded.value })
  if (!heads.ok) return failure(...heads.diagnostics.map((item) => item.code))
  const records = operations.flatMap((operation) =>
    operation.status === 'complete' && operation.authority !== 'foreign' && operation.record !== null
      ? [operation.record]
      : [],
  )
  const invalid = validateCauseDispositionRecords({ records, histories: loaded.value })
  if (invalid.length) return failure(...invalid.map((item) => item.code))
  const assessment = assessCauseDispositions({
    context: prepared.causeContext,
    source,
    histories: loaded.value,
    adjudications: [],
  })
  if (!assessment.ok) return failure(...assessment.diagnostics.map((item) => item.code))
  const refs: Ref<'cause-disposition'>[] = []
  const executable = new Map<string, Ref<'cause-disposition'>>()
  const errors: string[] = []
  let pending = false
  for (const outcome of assessment.value.outcomes) {
    const head = heads.value.find(
      (item) =>
        canonicalValueDigest([item.payload.origin, item.payload.subject]) ===
        canonicalValueDigest([outcome.origin, outcome.subject]),
    )
    if (head !== undefined) {
      const headPending = reuseDispositionHead(head, prepared.causeContext.original, refs, executable)
      pending ||= headPending
      continue
    }
    pending ||= outcome.outcome.state === 'pending-blocking'
    const saved = await saveDisposition(
      outcome,
      prepared.causeContext.original,
      identity,
      store,
      loaded.value,
      operations,
    )
    if (!saved.ok) {
      errors.push(...saved.diagnostics)
      continue
    }
    const ref: Ref<'cause-disposition'> = {
      scope: prepared.causeContext.original,
      kind: 'cause-disposition',
      recordId: saved.value.recordId,
    }
    refs.push(ref)
    if (outcome.subject.kind === 'cause' && assessment.value.executableCauseIds.includes(outcome.subject.cause.id))
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
