import { sameScope } from '../dist/contracts.js'
import type { FramingForm } from '../engine/framing-form-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingMemberSlot } from '../engine/uw-framing-schema.ts'
import type { UwNativeNode } from '../engine/uw-graph.ts'
import { framingDiagnostic, type LeaseState, type NativeObservation } from './feature-framing-controller-lease.ts'
import type { UwOperations, UwRead } from './uw-contract.ts'

type ProposalForm = Extract<FramingForm, { kind: 'proposal' }>
type ModelMember = ProposalForm['aggregate']['members'][number]
type Problem = { problem: UwDiagnostic }
const REFERENCE = /^(?:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)?#)([1-9][0-9]*)$/
export function nodeOf(read: UwRead, uw: Scope): UwNativeNode | null {
  if (read.graph.status !== 'complete') return null
  return read.graph.nodes.find((node) => sameScope(node.uw, uw)) ?? null
}

export function observationOf(node: UwNativeNode): NativeObservation {
  return Object.freeze({ nativeParent: node.parent, children: [...node.children], blockers: [...node.blockers] })
}
type Resolution = { slot: FramingMemberSlot; observed: NativeObservation | null }

async function existingChild(
  lease: LeaseState,
  uw: UwOperations,
  parent: Resolution,
  slot: Extract<ModelMember['slot'], { kind: 'native-child' }>,
): Promise<Resolution | Problem> {
  const token = REFERENCE.exec(slot.reference)
  if (parent.slot.kind !== 'existing' || parent.observed === null || token === null)
    return {
      problem: framingDiagnostic(
        lease,
        'framing-native-child-invalid',
        `Native child ${slot.key} must name an observed child of an existing member`,
      ),
    }
  const repository = token[1] ?? parent.slot.uw.repository
  const child = parent.observed.children.find(
    (item) => item.repository === repository && item.target === `${repository}#${token[2]}`,
  )
  if (!child)
    return {
      problem: framingDiagnostic(
        lease,
        'framing-native-child-unobserved',
        `${slot.reference} is not an observed child of ${slot.parent}`,
      ),
    }
  const read = await uw.readUw(child)
  const node = nodeOf(read, child)
  if (node === null)
    return {
      problem: framingDiagnostic(
        lease,
        'framing-native-child-unreadable',
        `${slot.reference} needs one complete native observation`,
      ),
    }
  const observed = observationOf(node)
  return {
    slot: {
      kind: 'existing',
      key: slot.key,
      uw: child,
      sourceBodySha256: node.raw.bodySha256,
      selection: { kind: 'native-child', parent: slot.parent, reference: slot.reference },
      observed: { ...observed, children: [...observed.children], blockers: [...observed.blockers] },
    },
    observed,
  }
}

type IssueSourceNode = { node: UwNativeNode } | null

/** A selected slot is either the command issue root or an operator-text selection; nothing else. */
function selectedResolution(
  lease: LeaseState,
  aggregate: ProposalForm['aggregate'],
  key: string,
  source: IssueSourceNode,
): Resolution | Problem {
  if (lease.source.kind === 'issue' && key === aggregate.root && source !== null) {
    const observed = observationOf(source.node)
    return {
      slot: {
        kind: 'existing',
        key,
        uw: lease.source.uw,
        sourceBodySha256: source.node.raw.bodySha256,
        selection: { kind: 'command', reference: lease.source.uw.target },
        observed: { ...observed, children: [...observed.children], blockers: [...observed.blockers] },
      },
      observed,
    }
  }
  const selection = lease.selections.find((item) => item.key === key)
  if (!selection)
    return {
      problem: framingDiagnostic(lease, 'framing-slot-unselected', `Slot ${key} was not selected from operator text`),
    }
  return {
    slot: {
      kind: 'existing',
      key,
      uw: selection.uw,
      sourceBodySha256: selection.sourceBodySha256,
      selection: selection.selection,
      observed: {
        ...selection.observed,
        children: [...selection.observed.children],
        blockers: [...selection.observed.blockers],
      },
    },
    observed: selection.observed,
  }
}

/** One member's slot, or null while a native child's parent is still unresolved. */
async function memberResolution(
  lease: LeaseState,
  aggregate: ProposalForm['aggregate'],
  member: ModelMember,
  resolved: ReadonlyMap<string, Resolution>,
  uw: UwOperations,
  source: IssueSourceNode,
  repository: string,
): Promise<Resolution | Problem | null> {
  const slot = member.slot
  if (slot.kind === 'new') return { slot: { kind: 'new', key: slot.key, repository }, observed: null }
  if (slot.kind === 'selected') return selectedResolution(lease, aggregate, slot.key, source)
  const parent = resolved.get(slot.parent)
  return parent ? existingChild(lease, uw, parent, slot) : null
}

/** Host-resolved slots: the model names keys and operator tokens; every Scope comes from host reads. */
export async function resolveSlots(
  lease: LeaseState,
  aggregate: ProposalForm['aggregate'],
  uw: UwOperations,
  source: IssueSourceNode,
): Promise<Map<string, FramingMemberSlot> | Problem> {
  const resolved = new Map<string, Resolution>()
  const repository = lease.repository
  if (repository === null)
    return {
      problem: framingDiagnostic(lease, 'framing-repository-unavailable', 'The source repository is unresolved'),
    }
  let pending = [...aggregate.members]
  while (pending.length > 0) {
    const next: ModelMember[] = []
    for (const member of pending) {
      const resolution = await memberResolution(lease, aggregate, member, resolved, uw, source, repository)
      if (resolution === null) next.push(member)
      else if ('problem' in resolution) return resolution
      else resolved.set(member.slot.key, resolution)
    }
    if (next.length === pending.length)
      return {
        problem: framingDiagnostic(
          lease,
          'framing-native-child-invalid',
          'Every native child must name a resolvable parent member',
        ),
      }
    pending = next
  }
  return new Map([...resolved].map(([key, value]) => [key, value.slot]))
}
