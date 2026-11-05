import { causeHistoryReferences } from '../../engine/cause-disposition.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { diagnostic } from '../github/types.ts'
import { validateComposedWorkflowHistories } from './history.ts'
import type { ComposedWorkflowHistory } from './types.ts'

const key = (scope: Scope) => `${scope.repository}\0${scope.target}`

type HistoryFailure = Extract<ComposedWorkflowHistory, { ok: false }>

function appendHistories(
  histories: Map<string, DecodedHistory>,
  observed: readonly DecodedHistory[],
  pending?: Map<string, Scope>,
): HistoryFailure | null {
  for (const history of observed) {
    const id = key(history.source.scope)
    const requested = pending === undefined || pending.delete(id)
    if (histories.has(id) || !requested)
      return {
        ok: false,
        reason: 'ambiguous',
        diagnostics: [diagnostic('ambiguous', `Unexpected or duplicate history for ${history.source.scope.target}`)],
        histories: [...histories.values()],
      }
    histories.set(id, history)
  }
  if (pending !== undefined && pending.size > 0)
    return {
      ok: false,
      reason: 'incomplete',
      diagnostics: [diagnostic('incomplete', 'Referenced history was not returned')],
      histories: [...histories.values()],
    }
  return null
}

function missingScopes(
  records: readonly CanonicalRecord[],
  histories: Map<string, DecodedHistory>,
): Map<string, Scope> {
  const pending = new Map<string, Scope>()
  for (const ref of causeHistoryReferences(records)) {
    const id = key(ref.scope)
    if (!histories.has(id)) pending.set(id, ref.scope)
  }
  return pending
}

type ClosureSeed =
  | { kind: 'strict'; histories: readonly DecodedHistory[] }
  | { kind: 'primary-observation'; primary: DecodedHistory; external: readonly DecodedHistory[] }

async function expandCauseHistoryClosure(
  seed: ClosureSeed,
  read: (scopes: readonly Scope[]) => Promise<ComposedWorkflowHistory>,
): Promise<ComposedWorkflowHistory> {
  const initial = seed.kind === 'strict' ? seed.histories : [seed.primary, ...seed.external]
  const histories = new Map<string, DecodedHistory>()
  const initialFailure = appendHistories(histories, initial)
  if (initialFailure !== null) return initialFailure
  while (true) {
    const current = [...histories.values()]
    const strictHistories = seed.kind === 'strict' ? current : current.filter((history) => history !== seed.primary)
    const validated = validateComposedWorkflowHistories(strictHistories)
    if (!validated.ok) return { ...validated, histories: current }
    const primaryRecords =
      seed.kind === 'strict'
        ? []
        : seed.primary.operations.flatMap((operation) =>
            operation.status === 'complete' && operation.authority !== 'foreign' && operation.record !== null
              ? [operation.record]
              : [],
          )
    const pending = missingScopes([...primaryRecords, ...validated.records], histories)
    if (pending.size === 0)
      return {
        ok: true,
        scopes: current.map((history) => history.source.scope),
        histories: current,
        records: validated.records,
      }
    const observed = await read([...pending.values()])
    if (!observed.ok) return { ...observed, histories: [...current, ...observed.histories] }
    const failure = appendHistories(histories, observed.histories, pending)
    if (failure !== null) return failure
  }
}

/** Expand typed references from a fully authenticated collection. */
export function readCauseHistoryClosure(
  initial: readonly DecodedHistory[],
  read: (scopes: readonly Scope[]) => Promise<ComposedWorkflowHistory>,
): Promise<ComposedWorkflowHistory> {
  return expandCauseHistoryClosure({ kind: 'strict', histories: initial }, read)
}

/** Discover from a raw primary observation without promoting it to external authority. */
export function readCauseHistoryClosureFromPrimary(
  primary: DecodedHistory,
  external: readonly DecodedHistory[],
  read: (scopes: readonly Scope[]) => Promise<ComposedWorkflowHistory>,
): Promise<ComposedWorkflowHistory> {
  return expandCauseHistoryClosure({ kind: 'primary-observation', primary, external }, read)
}
