import {
  canonicalValueDigest,
  framingObservationDigest,
  prepareNewSpecAllocation,
  sameScope,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { FramingProposal } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingAggregateInput } from '../engine/uw-framing-schema.ts'
import { checkPlannedAncestry } from './feature-parent-anchor.ts'
import type { UwRead } from './uw-contract.ts'
import { observation } from './uw-operation-observation.ts'
import { nativeIssueObservationDigest, type UwProposalPreparationPorts } from './uw-proposal-preparation.ts'

export type FramingPreparationPorts = UwProposalPreparationPorts & { read(uw: Scope): Promise<UwRead> }
type AggregateMember = FramingAggregateInput['members'][number]
type UwMember = Extract<AggregateMember, { kind: 'uw' }>
type AggregateEdge = FramingAggregateInput['edges'][number]
type ProposalMember = FramingProposal['members'][number]
type MemberPlan = Pick<ProposalMember, 'allocation' | 'tier' | 'renderedBody' | 'inherited'>
function refusal(repository: string, code: string, message: string): UwResult<never> {
  return { ok: false, diagnostics: [{ code, message, location: { kind: 'repository', repository }, related: [] }] }
}
function uwDraftProblem(member: UwMember): [string, string] | null {
  const { add, remove } = member.labels
  if (
    new Set(add).size !== add.length ||
    new Set(remove).size !== remove.length ||
    add.some((label) => remove.includes(label) || label.startsWith('size:') || label.startsWith('wayfinder:'))
  )
    return ['framing-labels-invalid', 'UW labels must not conflict with engine-owned tier or Wayfinder classification']
  if (
    member.draft.criteria.length === 0 ||
    member.draft.openQuestions.length > 0 ||
    Object.values(member.draft.sections).some((value) => !value.trim())
  )
    return ['framing-spec-incomplete', 'Every UW needs criteria, complete sections, and no open questions']
  return null
}

/** Existing members allocate from their authenticated ledger; new members from an empty one. */
function allocate(member: UwMember, read: UwRead | undefined, ports: FramingPreparationPorts) {
  if (member.slot.kind !== 'existing') return prepareNewSpecAllocation(member.draft, member.slot.repository)
  if (read === undefined) return null
  return read.identity.ok ? ports.prepareSpecAllocation(member.draft, read.identity.value) : null
}

function specRendering(
  member: UwMember,
  spec: NonNullable<ProposalMember['allocation']>['spec'],
  ports: FramingPreparationPorts,
  repository: string,
): UwResult<{ tier: NonNullable<ProposalMember['tier']>; renderedBody: string }> {
  try {
    return {
      ok: true,
      value: {
        tier: member.tierOverride?.tier ?? ports.calculateTier(member.factors).tier,
        renderedBody: ports.renderIssueSpecBody(spec),
      },
    }
  } catch (error) {
    return refusal(repository, 'framing-spec-invalid', error instanceof Error ? error.message : String(error))
  }
}

/** Name an ancestry-owner refusal by the framing contract's two codes, keeping the exact owner reason. */
export function framingAncestryDiagnostic(key: string, uw: Scope, parent: Scope | null, reason: string): UwDiagnostic {
  return {
    code:
      reason === 'parent-anchor-commitment-mismatch'
        ? 'framing-parent-commitment-mismatch'
        : 'framing-ancestor-unqualified',
    message: `Slot ${key} (${uw.target}), parent ${parent?.target ?? 'none'}: ${reason}`,
    location: { kind: 'native', uw, connection: 'state' },
    related: [],
  }
}

/** A top-slot existing member authenticates its external accepted ancestry; planned parents seal later. */
async function nativeInheritance(
  aggregate: FramingAggregateInput,
  member: UwMember,
  read: UwRead | undefined,
  planned: { spec: NonNullable<ProposalMember['allocation']>['spec']; tier: NonNullable<ProposalMember['tier']> },
): Promise<UwResult<ProposalMember['inherited']>> {
  if (read === undefined || member.slot.kind !== 'existing') return { ok: true, value: [] }
  const nativeParent = member.slot.observed.nativeParent
  const parentInPlan =
    nativeParent !== null &&
    aggregate.members.some(
      (candidate) => candidate.slot.kind === 'existing' && sameScope(candidate.slot.uw, nativeParent),
    )
  if (parentInPlan) return { ok: true, value: [] }
  const ancestry = await checkPlannedAncestry({ subject: member.slot.uw, read, planned })
  if (!ancestry.ok)
    return {
      ok: false,
      diagnostics: [framingAncestryDiagnostic(member.slot.key, member.slot.uw, nativeParent, ancestry.reason)],
    }
  return { ok: true, value: [...ancestry.inherited] }
}

