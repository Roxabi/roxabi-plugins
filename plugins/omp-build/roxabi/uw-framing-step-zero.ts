import { isWayfinder, sameScope, scopeKey } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingAggregateInput } from '../engine/uw-framing-schema.ts'
import type { UwNativeNode } from '../engine/uw-graph.ts'
import type { UwRead } from './uw-contract.ts'

type AggregateMember = FramingAggregateInput['members'][number]
type ExistingSlot = Extract<AggregateMember['slot'], { kind: 'existing' }>
function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
function sameSet(left: readonly Scope[], right: readonly Scope[]): boolean {
  return (
    left.length === right.length &&
    new Set(left.map(scopeKey)).size === left.length &&
    left.every((item) => right.some((other) => sameScope(item, other)))
  )
}
const REFERENCE_TOKEN = /^(?:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)?#)([1-9][0-9]*)$/
function referenceDiagnostics(aggregate: FramingAggregateInput, slot: ExistingSlot): UwDiagnostic[] {
  const { uw, selection } = slot
  const reference = selection.reference
  const bare = selection.kind === 'command' && /^[1-9][0-9]*$/.test(reference)
  const token = REFERENCE_TOKEN.exec(reference)
  const number = bare ? reference : token?.[2]
  const exact =
    number !== undefined &&
    number === uw.target.slice(uw.target.lastIndexOf('#') + 1) &&
    (token?.[1] === undefined || token[1] === uw.repository) &&
    (selection.kind !== 'command' || slot.key === aggregate.root)
  return exact
    ? []
    : [diagnostic(uw, 'framing-reference-invalid', 'The selected operator reference must exactly name this issue')]
}

function ownHistoryDiagnostics(uw: Scope, read: UwRead): UwDiagnostic[] {
  const histories = read.histories.filter((history) => sameScope(history.source.scope, uw))
  const diagnostics: UwDiagnostic[] = []
  if (
    histories.length !== 1 ||
    !histories[0].source.complete ||
    histories[0].source.diagnostics.length > 0 ||
    histories[0].diagnostics.length > 0
  )
    diagnostics.push(diagnostic(uw, 'framing-history-incomplete', 'A unique complete own history is required'))
  else if (
    histories[0].operations.some(
      (operation) =>
        operation.authority !== 'foreign' &&
        (operation.kind === 'mandate' || operation.claimedKinds.includes('mandate')),
    )
  )
    diagnostics.push(diagnostic(uw, 'framing-mandate-present', 'Existing member already has a mandate claim'))
  if (
    histories.length === 1 &&
    histories[0].operations.some((operation) => operation.authority !== 'foreign' && operation.status !== 'complete')
  )
    diagnostics.push(
      diagnostic(uw, 'framing-history-incomplete', 'Own workflow history contains incomplete or damaged records'),
    )
  return diagnostics
}

function stateDiagnostics(uw: Scope, read: UwRead): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  if (read.accepted.status !== 'absent')
    diagnostics.push(diagnostic(uw, 'framing-accepted-present', 'Existing member must have no accepted authority'))
  if (!read.identity.ok) diagnostics.push(...read.identity.diagnostics)
  if (read.admission.aggregate.status !== 'none')
    diagnostics.push(
      diagnostic(uw, 'framing-membership-present', 'Existing member must not already belong to an aggregate'),
    )
  return diagnostics
}

/** A UW never converts an existing Wayfinder; a Wayfinder never converts a sized or allocated UW. */
function classificationDiagnostics(
  member: AggregateMember,
  uw: Scope,
  node: UwNativeNode,
  read: UwRead,
): UwDiagnostic[] {
  if (member.kind === 'uw')
    return isWayfinder(node)
      ? [diagnostic(uw, 'framing-wayfinder-not-uw', 'A Wayfinder cannot be converted into a UW member')]
      : []
  const sized = node.labels.some((label) => label.startsWith('size:'))
  const allocated = read.identity.ok && read.identity.value.allocations.size > 0
  return sized || allocated
    ? [diagnostic(uw, 'framing-uw-not-wayfinder', 'A UW cannot be converted into a tierless Wayfinder')]
    : []
}

function sameParent(left: Scope | null, right: Scope | null): boolean {
  if (left === null || right === null) return left === right
  return sameScope(left, right)
}

