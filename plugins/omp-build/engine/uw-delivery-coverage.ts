import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import { bindingPolicy } from './workflow-binding-policy.ts'
import { bindExternalRef, type MandateRecord, successorClaim, workflowOperationProblem } from './workflow-control.ts'

export type DeliveryCoverage =
  | { ok: true; branches: string[]; uncovered: boolean }
  | { ok: false; diagnostics: Diagnostic[] }

function refused(message: string): Extract<DeliveryCoverage, { ok: false }> {
  return { ok: false, diagnostics: [{ code: 'legacy-coverage-incomplete', message }] }
}

type MandatePosition = { record: MandateRecord; first: number; last: number }
type Operations = DecodedHistory['operations']
type CoverageFailure = Extract<DeliveryCoverage, { ok: false }>

function collectMandates(
  home: DecodedHistory,
  operations: Operations,
): { ok: true; mandates: MandatePosition[] } | CoverageFailure {
  const mandates: MandatePosition[] = []
  for (const operation of operations) {
    if (operation.record?.kind !== 'mandate') continue
    if (operation.status !== 'complete' || operation.authority !== 'accounted')
      return refused('UW mandate is not accounted')
    const record = operation.record
    const authenticated = bindExternalRef(
      { scope: home.source.scope, kind: 'mandate', recordId: record.recordId },
      home,
    )
    if (!authenticated.ok) return refused(`UW mandate ${record.recordId} is not authenticated`)
    const indexes = operation.parts.map((part) =>
      home.source.comments.findIndex((comment) => comment.locator === part.locator),
    )
    if (indexes.length === 0 || indexes.some((index) => index < 0)) return refused('UW mandate ordering is incomplete')
    if (bindingPolicy(record) === 'unknown') return refused(`UW mandate ${record.recordId} has an unknown policy`)
    mandates.push({ record, first: Math.min(...indexes), last: Math.max(...indexes) })
  }
  return { ok: true, mandates }
}

function validateControls(
  home: DecodedHistory,
  operations: Operations,
  byId: Map<string, MandateRecord>,
): CoverageFailure | null {
  for (const operation of operations) {
    const control = operation.record
    if (control?.kind !== 'operator-control' || control.payload.control !== 'select-successor') continue
    const predecessor = control.payload.predecessor
    if (
      operation.status !== 'complete' ||
      operation.authority !== 'accounted' ||
      predecessor.kind !== 'mandate' ||
      !equalScope(predecessor.scope, home.source.scope) ||
      !byId.has(predecessor.recordId) ||
      !bindExternalRef({ scope: home.source.scope, kind: 'operator-control', recordId: control.recordId }, home).ok
    )
      return refused('UW successor control is incomplete or unauthenticated')
  }
  return null
}

function collectSuccessors(
  home: DecodedHistory,
  mandates: MandatePosition[],
  byId: Map<string, MandateRecord>,
): { ok: true; successors: Map<string, string> } | CoverageFailure {
  const successors = new Map<string, string>()
  for (const { record } of mandates) {
    const claim = successorClaim(home, { scope: home.source.scope, recordId: record.recordId, kind: 'mandate' })
    if (claim.status === 'none') continue
    if (
      claim.status !== 'next' ||
      claim.ref.kind !== 'mandate' ||
      !equalScope(claim.ref.scope, home.source.scope) ||
      !byId.has(claim.ref.recordId)
    )
      return refused('UW mandate successor chain is incomplete or conflicting')
    successors.set(record.recordId, claim.ref.recordId)
  }
  return { ok: true, successors }
}

function validateLineage(
  home: DecodedHistory,
  mandates: MandatePosition[],
  byId: Map<string, MandateRecord>,
  successors: Map<string, string>,
): CoverageFailure | null {
  if (mandates.length === 0) return null
  const tips = mandates.filter(({ record }) => !successors.has(record.recordId))
  if (tips.length !== 1) return refused('UW home has multiple or missing mandate lineage tips')
  const visited = new Set<string>()
  let current: MandateRecord | undefined = tips[0]?.record
  while (current !== undefined) {
    if (visited.has(current.recordId)) return refused('UW mandate lineage contains a cycle')
    visited.add(current.recordId)
    const antecedent = current.payload.antecedent
    if (antecedent === null) break
    if (
      antecedent.kind !== 'mandate' ||
      !equalScope(antecedent.scope, home.source.scope) ||
      successors.get(antecedent.recordId) !== current.recordId
    )
      return refused('UW mandate lineage has an unconfirmed antecedent')
    current = byId.get(antecedent.recordId)
    if (current === undefined) return refused('UW mandate lineage has a missing antecedent')
  }
  if (visited.size !== mandates.length) return refused('UW mandate history contains an orphan or competing lineage')
  return null
}

