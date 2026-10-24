import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import { historyFor, type WorkflowBindingRecord } from './workflow-control.ts'

type BindingCandidate =
  | { status: 'bound'; binding: WorkflowBindingRecord }
  | { status: 'absent' }
  | { status: 'incomplete' | 'conflicting'; diagnostics: Diagnostic[] }
type BindingRefusal = Extract<BindingCandidate, { status: 'incomplete' | 'conflicting' }>

type BindingInput = {
  pullRequest: Scope
  histories: readonly DecodedHistory[]
  native: { branch: string; base: string }
}

function bindingRefusal(status: 'incomplete' | 'conflicting', diagnostics: Diagnostic[]): BindingRefusal {
  return { status, diagnostics }
}

export function refKey(ref: ExternalRecordRef): string {
  return `${ref.kind}\0${ref.scope.repository}\0${ref.scope.target}\0${ref.recordId}`
}

function claimsBinding(operation: DecodedHistory['operations'][number]): boolean {
  return (
    operation.kind === 'workflow-binding' ||
    operation.claimedKinds.includes('workflow-binding') ||
    operation.record?.kind === 'workflow-binding'
  )
}

function successorClaim(
  history: DecodedHistory,
  mandate: ExternalRecordRef,
):
  | { status: 'none' }
  | { status: 'incomplete' | 'conflicting'; diagnostics: Diagnostic[] }
  | { status: 'next'; ref: ExternalRecordRef } {
  const controls = history.operations.filter(
    (operation) =>
      operation.record?.kind === 'operator-control' &&
      operation.record.payload.control === 'select-successor' &&
      sameRef(operation.record.payload.predecessor, mandate),
  )
  if (controls.length === 0) return { status: 'none' }
  if (
    controls.some(
      (operation) =>
        operation.status !== 'complete' || operation.authority !== 'accounted' || operation.record === null,
    )
  ) {
    return bindingRefusal('incomplete', [
      diagnostic('unconfirmed', 'A select-successor claim does not confirm an authorized binding chain'),
    ])
  }
  const refs = controls.flatMap((operation) =>
    operation.record?.kind === 'operator-control' && operation.record.payload.control === 'select-successor'
      ? [operation.record.payload.successor]
      : [],
  )
  const first = refs[0]
  if (first === undefined || first.kind !== 'mandate' || refs.some((ref) => !sameRef(ref, first))) {
    return bindingRefusal('conflicting', [
      diagnostic('conflicting', 'Select-successor controls do not name one mandate'),
    ])
  }
  return { status: 'next', ref: first }
}

function uniqueBindings(bindings: WorkflowBindingRecord[]): BindingCandidate | WorkflowBindingRecord[] {
  const byMandate = new Map<string, WorkflowBindingRecord>()
  for (const binding of bindings) {
    const key = refKey(binding.payload.mandate)
    const prior = byMandate.get(key)
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(binding)) {
      return bindingRefusal('conflicting', [
        diagnostic('conflicting', 'Multiple workflow bindings name the same mandate'),
      ])
    }
    byMandate.set(key, binding)
  }
  return [...byMandate.values()]
}

function successors(
  bindings: WorkflowBindingRecord[],
  histories: readonly DecodedHistory[],
): BindingCandidate | Map<string, string> {
  const next = new Map<string, string>()
  for (const binding of bindings) {
    const home = historyFor(binding.payload.mandate.scope, histories)
    if (home === null || !home.source.complete) {
      return bindingRefusal('incomplete', [
        diagnostic('incomplete', 'Binding mandate history is missing or incomplete'),
      ])
    }
    const successor = successorClaim(home, binding.payload.mandate)
    if (successor.status === 'incomplete' || successor.status === 'conflicting') return successor
    if (successor.status === 'next') {
      const key = refKey(successor.ref)
      if (!bindings.some((candidate) => refKey(candidate.payload.mandate) === key)) {
        return bindingRefusal('incomplete', [
          diagnostic('unconfirmed', 'Authorized successor has no workflow-binding on this PR'),
        ])
      }
      next.set(refKey(binding.payload.mandate), key)
    }
  }
  return next
}

function authorizedHead(
  bindings: WorkflowBindingRecord[],
  next: Map<string, string>,
): BindingCandidate | WorkflowBindingRecord {
  const heads = bindings.filter((binding) => !next.has(refKey(binding.payload.mandate)))
  const head = heads[0]
  if (heads.length !== 1 || head === undefined) {
    return bindingRefusal('conflicting', [
      diagnostic('conflicting', 'Workflow bindings do not form one authorized chain'),
    ])
  }
  return head
}

