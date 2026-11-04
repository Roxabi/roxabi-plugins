import {
  assessCauseDispositions,
  type DecodedHistory,
  type DispositionSource,
  type Ref,
  type Scope,
} from '../dist/contracts.js'
import type { FixActionResult, FixIdentity, PreparedFix } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { dispositionOperationScopes, dispositionSourceScopes, saveDisposition } from './fix-disposition-persistence.ts'
import type { FixDispositionStore } from './fix-disposition-store.ts'

export type PersistedDispositions = {
  refs: Ref<'cause-disposition'>[]
  pending: boolean
  executable: ReadonlyMap<string, Ref<'cause-disposition'>>
}

async function loadDispositionHistories(
  store: FixDispositionStore,
  scopes: Map<string, Scope>,
  addScope: (scope: Scope) => void,
): Promise<FixActionResult<readonly DecodedHistory[]>> {
  let loaded = await store.read([...scopes.values()]).catch(() => null)
  if (loaded === null) return failure('correction-disposition-history-unavailable')
  if (!loaded.ok) return failure(...loaded.diagnostics.map((item) => item.code))
  dispositionOperationScopes(loaded.value, addScope)
  if (scopes.size > loaded.value.length) {
    loaded = await store.read([...scopes.values()]).catch(() => null)
    if (loaded === null) return failure('correction-disposition-history-unavailable')
    if (!loaded.ok) return failure(...loaded.diagnostics.map((item) => item.code))
  }
  return { ok: true, value: loaded.value }
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
  const loaded = await loadDispositionHistories(store, scopeMap, addScope)
  if (!loaded.ok) return loaded
  const operations = loaded.value.flatMap((history) => history.operations)
  const adjudications = operations.flatMap((operation) =>
    operation.status === 'complete' && operation.authority !== 'foreign' && operation.record?.kind === 'cause-operation'
      ? [operation.record]
      : [],
  )
  const assessment = assessCauseDispositions({
    context: prepared.causeContext,
    source,
    histories: loaded.value,
    adjudications,
  })
  if (!assessment.ok) return failure(...assessment.diagnostics.map((item) => item.code))
  const refs: Ref<'cause-disposition'>[] = []
  const executable = new Map<string, Ref<'cause-disposition'>>()
  const errors: string[] = []
  for (const outcome of assessment.value.outcomes) {
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
      pending: assessment.value.outcomes.some((outcome) => outcome.outcome.state === 'pending-blocking'),
    },
  }
}