function staleDiagnostics(slot: ExistingSlot, node: UwNativeNode): UwDiagnostic[] {
  const selected = slot.observed
  const same =
    node.raw.bodySha256 === slot.sourceBodySha256 &&
    sameParent(node.parent, selected.nativeParent) &&
    sameSet(node.children, selected.children) &&
    sameSet(node.blockers, selected.blockers)
  return same ? [] : [diagnostic(slot.uw, 'framing-native-stale', 'Selected native source or relations have changed')]
}

/** Every observed non-Wayfinder child is selected as a native child and preserved by a planned edge. */
function childProblem(
  aggregate: FramingAggregateInput,
  slot: ExistingSlot,
  read: UwRead,
  child: Scope,
): UwDiagnostic | null {
  const childNode = read.graph.nodes.find((item) => sameScope(item.uw, child))
  if (childNode === undefined)
    return diagnostic(slot.uw, 'framing-child-unreadable', 'An observed child is missing from the complete cut')
  if (isWayfinder(childNode)) return null
  const included = aggregate.members.find(
    (candidate) =>
      candidate.slot.kind === 'existing' &&
      sameScope(candidate.slot.uw, child) &&
      candidate.slot.selection.kind === 'native-child' &&
      candidate.slot.selection.parent === slot.key,
  )
  const preserved =
    included !== undefined &&
    aggregate.edges.some(
      (edge) => edge.kind === 'parent-child' && edge.parent === slot.key && edge.child === included.slot.key,
    )
  return preserved
    ? null
    : diagnostic(
        slot.uw,
        'framing-native-child-unplanned',
        'Every observed non-Wayfinder child must be selected and preserved as a native child',
      )
}

function childDiagnostics(
  aggregate: FramingAggregateInput,
  slot: ExistingSlot,
  read: UwRead,
  node: UwNativeNode,
): UwDiagnostic[] {
  return node.children.flatMap((child) => {
    const problem = childProblem(aggregate, slot, read, child)
    return problem === null ? [] : [problem]
  })
}

function mergeObserved(observed: Map<string, UwNativeNode>, read: UwRead): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  for (const item of read.graph.nodes) {
    const previous = observed.get(scopeKey(item.uw))
    if (previous && JSON.stringify(previous) !== JSON.stringify(item))
      diagnostics.push(diagnostic(item.uw, 'framing-native-conflict', 'Native cuts disagree'))
    else observed.set(scopeKey(item.uw), item)
  }
  return diagnostics
}

/** Step 0 for one existing member; only a unique complete node joins the combined observed graph. */
function existingMemberDiagnostics(
  aggregate: FramingAggregateInput,
  member: AggregateMember,
  slot: ExistingSlot,
  read: UwRead | undefined,
  observed: Map<string, UwNativeNode>,
  scopes: Set<string>,
): UwDiagnostic[] {
  const uw = slot.uw
  const diagnostics = referenceDiagnostics(aggregate, slot)
  const key = scopeKey(uw)
  if (scopes.has(key))
    diagnostics.push(diagnostic(uw, 'framing-scope-duplicate', 'Two members resolve to the same native issue'))
  scopes.add(key)
  if (read?.observation.status !== 'complete' || read.graph.status !== 'complete')
    return [
      ...diagnostics,
      diagnostic(uw, 'framing-observation-incomplete', 'Complete native and workflow observations are required'),
    ]
  diagnostics.push(...ownHistoryDiagnostics(uw, read), ...stateDiagnostics(uw, read))
  const nodes = read.graph.nodes.filter((node) => sameScope(node.uw, uw))
  if (nodes.length !== 1)
    return [...diagnostics, diagnostic(uw, 'framing-node-missing', 'The selected native node must be unique')]
  const node = nodes[0]
  diagnostics.push(
    ...classificationDiagnostics(member, uw, node, read),
    ...staleDiagnostics(slot, node),
    ...childDiagnostics(aggregate, slot, read, node),
    ...mergeObserved(observed, read),
  )
  return diagnostics
}

export function observeFramingStepZero(aggregate: FramingAggregateInput, reads: ReadonlyMap<string, UwRead>) {
  const diagnostics: UwDiagnostic[] = []
  const observed = new Map<string, UwNativeNode>()
  const scopes = new Set<string>()
  for (const member of aggregate.members) {
    if (member.slot.kind !== 'existing') continue
    diagnostics.push(
      ...existingMemberDiagnostics(aggregate, member, member.slot, reads.get(member.slot.key), observed, scopes),
    )
  }
  return { diagnostics, observed }
}
