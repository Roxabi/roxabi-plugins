import { resolveCauseDependencyControl } from './cause-dependency-control.ts'
import { readCauseDispositionHeads, resolveCauseSisterReceipt } from './cause-disposition.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import type { CauseWaitResolution, UwWaitProjection, WaitRequirement } from './uw-completion-types.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import { isWayfinder, sameScope, scopeKey, type UwGraphObservation } from './uw-graph.ts'
import { waitCycleDiagnostics } from './uw-wait-cycles.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'

type WaitInput = {
  graph: UwGraphObservation
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
  evaluationRoots?: readonly Scope[]
}

function outgoingWaits(requirements: readonly WaitRequirement[]): Map<string, WaitRequirement[]> {
  const outgoing = new Map<string, WaitRequirement[]>()
  for (const edge of requirements) {
    const key = scopeKey(edge.from)
    const edges = outgoing.get(key) ?? []
    edges.push(edge)
    outgoing.set(key, edges)
  }
  return outgoing
}

function deliveryTargetKeys(input: WaitInput, outgoing: Map<string, WaitRequirement[]>): Set<string> {
  const targets = new Set<string>()
  const queue: Scope[] = [input.graph.root, ...(input.evaluationRoots ?? [])]
  for (const scope of queue) {
    const key = scopeKey(scope)
    if (targets.has(key)) continue
    targets.add(key)
    for (const edge of outgoing.get(key) ?? []) {
      const node = input.graph.nodes.find((candidate) => sameScope(candidate.uw, edge.to))
      if (edge.source.kind !== 'native-child' || !node || !isWayfinder(node)) queue.push(edge.to)
    }
  }
  return targets
}

type CauseDisposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>

function addCauseDisposition(
  disposition: CauseDisposition,
  uw: Scope,
  input: WaitInput,
  causeWaits: CauseWaitResolution[],
  diagnostics: UwDiagnostic[],
  add: (requirement: WaitRequirement) => void,
  problem: (uw: Scope, code: string, message: string) => UwDiagnostic,
): void {
  const outcome = disposition.payload.outcome
  if (outcome.state === 'pending-blocking') {
    diagnostics.push(problem(uw, 'cause-adjudication-required', outcome.reason))
    return
  }
  if (outcome.disposition !== 'sister-blocking') return
  const result = resolveCauseSisterReceipt({ disposition, histories: input.histories })
  if (!result.ok) {
    diagnostics.push(...result.diagnostics.map((d) => problem(uw, d.code, d.message)))
    return
  }
  if (result.value === null) {
    diagnostics.push(problem(uw, 'cause-sister-confirmation-required', 'Blocking sister creation is not confirmed'))
    return
  }
  const dispositionRef = { scope: uw, kind: 'cause-disposition' as const, recordId: disposition.recordId }
  const receipt = { scope: uw, kind: 'debt-receipt' as const, recordId: result.value.recordId }
  const target = result.value.payload.sister
  const resolution = resolveCauseDependencyControl({
    origin: uw,
    disposition: dispositionRef,
    receipt,
    target,
    ...input,
  })
  causeWaits.push(resolution)
  if (resolution.state === 'held') diagnostics.push(...resolution.diagnostics)
  else if (resolution.state === 'required')
    add({
      from: uw,
      to: resolution.target,
      source: { kind: 'blocking-sister', disposition: dispositionRef, receipt, control: resolution.control },
    })
}

export function projectUwWaits(input: WaitInput): UwWaitProjection {
  const requirements: WaitRequirement[] = []
  const causeWaits: CauseWaitResolution[] = []
  const diagnostics: UwDiagnostic[] = []
  const scopes = new Map<string, Scope>()
  const delivery = new Map<string, Scope>()
  const addScope = (scope: Scope) => {
    scopes.set(scopeKey(scope), scope)
  }
  const add = (requirement: WaitRequirement) => {
    requirements.push(requirement)
    addScope(requirement.from)
    addScope(requirement.to)
  }
  const problem = (uw: Scope, code: string, message: string): UwDiagnostic => ({
    code,
    message,
    location: { kind: 'native', uw, connection: 'state' },
    related: [],
  })
  for (const node of input.graph.nodes) {
    addScope(node.uw)
    if (node.parent) addScope(node.parent)
    for (const to of node.children) add({ from: node.uw, to, source: { kind: 'native-child' } })
    for (const to of node.blockers) add({ from: node.uw, to, source: { kind: 'native-blocker' } })
  }
  const addHistoricalScopes = (history: DecodedHistory) => {
    for (const operation of history.operations) {
      if (operation.record?.kind === 'debt-receipt') addScope(operation.record.payload.sister)
      if (
        operation.record?.kind === 'operator-control' &&
        operation.record.payload.control === 'adjust-cause-dependency' &&
        operation.record.payload.proposal.change.kind === 'replace'
      )
        addScope(operation.record.payload.proposal.change.blocker)
    }
  }
  const addAcceptedChildren = (history: DecodedHistory) => {
    const uw = history.source.scope
    const selected = selectedMandate(history)
    if ('kind' in selected && selected.kind === 'mandate') {
      delivery.set(scopeKey(uw), uw)
      const accepted = resolveAcceptedSpec(selected, input.histories)
      if (!accepted.ok) diagnostics.push(...accepted.evidence.map((d) => problem(uw, d.code, d.message)))
      else {
        for (const inherited of accepted.spec.inheritedOwnSpecRefs) addScope(inherited.uw)
        for (const child of accepted.spec.children)
          add({ from: uw, to: child.scope, source: { kind: 'accepted-child', accepted: accepted.spec.ref } })
      }
    }
  }
  const addCauseWaits = (history: DecodedHistory) => {
    const uw = history.source.scope
    if (
      !history.operations.some(
        (operation) => operation.kind === 'cause-disposition' || operation.claimedKinds.includes('cause-disposition'),
      )
    )
      return
    const heads = readCauseDispositionHeads({ uw, histories: input.histories, catalogues: input.catalogues })
    if (!heads.ok) {
      diagnostics.push(...heads.diagnostics.map((d) => problem(uw, d.code, d.message)))
      return
    }
    for (const disposition of heads.value)
      addCauseDisposition(disposition, uw, input, causeWaits, diagnostics, add, problem)
  }
  for (const history of input.histories) {
    addHistoricalScopes(history)
    addAcceptedChildren(history)
    addCauseWaits(history)
  }
  const outgoing = outgoingWaits(requirements)
  diagnostics.push(...waitCycleDiagnostics(requirements))
  const deliveryTargets = deliveryTargetKeys(input, outgoing)
  return {
    requirements,
    causeWaits,
    requiredScopes: [...scopes.values()],
    deliveryScopes: [...delivery.values()].filter((scope) => deliveryTargets.has(scopeKey(scope))),
    diagnostics,
  }
}