function onAuthorizedChain(
  bindings: WorkflowBindingRecord[],
  next: Map<string, string>,
  head: WorkflowBindingRecord,
): BindingCandidate | null {
  const headKey = refKey(head.payload.mandate)
  for (const binding of bindings) {
    let cursor = refKey(binding.payload.mandate)
    const seen = new Set<string>()
    while (cursor !== headKey) {
      if (seen.has(cursor))
        return bindingRefusal('conflicting', [diagnostic('conflicting', 'Workflow binding successor chain cycles')])
      seen.add(cursor)
      const step = next.get(cursor)
      if (step === undefined) {
        return bindingRefusal('conflicting', [
          diagnostic('conflicting', 'Workflow binding is outside the authorized chain'),
        ])
      }
      cursor = step
    }
  }
  return null
}

function resolveBindingChain(
  bindings: WorkflowBindingRecord[],
  histories: readonly DecodedHistory[],
): BindingCandidate {
  const unique = uniqueBindings(bindings)
  if (!Array.isArray(unique)) return unique
  const next = successors(unique, histories)
  if (!(next instanceof Map)) return next
  const head = authorizedHead(unique, next)
  if ('status' in head) return head
  const refusal = onAuthorizedChain(unique, next, head)
  if (refusal !== null) return refusal
  return { status: 'bound', binding: head }
}

function invalidClaims(claims: readonly DecodedHistory['operations'][number][]): BindingCandidate | null {
  if (claims.some((operation) => operation.authority === 'foreign')) {
    return bindingRefusal('conflicting', [diagnostic('foreign', 'A foreign workflow-binding is not an absent mandate')])
  }
  if (claims.some((operation) => operation.status === 'conflict')) {
    return bindingRefusal('conflicting', [diagnostic('conflicting', 'Workflow-binding parts conflict')])
  }
  if (
    claims.some(
      (operation) =>
        operation.status !== 'complete' || operation.authority !== 'accounted' || operation.record === null,
    )
  ) {
    return bindingRefusal('incomplete', [
      diagnostic('incomplete', 'A workflow-binding claim is not a complete accounted record'),
    ])
  }
  return null
}

function validatedBindingClaim(
  operation: DecodedHistory['operations'][number],
  input: BindingInput,
): WorkflowBindingRecord | BindingRefusal {
  const record = operation.record
  if (record === null || record.kind !== 'workflow-binding')
    return bindingRefusal('conflicting', [diagnostic('malformed', 'Workflow-binding claim has no binding record')])
  if (!equalScope({ repository: record.repository, target: record.target }, input.pullRequest)) {
    return bindingRefusal('conflicting', [
      diagnostic('unknown-binding', 'Workflow-binding scope is not the pull request'),
    ])
  }
  if (record.payload.mandate.kind !== 'mandate')
    return bindingRefusal('conflicting', [diagnostic('kind-mismatch', 'Workflow binding must name a mandate')])
  if (record.payload.branch !== input.native.branch || record.payload.base !== input.native.base) {
    return bindingRefusal('conflicting', [
      diagnostic('native-mismatch', 'Workflow-binding branch or base does not match the PR'),
    ])
  }
  return record
}

function appendDistinctBinding(records: WorkflowBindingRecord[], record: WorkflowBindingRecord): BindingRefusal | null {
  const prior = records.find((item) => item.recordId === record.recordId)
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(record))
    return bindingRefusal('conflicting', [diagnostic('conflicting', 'Workflow binding has incompatible duplicates')])
  if (prior === undefined) records.push(record)
  return null
}

function recordsForClaims(
  claims: readonly DecodedHistory['operations'][number][],
  input: BindingInput,
): BindingCandidate | WorkflowBindingRecord[] {
  const records: WorkflowBindingRecord[] = []
  for (const operation of claims) {
    const record = validatedBindingClaim(operation, input)
    if ('status' in record) return record
    const duplicate = appendDistinctBinding(records, record)
    if (duplicate !== null) return duplicate
  }
  return records
}

export function selectWorkflowBindingCandidate(input: BindingInput): BindingCandidate {
  const history = historyFor(input.pullRequest, input.histories)
  if (history === null)
    return bindingRefusal('incomplete', [diagnostic('missing-history', 'Pull request history is missing')])
  if (!history.source.complete)
    return bindingRefusal('incomplete', [diagnostic('incomplete', 'Pull request history is incomplete')])
  const claims = history.operations.filter(claimsBinding)
  if (claims.length === 0) return { status: 'absent' }
  const invalid = invalidClaims(claims)
  if (invalid !== null) return invalid
  const records = recordsForClaims(claims, input)
  if (!Array.isArray(records)) return records
  return resolveBindingChain(records, input.histories)
}
