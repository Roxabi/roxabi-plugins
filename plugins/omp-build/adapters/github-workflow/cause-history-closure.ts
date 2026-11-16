import { causeHistoryReferences } from '../../engine/cause-disposition.ts'
import { fixRecoveryDiscoveryScopes } from '../../engine/fix-recovery-discovery.ts'
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

function completeTrustedRecords(histories: readonly DecodedHistory[]): CanonicalRecord[] {
  return histories.flatMap((history) =>
    history.operations.flatMap((operation) =>
      operation.authority !== 'foreign' && operation.status === 'complete' && operation.record !== null
        ? [operation.record]
        : [],
    ),
  )
}

function missingScopes(
  records: readonly CanonicalRecord[],
  histories: Map<string, DecodedHistory>,
): Map<string, Scope> {
  const pending = new Map<string, Scope>()
  const add = (scope: Scope) => {
    const id = key(scope)
    if (!histories.has(id)) pending.set(id, scope)
  }
  for (const ref of causeHistoryReferences(records)) add(ref.scope)
  for (const scope of fixRecoveryDiscoveryScopes(records)) add(scope)
  return pending
}

type ClosureSeed =
  | { kind: 'strict'; histories: readonly DecodedHistory[] }
  | { kind: 'primary-observation'; primary: DecodedHistory; external: readonly DecodedHistory[] }

function closureInputs(seed: ClosureSeed, current: DecodedHistory[]) {
  if (seed.kind === 'strict') return { strictHistories: current, primaryRecords: [] }
  return {
    strictHistories: current.filter((history) => history !== seed.primary),
    primaryRecords: completeTrustedRecords([seed.primary]),
  }
}

async function readPending(
  histories: Map<string, DecodedHistory>,
  pending: Map<string, Scope>,
  read: (scopes: readonly Scope[]) => Promise<ComposedWorkflowHistory>,
): Promise<{ observed: ComposedWorkflowHistory; failure: HistoryFailure | null }> {
  const observed = await read([...pending.values()])
  return { observed, failure: appendHistories(histories, observed.histories, pending) }
}

function closureStep(
  seed: ClosureSeed,
  histories: Map<string, DecodedHistory>,
  readFailure: HistoryFailure | null,
): { pending: Map<string, Scope> } | { result: ComposedWorkflowHistory } {
  const current = [...histories.values()]
  const { strictHistories, primaryRecords } = closureInputs(seed, current)
  // Bootstrap recovery/PR scopes from complete raw anchors before ordinary incomplete siblings refuse.
  const bootstrapRecords = [...primaryRecords, ...completeTrustedRecords(strictHistories)]
  const bootstrapPending = missingScopes(bootstrapRecords, histories)
  if (bootstrapPending.size > 0) return { pending: bootstrapPending }
  const validated = validateComposedWorkflowHistories(strictHistories, current)
  if (!validated.ok) return { result: { ...validated, histories: current } }
  if (readFailure !== null) return { result: { ...readFailure, histories: current } }
  const pending = missingScopes([...primaryRecords, ...validated.records], histories)
  if (pending.size > 0) return { pending }
  return {
    result: {
      ok: true,
      scopes: current.map((history) => history.source.scope),
      histories: current,
      records: validated.records,
    },
  }
}

async function expandCauseHistoryClosure(
  seed: ClosureSeed,
  read: (scopes: readonly Scope[]) => Promise<ComposedWorkflowHistory>,
): Promise<ComposedWorkflowHistory> {
  const initial = seed.kind === 'strict' ? seed.histories : [seed.primary, ...seed.external]
  const histories = new Map<string, DecodedHistory>()
  const initialFailure = appendHistories(histories, initial)
  if (initialFailure !== null) return initialFailure
  let readFailure: HistoryFailure | null = null
  while (true) {
    const step = closureStep(seed, histories, readFailure)
    if ('result' in step) return step.result
    const { observed, failure } = await readPending(histories, step.pending, read)
    if (!observed.ok && readFailure === null) readFailure = observed
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