function controlBoundary(
  home: DecodedHistory,
  operation: Operations[number],
  mandates: MandatePosition[],
): { ok: true; boundary: number | null } | CoverageFailure {
  const control = operation.record
  if (control?.kind !== 'operator-control' || control.payload.control !== 'select-successor')
    return { ok: true, boundary: null }
  const payload = control.payload
  if (operation.status !== 'complete' || operation.authority !== 'accounted')
    return refused('Successor control is not accounted')
  const successor = mandates.find(
    ({ record }) =>
      record.recordId === payload.successor.recordId && equalScope(payload.successor.scope, home.source.scope),
  )
  if (successor === undefined || bindingPolicy(successor.record) !== 'bounded') return { ok: true, boundary: null }
  const predecessor = payload.predecessor
  if (
    predecessor.kind !== 'mandate' ||
    !equalScope(predecessor.scope, home.source.scope) ||
    successor.record.payload.antecedent === null ||
    !sameRef(successor.record.payload.antecedent, predecessor) ||
    !sameRef(payload.mandate, predecessor) ||
    !mandates.some(({ record }) => record.recordId === predecessor.recordId)
  )
    return refused('Successor coverage control has inconsistent ancestry')
  const claim = successorClaim(home, predecessor)
  const authenticated = bindExternalRef(
    { scope: home.source.scope, kind: 'operator-control', recordId: control.recordId },
    home,
  )
  if (!authenticated.ok || claim.status !== 'next' || !sameRef(claim.ref, payload.successor))
    return refused('Successor coverage control is not authenticated')
  const indexes = operation.parts.map((part) =>
    home.source.comments.findIndex((comment) => comment.locator === part.locator),
  )
  if (indexes.length === 0 || indexes.some((index) => index < 0))
    return refused('Successor control ordering is incomplete')
  if (successor.last >= Math.min(...indexes)) return refused('Successor mandate does not precede coverage control')
  return { ok: true, boundary: successor.first }
}

function findBoundary(
  home: DecodedHistory,
  operations: Operations,
  mandates: MandatePosition[],
): { ok: true; boundary: number | null } | CoverageFailure {
  let boundary: number | null = null
  for (const operation of operations) {
    const result = controlBoundary(home, operation, mandates)
    if (!result.ok) return result
    if (result.boundary !== null) boundary = boundary === null ? result.boundary : Math.min(boundary, result.boundary)
  }
  return { ok: true, boundary }
}

/** A new-policy successor control certifies rediscoverability, not completion of its PR rebinding. */
export function deliveryCoverage(home: DecodedHistory): DeliveryCoverage {
  if (workflowOperationProblem(home) !== null) return refused('UW home history is incomplete or ambiguous')
  const operations = home.operations.filter((operation) => operation.authority !== 'foreign')
  const collected = collectMandates(home, operations)
  if (!collected.ok) return collected
  const mandates = collected.mandates
  const byId = new Map(mandates.map(({ record }) => [record.recordId, record]))
  const controlProblem = validateControls(home, operations, byId)
  if (controlProblem !== null) return controlProblem
  const successors = collectSuccessors(home, mandates, byId)
  if (!successors.ok) return successors
  const lineageProblem = validateLineage(home, mandates, byId, successors.successors)
  if (lineageProblem !== null) return lineageProblem
  const branches = [
    ...new Set(mandates.flatMap(({ record }) => (record.payload.branch === null ? [] : [record.payload.branch]))),
  ]
  const legacy = mandates.filter(({ record }) => bindingPolicy(record) === 'legacy')
  if (legacy.length === 0) return { ok: true, branches, uncovered: false }
  const coverageBoundary = findBoundary(home, operations, mandates)
  if (!coverageBoundary.ok) return coverageBoundary
  const boundary = coverageBoundary.boundary
  if (boundary === null) return { ok: true, branches, uncovered: true }
  if (legacy.some(({ last }) => last >= boundary)) return refused('Legacy mandate appears after the coverage boundary')
  return { ok: true, branches, uncovered: false }
}