async function uwPlan(
  aggregate: FramingAggregateInput,
  member: UwMember,
  read: UwRead | undefined,
  ports: FramingPreparationPorts,
  repository: string,
): Promise<UwResult<MemberPlan>> {
  const problem = uwDraftProblem(member)
  if (problem !== null) return refusal(repository, ...problem)
  const allocated = allocate(member, read, ports)
  if (allocated === null)
    return refusal(repository, 'framing-identity-unavailable', 'Existing member identity is unavailable')
  if (!allocated.ok) return allocated
  const allocation = {
    ...allocated.value,
    assignments: [...allocated.value.assignments],
    retirements: [...allocated.value.retirements],
  }
  const rendered = specRendering(member, allocation.spec, ports, repository)
  if (!rendered.ok) return rendered
  const { tier, renderedBody } = rendered.value
  const inherited = await nativeInheritance(aggregate, member, read, { spec: allocation.spec, tier })
  if (!inherited.ok) return inherited
  return { ok: true, value: { allocation, tier, renderedBody, inherited: inherited.value } }
}

function ownHistory(read: UwRead | undefined): UwRead['histories'][number] | undefined {
  if (read === undefined) return undefined
  const uw = read.uw
  return read.histories.find((entry) => sameScope(entry.source.scope, uw))
}

function nativeAnalysis(read: UwRead): ProposalMember['nativeAnalysis'] {
  return {
    status: read.parsed.status,
    analysis: {
      criterionSources: [...read.parsed.analysis.criterionSources],
      invariantSources: [...read.parsed.analysis.invariantSources],
      contentSources: [...read.parsed.analysis.contentSources],
      preservedContent: [...read.parsed.analysis.preservedContent],
    },
    analysisDigest: canonicalValueDigest(read.parsed.analysis),
  }
}

/** Seal one member over its exact native, parser, history, and engagement facts. */
function proposalMember(
  member: AggregateMember,
  ordinal: number,
  read: UwRead | undefined,
  plan: MemberPlan,
): ProposalMember {
  const history = ownHistory(read)
  const observed = read ? observation(read) : null
  const unsealed = {
    key: member.slot.key,
    ordinal,
    slot: member.slot,
    allocation: plan.allocation,
    renderedBody: plan.renderedBody,
    tier: plan.tier,
    inherited: plan.inherited,
    nativeDigest: observed ? nativeIssueObservationDigest(observed) : null,
    nativeAnalysis: read ? nativeAnalysis(read) : null,
    historyDigest: history ? canonicalValueDigest(history) : null,
    engagementDigest: read?.observation.status === 'complete' ? framingObservationDigest(read.observation) : null,
  }
  return { ...unsealed, memberDigest: canonicalValueDigest(unsealed) }
}

export async function planMember(
  aggregate: FramingAggregateInput,
  ordinal: number,
  member: AggregateMember,
  reads: ReadonlyMap<string, UwRead>,
  ports: FramingPreparationPorts,
  repository: string,
): Promise<UwResult<ProposalMember>> {
  const read = reads.get(member.slot.key)
  const plan: UwResult<MemberPlan> =
    member.kind === 'uw'
      ? await uwPlan(aggregate, member, read, ports, repository)
      : { ok: true, value: { allocation: null, tier: null, renderedBody: member.body, inherited: [] } }
  if (!plan.ok) return plan
  return { ok: true, value: proposalMember(member, ordinal, read, plan.value) }
}

/**
 * Planned parent members do not yet have accepted refs; propagate the exact
 * external inherited vector and seal each descendant after its parent.
 */
export function sealInheritance(aggregate: FramingAggregateInput, members: FramingProposal['members']): boolean {
  const resolved = new Set<string>()
  const inherit = (key: string): boolean => {
    if (resolved.has(key)) return true
    const item = members.find((member) => member.key === key)
    if (!item) return false
    const parentEdge = aggregate.edges.find(
      (edge): edge is Extract<AggregateEdge, { kind: 'parent-child' }> =>
        edge.kind === 'parent-child' && edge.child === key,
    )
    if (parentEdge) {
      if (!inherit(parentEdge.parent)) return false
      const parent = members.find((member) => member.key === parentEdge.parent)
      if (!parent) return false
      item.inherited = [...parent.inherited]
    }
    const { memberDigest: _digest, ...unsealed } = item
    item.memberDigest = canonicalValueDigest(unsealed)
    resolved.add(key)
    return true
  }
  return members.every((member) => inherit(member.key))
}
