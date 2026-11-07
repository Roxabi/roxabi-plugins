import {
  authenticateCauseCapture,
  bindExternalRef,
  type CauseContext,
  canonicalValueDigest,
  type DecodedHistory,
  type DispositionSource,
  type PreparedCauseCapture,
  type ReviewClassCatalogues,
  type Scope,
} from '../dist/contracts.js'
import type { FixActionResult, FixIdentity, PreparedFix } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { loadDispositionHistories, persistCauseDispositions } from './fix-disposition-execution.ts'
import { dispositionSourceScopes } from './fix-disposition-persistence.ts'
import type { FixDispositionStore } from './fix-disposition-store.ts'
import { dispositionContext } from './fix-origin.ts'
import type { UwReadPort } from './uw-contract.ts'

export function capturePreparedIntake(prepared: PreparedFix): FixActionResult<PreparedCauseCapture> {
  const inputs = prepared.batch.tasks.tasks[0]?.action?.inputs
  if (inputs === undefined) return failure('correction-intake-capture-missing')
  return {
    ok: true,
    value: {
      kind: 'action',
      input: {
        source: 'record',
        record: {
          scope: { repository: prepared.target.repository, target: prepared.target.target },
          kind: 'review-attempt',
          recordId: prepared.inventoryId,
        },
        selector: '/payload/slots/0/action/inputs',
        digest: canonicalValueDigest(inputs),
      },
    },
  }
}

/** Reconstruct the declared producer, never a latest action, from authenticated source lineage. */
export async function captureDispositionSource(
  context: CauseContext,
  source: DispositionSource,
  store: FixDispositionStore,
): Promise<FixActionResult<PreparedCauseCapture>> {
  const scopes = new Map<string, Scope>()
  const add = (scope: Scope) => scopes.set(`${scope.repository}\0${scope.target}`, scope)
  add(context.original)
  if (source.kind === 'decision') add({ repository: source.decision.repository, target: source.decision.target })
  for (const ref of context.effective.versionVector) add(ref.sourceAccepted.scope)
  dispositionSourceScopes(source, add)
  const loaded = await loadDispositionHistories(store, scopes)
  if (!loaded.ok) return loaded
  const histories = loaded.value
  const catalogues = await store.catalogues(histories)
  const contributions =
    source.kind === 'retained-output'
      ? source.contributions
      : (() => {
          const scope = { repository: source.decision.repository, target: source.decision.target }
          const history = histories.find(
            (item) => item.source.scope.repository === scope.repository && item.source.scope.target === scope.target,
          )
          const bound =
            history &&
            bindExternalRef(
              { scope, kind: 'contribution', recordId: source.decision.payload.originalContributionId },
              history,
            )
          return bound?.ok && bound.value.kind === 'contribution' ? [bound.value] : []
        })()
  if (contributions.length === 0) return failure('correction-disposition-source-missing')
  const declared = contributions.filter(
    (item) =>
      item.payload.inventoryId !== null || item.payload.host.slotId !== null || item.payload.host.action !== undefined,
  )
  if (declared.length === 0) {
    const sources = contributions.map((item) => ({
      scope: { repository: item.repository, target: item.target },
      kind: 'contribution' as const,
      recordId: item.recordId,
    }))
    const first = sources[0]
    if (source.kind !== 'retained-output' || first === undefined)
      return failure('correction-disposition-producer-missing')
    const checked = authenticateCauseCapture({ context, capture: null, source, histories, catalogues })
    return checked.ok
      ? { ok: true, value: { kind: 'raw', sources: [first, ...sources.slice(1)] } }
      : failure(...checked.diagnostics.map((item) => item.code))
  }
  return captureDeclaredProducer(context, source, declared, histories, catalogues)
}

function captureDeclaredProducer(
  context: CauseContext,
  source: DispositionSource,
  declared: Extract<DispositionSource, { kind: 'retained-output' }>['contributions'],
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): FixActionResult<PreparedCauseCapture> {
  for (const contribution of declared) {
    const scope = { repository: contribution.repository, target: contribution.target }
    const history = histories.find(
      (item) => item.source.scope.repository === scope.repository && item.source.scope.target === scope.target,
    )
    if (!history || contribution.payload.inventoryId === null || contribution.payload.host.slotId === null) continue
    const ref = { scope, kind: 'review-attempt' as const, recordId: contribution.payload.inventoryId }
    const bound = bindExternalRef(ref, history)
    if (!bound.ok || bound.value.kind !== 'review-attempt') continue
    const index = bound.value.payload.slots.findIndex((slot) => slot.slotId === contribution.payload.host.slotId)
    const inputs = bound.value.payload.slots[index]?.action?.inputs
    if (index < 0 || inputs === undefined) continue
    const capture = {
      source: 'record' as const,
      record: ref,
      selector: `/payload/slots/${index}/action/inputs`,
      digest: canonicalValueDigest(inputs),
    }
    const checked = authenticateCauseCapture({ context, capture, source, histories, catalogues })
    if (checked.ok) return { ok: true, value: { kind: 'action', input: capture } }
  }
  return failure('correction-disposition-producer-unconfirmed')
}

/** Carry a producer capture or reconstruct the explicitly named source, then bind a fresh graph. */
export async function persistCapturedCauseDispositions(
  context: CauseContext,
  source: DispositionSource,
  identity: FixIdentity,
  store: FixDispositionStore,
  reader: UwReadPort,
  capture: PreparedCauseCapture | 'authenticate-source',
) {
  const captured =
    capture === 'authenticate-source'
      ? await captureDispositionSource(context, source, store)
      : { ok: true as const, value: capture }
  if (!captured.ok) return captured
  const prepared = await dispositionContext(context, captured.value, reader)
  if (!prepared.ok) return prepared
  return persistCauseDispositions(prepared.value, source, identity, store)
}
