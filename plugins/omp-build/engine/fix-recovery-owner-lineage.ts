import { canonicalValueDigest } from './action-input.ts'
import type { RecoveryRef } from './fix-recovery-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'

type Owner = Extract<CanonicalRecord, { kind: 'fix-owner' }>
type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>
type Opening = Owner & { payload: Extract<Owner['payload'], { phase: 'opened' }> }
type Settlement = Owner & { payload: Extract<Owner['payload'], { phase: 'settled' }> }
export type RecoveryOwnerLineage = {
  links: { opening: Opening; settlement: Settlement | null; control: Control | null }[]
}

const fail = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('ambiguous', 'Recovery owner lineage is not uniquely linear')],
})
const controlRef = (control: Control): RecoveryRef => ({
  kind: 'fix-recovery',
  scope: { repository: control.repository, target: control.target },
  recordId: control.recordId,
})
const openingRef = (opening: Opening) => ({
  kind: 'fix-owner',
  scope: { repository: opening.repository, target: opening.target },
  recordId: opening.recordId,
})

function validOpening(opening: Opening): boolean {
  const owner = opening.payload.common.owner
  return (
    equalScope(owner.scope, opening) &&
    owner.recordId === opening.recordId &&
    owner.operationId === opening.operationId &&
    owner.runId === opening.runId
  )
}

function successor(candidate: Opening, control: Control, ref: RecoveryRef): boolean {
  const intent = candidate.payload.intent
  if (intent.kind === 'fresh-intake')
    return control.payload.phase !== 'adopt-decision' && intent.afterClose !== null && sameRef(intent.afterClose, ref)
  if (control.payload.phase !== 'adopt-decision' || !sameRef(intent.recovery, ref)) return false
  const claim = control.payload.claimReservation
  const owner = candidate.payload.common.owner
  return (
    equalScope(claim.scope, owner.scope) &&
    claim.kind === owner.kind &&
    claim.runId === owner.runId &&
    claim.operationId === owner.operationId &&
    claim.recordId === owner.recordId &&
    canonicalValueDigest(intent.source) === canonicalValueDigest(control.payload.target.source) &&
    canonicalValueDigest(intent.request) === canonicalValueDigest(control.payload.target.request) &&
    canonicalValueDigest(intent.decision) === canonicalValueDigest(control.payload.target.decision)
  )
}

function validControl(control: Control, settlement: Settlement | null, predecessor: RecoveryRef | null): boolean {
  if (
    settlement === null ||
    !sameRef(control.payload.settled, {
      kind: 'fix-owner',
      scope: { repository: settlement.repository, target: settlement.target },
      recordId: settlement.recordId,
    })
  )
    return false
  return predecessor === null
    ? control.payload.predecessor === null
    : control.payload.predecessor !== null && sameRef(predecessor, control.payload.predecessor)
}
function matchLink(
  current: Opening,
  settlements: Settlement[],
  controls: readonly Control[],
  predecessor: RecoveryRef | null,
): Result<RecoveryOwnerLineage['links'][number]> {
  const matchingSettlements = settlements.filter((settlement) =>
    sameRef(settlement.payload.opened, openingRef(current)),
  )
  if (matchingSettlements.length > 1) return fail()
  const settlement = matchingSettlements[0] ?? null
  if (settlement !== null && (settlement.runId !== current.runId || !equalScope(settlement, current))) return fail()
  const matchingControls = controls.filter((control) => sameRef(control.payload.opened, openingRef(current)))
  if (matchingControls.length > 1) return fail()
  const control = matchingControls[0] ?? null
  if (control !== null && !validControl(control, settlement, predecessor)) return fail()
  return { ok: true, value: { opening: current, settlement, control } }
}

function walkRoot(
  root: Opening,
  openings: Opening[],
  settlements: Settlement[],
  controls: readonly Control[],
  visited: Set<Opening>,
  usedSettlements: Set<Settlement>,
  usedControls: Set<Control>,
): Result<RecoveryOwnerLineage['links']> {
  const links: RecoveryOwnerLineage['links'] = []
  let opening: Opening | undefined = root
  let predecessor: RecoveryRef | null = null
  while (opening !== undefined) {
    const current = opening
    if (visited.has(current)) return fail()
    visited.add(current)
    const matched = matchLink(current, settlements, controls, predecessor)
    if (!matched.ok) return matched
    const { settlement, control } = matched.value
    if (settlement !== null) usedSettlements.add(settlement)
    if (control !== null) usedControls.add(control)
    links.push(matched.value)
    if (control === null) break
    const ref = controlRef(control)
    const next = openings.filter((candidate) => successor(candidate, control, ref))
    if (next.length > 1) return fail()
    predecessor = ref
    opening = next[0]
  }
  return { ok: true, value: links }
}

/** Resolve links only after the caller has authenticated each owner and replayed each control. */
export function linkAuthenticatedRecoveryOwners(
  owners: readonly Owner[],
  controls: readonly Control[],
  isTerminal: (opening: Owner) => boolean,
): Result<RecoveryOwnerLineage> {
  const openings = owners.filter((owner): owner is Opening => owner.payload.phase === 'opened')
  const settlements = owners.filter((owner): owner is Settlement => owner.payload.phase === 'settled')
  if (openings.some((opening) => !validOpening(opening))) return fail()
  const roots = openings.filter(
    (opening) => opening.payload.intent.kind === 'fresh-intake' && opening.payload.intent.afterClose === null,
  )
  const visited = new Set<Opening>()
  const usedSettlements = new Set<Settlement>()
  const usedControls = new Set<Control>()
  const active: RecoveryOwnerLineage['links'][] = []
  for (const root of roots) {
    const walked = walkRoot(root, openings, settlements, controls, visited, usedSettlements, usedControls)
    if (!walked.ok) return walked
    const last = walked.value.at(-1)
    if (last === undefined) return fail()
    if (last.settlement !== null || last.control !== null || !isTerminal(last.opening)) active.push(walked.value)
  }
  if (
    visited.size !== openings.length ||
    usedSettlements.size !== settlements.length ||
    usedControls.size !== controls.length ||
    active.length > 1
  )
    return fail()
  return { ok: true, value: { links: active[0] ?? [] } }
}
