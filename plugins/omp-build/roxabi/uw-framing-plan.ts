import { sameScope } from '../dist/contracts.js'
import type { FramingProposal } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import type { UwRead } from './uw-contract.ts'
import { ancestryMode, type FramingMemberRun } from './uw-framing-executor-check.ts'
import type { FramingStep } from './uw-framing-executor-journal.ts'
import { observation } from './uw-operation-observation.ts'

type Planned = FramingProposal['members'][number]
type MemberInput = FramingProposal['input']['members'][number]
/** Engine-owned classification: a UW carries exactly its approved tier; a Wayfinder exactly its approved label. */
function labelChange(
  input: MemberInput,
  planned: Planned,
  labels: readonly string[],
): { add: string[]; remove: string[] } {
  if (input.kind === 'wayfinder')
    return {
      add: labels.includes(input.label) ? [] : [input.label],
      remove: labels.filter((label) => label.startsWith('wayfinder:') && label !== input.label),
    }
  const tier = `size:${planned.tier}`
  const add = [...new Set([tier, ...input.labels.add])].filter((label) => !labels.includes(label))
  const remove = labels.filter(
    (label) => (label.startsWith('size:') && label !== tier) || input.labels.remove.includes(label),
  )
  return { add, remove }
}

/** Root first; then planned parents and blockers before their dependents, ties by sealed ordinal. */
function memberOrder(proposal: FramingProposal): FramingMemberKey[] {
  const root = proposal.input.root
  const pending = proposal.members.filter((member) => member.key !== root)
  const requires = new Map<FramingMemberKey, Set<FramingMemberKey>>(pending.map((member) => [member.key, new Set()]))
  for (const edge of proposal.input.edges) {
    const [dependent, prerequisite] =
      edge.kind === 'parent-child' ? [edge.child, edge.parent] : [edge.dependent, edge.blocker]
    if (prerequisite !== root) requires.get(dependent)?.add(prerequisite)
  }
  const order: FramingMemberKey[] = [root]
  while (pending.length > 0) {
    const index = pending.findIndex((member) =>
      [...(requires.get(member.key) ?? [])].every((key) => order.includes(key)),
    )
    const next = pending.splice(Math.max(index, 0), 1)[0]
    order.push(next.key)
  }
  return order
}

function observedEdge(proposal: FramingProposal, edge: FramingProposal['input']['edges'][number]): boolean {
  const from = proposal.members.find(
    (member) => member.key === (edge.kind === 'parent-child' ? edge.parent : edge.dependent),
  )
  const to = proposal.members.find(
    (member) => member.key === (edge.kind === 'parent-child' ? edge.child : edge.blocker),
  )
  if (from?.slot.kind !== 'existing' || to?.slot.kind !== 'existing') return false
  const target = to.slot.uw
  const observed = edge.kind === 'parent-child' ? from.slot.observed.children : from.slot.observed.blockers
  return observed.some((scope) => sameScope(scope, target))
}
function ownRecordIds(history: UwRead['histories'][number]): string[] {
  return history.operations.flatMap((operation) =>
    operation.authority !== 'foreign' && operation.record !== null ? [operation.record.recordId] : [],
  )
}

function ledgerHead(read: UwRead | undefined): FramingMemberRun['head'] {
  if (read === undefined) return null
  return read.identity.ok ? read.identity.value.head : null
}

function ownHistory(read: UwRead | undefined): UwRead['histories'][number] | undefined {
  if (read === undefined) return undefined
  const uw = read.uw
  return read.histories.find((history) => sameScope(history.source.scope, uw))
}

function memberRun(
  proposal: FramingProposal,
  planned: Planned,
  input: MemberInput,
  read: UwRead | undefined,
): FramingMemberRun {
  const own = ownHistory(read)
  return {
    planned,
    input,
    ancestry: ancestryMode(proposal, planned),
    scope: planned.slot.kind === 'existing' ? planned.slot.uw : null,
    native: read === undefined ? null : observation(read),
    records: own === undefined ? [] : ownRecordIds(own),
    head: ledgerHead(read),
    binding: null,
    claim: null,
    allocated: null,
    identities: [],
  }
}

function identitySteps(planned: Planned, id: (suffix: string) => string): FramingStep[] {
  const allocation = planned.allocation
  const steps: FramingStep[] = []
  if (allocation === null) return steps
  if (allocation.assignments.length > 0)
    steps.push({ kind: 'publish-identity', effectId: id('identity-allocate'), member: planned.key, event: 'allocate' })
  if (allocation.retirements.length > 0)
    steps.push({
      kind: 'publish-identity',
      effectId: id('identity-retire'),
      member: planned.key,
      event: 'retire-proposed',
    })
  return steps
}

/** create → intent or binding → claim → /2 identity → patch only when changed → classification labels. */
function memberSteps(proposal: FramingProposal, run: FramingMemberRun): FramingStep[] {
  const { planned, input } = run
  const key = planned.key
  const id = (suffix: string) => `${proposal.operationId}:m${planned.ordinal}:${suffix}`
  const steps: FramingStep[] = []
  if (planned.slot.kind === 'new') steps.push({ kind: 'create', effectId: id('create'), member: key })
  steps.push(
    key === proposal.input.root
      ? { kind: 'publish-intent', effectId: id('intent'), member: key }
      : { kind: 'publish-binding', effectId: id('binding'), member: key },
  )
  steps.push({ kind: 'publish-claim', effectId: id('claim'), member: key }, ...identitySteps(planned, id))
  if (run.native !== null && (run.native.body !== planned.renderedBody || run.native.title !== input.title))
    steps.push({ kind: 'patch', effectId: id('patch'), member: key })
  const labels = labelChange(input, planned, run.native?.labels ?? [])
  if (labels.add.length > 0 || labels.remove.length > 0)
    steps.push({ kind: 'labels', effectId: id('labels'), member: key, add: labels.add, remove: labels.remove })
  return steps
}

function edgeSteps(proposal: FramingProposal): FramingStep[] {
  return proposal.input.edges.flatMap((edge, index): FramingStep[] => {
    if (observedEdge(proposal, edge)) return []
    const effectId = `${proposal.operationId}:edge:${index}`
    return [
      edge.kind === 'parent-child'
        ? { kind: 'parent-child', effectId, member: edge.parent, child: edge.child }
        : { kind: 'blocker', effectId, member: edge.dependent, blocker: edge.blocker },
    ]
  })
}

/** Compute the exact effect plan once, from the verified post-confirmation cut. */
export function planFraming(proposal: FramingProposal, reads: ReadonlyMap<FramingMemberKey, UwRead>) {
  const inputs = new Map(proposal.input.members.map((member) => [member.slot.key, member]))
  const members = new Map<FramingMemberKey, FramingMemberRun>()
  for (const planned of proposal.members) {
    const input = inputs.get(planned.key)
    if (input === undefined) throw new Error(`framing-member-input-missing:${planned.key}`)
    members.set(planned.key, memberRun(proposal, planned, input, reads.get(planned.key)))
  }
  const steps = memberOrder(proposal).flatMap((key) => {
    const run = members.get(key)
    return run === undefined ? [] : memberSteps(proposal, run)
  })
  steps.push(...edgeSteps(proposal), {
    kind: 'publish-result',
    effectId: `${proposal.operationId}:result`,
    member: null,
  })
  return { steps, members }
}
