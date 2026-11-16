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
  allowMissing = false,
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
  if (!allowMissing && pending !== undefined && pending.size > 0)
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
  return { observed, failure: appendHistories(histories, observed.histories, pending, !observed.ok) }
}

function closureStep(
  seed: ClosureSeed,
  histories: Map<string, DecodedHistory>,
  readFailure: HistoryFailure | null,
  attempted: ReadonlySet<string>,
): { pending: Map<string, Scope> } | { result: ComposedWorkflowHistory } {
  const current = [...histories.values()]
  const { strictHistories, primaryRecords } = closureInputs(seed, current)
  // Bootstrap recovery/PR scopes from complete raw anchors before ordinary incomplete siblings refuse.
  const bootstrapRecords = [...primaryRecords, ...completeTrustedRecords(strictHistories)]
  const bootstrapPending = missingScopes(bootstrapRecords, histories)
  for (const id of attempted) bootstrapPending.delete(id)
  if (bootstrapPending.size > 0) return { pending: bootstrapPending }
  const validated = validateComposedWorkflowHistories(strictHistories, current)
  if (!validated.ok) {
    if (readFailure !== null && validated.reason !== 'ambiguous')
      return {
        result: {
          ...readFailure,
          diagnostics: [...readFailure.diagnostics, ...validated.diagnostics],
          histories: current,
        },
      }
    return {
      result: {
        ...validated,
        diagnostics: [...(readFailure?.diagnostics ?? []), ...validated.diagnostics],
        histories: current,
      },
    }
  }
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

function mergeReadFailure(previous: HistoryFailure | null, observed: HistoryFailure): HistoryFailure {
  if (previous === null) return observed
  const reason =
    previous.reason === 'ambiguous' || observed.reason === 'ambiguous'
      ? 'ambiguous'
      : previous.reason === 'unreadable' || observed.reason === 'unreadable'
        ? 'unreadable'
        : 'incomplete'
  return { ...previous, reason, diagnostics: [...previous.diagnostics, ...observed.diagnostics] }
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
  const attempted = new Set<string>()
  while (true) {
    const step = closureStep(seed, histories, readFailure, attempted)
    if ('result' in step) return step.result
    for (const id of step.pending.keys()) attempted.add(id)
    const { observed, failure } = await readPending(histories, step.pending, read)
    if (!observed.ok) readFailure = mergeReadFailure(readFailure, observed)
    if (failure !== null)
      return {
        ...failure,
        diagnostics: [...(readFailure?.diagnostics ?? []), ...failure.diagnostics],
      }
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
