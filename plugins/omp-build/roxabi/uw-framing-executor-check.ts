import type { IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { canonicalValueDigest, framingObservationDigest, sameScope } from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { FramingProposal, FramingReceiptRef } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import { checkPlannedAncestry } from './feature-parent-anchor.ts'
import type { UwRead } from './uw-contract.ts'
import { sealFramingMaterial } from './uw-framing-material.ts'
import { framingAncestryDiagnostic } from './uw-framing-member-plan.ts'
import { validateFramingNativeCut } from './uw-framing-native-cut.ts'
import { buildFramingSourceBinding } from './uw-framing-prepare.ts'
import { observation } from './uw-operation-observation.ts'
import { nativeIssueObservationDigest } from './uw-proposal-preparation.ts'

type PlannedMember = FramingProposal['members'][number]
type MemberInput = FramingProposal['input']['members'][number]

/**
 * The expected state of one member, advanced only by this aggregate's confirmed
 * effects. `ancestry` is `sealed` when prepare sealed the inherited vector from
 * the member's own authenticated ancestry walk, `checked` when that walk ran but
 * the vector is inherited from a planned parent, and `none` otherwise.
 */
export type FramingMemberRun = {
  readonly planned: PlannedMember
  readonly input: MemberInput
  readonly ancestry: 'sealed' | 'checked' | 'none'
  scope: Scope | null
  native: IssueWriteObservation | null
  records: string[]
  head: ExternalRecordRef | null
  binding: FramingReceiptRef | null
  claim: FramingReceiptRef | null
  allocated: ExternalRecordRef | null
  identities: ExternalRecordRef[]
}

export type FramingRunState = {
  readonly proposal: FramingProposal
  readonly members: ReadonlyMap<FramingMemberKey, FramingMemberRun>
  intent: FramingReceiptRef | null
}

export function nativeDiagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

export function sameRecordRef(left: ExternalRecordRef | null, right: ExternalRecordRef | null): boolean {
  if (left === null || right === null) return left === right
  return sameScope(left.scope, right.scope) && left.recordId === right.recordId && left.kind === right.kind
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nativeParentInPlan(proposal: FramingProposal, member: PlannedMember): boolean {
  if (member.slot.kind !== 'existing' || member.slot.observed.nativeParent === null) return false
  const parent = member.slot.observed.nativeParent
  return proposal.members.some(
    (candidate) => candidate.slot.kind === 'existing' && sameScope(candidate.slot.uw, parent),
  )
}

/** Mirror prepare: only an existing UW whose native parent is outside the plan ran its own ancestry walk. */
export function ancestryMode(proposal: FramingProposal, member: PlannedMember): FramingMemberRun['ancestry'] {
  if (member.slot.kind !== 'existing' || member.allocation === null || nativeParentInPlan(proposal, member))
    return 'none'
  return proposal.input.edges.some((edge) => edge.kind === 'parent-child' && edge.child === member.key)
    ? 'checked'
    : 'sealed'
}

export async function ancestryDiagnostics(
  member: PlannedMember,
  mode: FramingMemberRun['ancestry'],
  uw: Scope,
  read: UwRead,
): Promise<readonly UwDiagnostic[]> {
  if (mode === 'none' || member.allocation === null || member.tier === null) return []
  const ancestry = await checkPlannedAncestry({
    subject: uw,
    read,
    planned: { spec: member.allocation.spec, tier: member.tier },
  })
  if (!ancestry.ok) {
    const parent = member.slot.kind === 'existing' ? member.slot.observed.nativeParent : null
    return [framingAncestryDiagnostic(member.key, uw, parent, ancestry.reason)]
  }
  if (mode === 'sealed' && canonicalValueDigest([...ancestry.inherited]) !== canonicalValueDigest(member.inherited))
    return [
      nativeDiagnostic(uw, 'framing-native-graph-drift', 'The inherited accepted ancestry changed after preparation'),
    ]
  return []
}

async function readExisting(
  proposal: FramingProposal,
  read: (uw: Scope) => Promise<UwRead>,
): Promise<UwResult<Map<FramingMemberKey, UwRead>>> {
  const reads = new Map<FramingMemberKey, UwRead>()
  for (const member of proposal.members) {
    if (member.slot.kind !== 'existing') continue
    try {
      reads.set(member.key, await read(member.slot.uw))
    } catch (error) {
      return { ok: false, diagnostics: [nativeDiagnostic(member.slot.uw, 'framing-read-unavailable', message(error))] }
    }
  }
  return { ok: true, value: reads }
}

/** Sealed native, history, engagement, parser and ledger digests of one existing member. */
function digestStaleness(member: PlannedMember, uw: Scope, current: UwRead): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  const native = observation(current)
  const own = current.histories.filter((history) => sameScope(history.source.scope, uw))
  if (native === null || nativeIssueObservationDigest(native) !== member.nativeDigest)
    diagnostics.push(nativeDiagnostic(uw, 'framing-native-stale', 'Native facts changed after preparation'))
  if (own.length !== 1 || canonicalValueDigest(own[0]) !== member.historyDigest)
    diagnostics.push(nativeDiagnostic(uw, 'framing-history-stale', 'Own workflow history changed after preparation'))
  if (
    current.observation.status !== 'complete' ||
    framingObservationDigest(current.observation) !== member.engagementDigest
  )
    diagnostics.push(
      nativeDiagnostic(
        uw,
        'framing-engagement-stale',
        'Engagement, registry, or procedure observation changed after preparation',
      ),
    )
  if (
    member.nativeAnalysis === null ||
    current.parsed.status !== member.nativeAnalysis.status ||
    canonicalValueDigest(current.parsed.analysis) !== member.nativeAnalysis.analysisDigest
  )
    diagnostics.push(nativeDiagnostic(uw, 'framing-parser-stale', 'Parser analysis changed after preparation'))
  if (
    member.allocation !== null &&
    (!current.identity.ok || !sameRecordRef(current.identity.value.head, member.allocation.ledgerHead))
  )
    diagnostics.push(nativeDiagnostic(uw, 'framing-identity-stale', 'Identity ledger head changed after preparation'))
  return diagnostics
}

function sourceStaleness(
  aggregate: FramingProposal['input'],
  reads: ReadonlyMap<FramingMemberKey, UwRead>,
): UwDiagnostic[] {
  const source = aggregate.source
  if (source.kind !== 'issue') return []
  const rootRead = reads.get(aggregate.root)
  if (rootRead === undefined)
    return [nativeDiagnostic(source.uw, 'framing-source-unavailable', 'The issue source root was not read')]
  const current = buildFramingSourceBinding(rootRead, source.materials)
  if (!current.ok) return [...current.diagnostics]
  return canonicalValueDigest(current.value) === canonicalValueDigest(source)
    ? []
    : [
        nativeDiagnostic(
          source.uw,
          'framing-source-stale',
          'Source, parser, native, ledger, history, or engagement facts changed',
        ),
      ]
}

function materialStaleness(proposal: FramingProposal, repository: string): UwDiagnostic[] {
  const captures = proposal.input.source.materials
  const mismatch = (text: string): UwDiagnostic => ({
    code: 'normalization-material-capture-mismatch',
    message: text,
    location: { kind: 'repository', repository },
    related: [],
  })
  const diagnostics: UwDiagnostic[] = []
  for (const [index, capture] of captures.entries()) {
    const sealed = sealFramingMaterial(capture, repository)
    const expected = proposal.materials[index]
    if (!sealed.ok) diagnostics.push(...sealed.diagnostics)
    else if (
      expected === undefined ||
      canonicalValueDigest({ ...sealed.value, conversion: expected.conversion }) !== canonicalValueDigest(expected)
    )
      diagnostics.push(mismatch('A material seal changed after preparation'))
  }
  if (proposal.materials.length !== captures.length)
    diagnostics.push(mismatch('Sealed materials do not match the captured source'))
  return diagnostics
}

/**
 * Re-establish every sealed precondition from fresh complete reads: Step 0 and
 * the combined graph, native/history/engagement/parser/ledger digests, the issue
 * source binding, material seals, and authenticated top-slot inheritance.
 */
export async function verifySealedCut(
  proposal: FramingProposal,
  read: (uw: Scope) => Promise<UwRead>,
): Promise<UwResult<ReadonlyMap<FramingMemberKey, UwRead>>> {
  const aggregate = proposal.input
  const repository = aggregate.source.kind === 'issue' ? aggregate.source.uw.repository : aggregate.source.repository
  const reads = await readExisting(proposal, read)
  if (!reads.ok) return reads
  const cut = validateFramingNativeCut({ aggregate, reads: reads.value })
  if (!cut.ok) return cut
  const diagnostics: UwDiagnostic[] = []
  for (const member of proposal.members) {
    const current = reads.value.get(member.key)
    if (member.slot.kind !== 'existing' || current === undefined) continue
    const uw = member.slot.uw
    diagnostics.push(...digestStaleness(member, uw, current))
    diagnostics.push(...(await ancestryDiagnostics(member, ancestryMode(proposal, member), uw, current)))
  }
  diagnostics.push(...sourceStaleness(aggregate, reads.value), ...materialStaleness(proposal, repository))
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: reads.value }
}
