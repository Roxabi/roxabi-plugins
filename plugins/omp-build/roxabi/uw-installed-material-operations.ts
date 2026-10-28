import { randomUUID } from 'node:crypto'
import type { GitHubOptions } from '../dist/contracts.js'
import {
  buildMaterialAcceptanceControl,
  prepareMaterialAcceptance,
  publishConfirmedWorkflowRecord,
  readComposedWorkflowHistory,
  recheckMaterialAcceptance,
  resolveOwnSpecAuthority,
  sameCurrentAssessedState,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OwnSpecAuthority } from '../engine/workflow-mandate-admission.ts'
import type { PreparedMaterialAcceptance } from '../engine/workflow-spec-assessment.ts'
import { createInstalledMaterialAcceptance } from './material-acceptance-service.ts'
import type { OperatorPort, UwOperationResult, UwRead, UwReadPort } from './uw-contract.ts'
import { type CurrentOwnSpecFacts, readCurrentOwnSpecFacts } from './uw-current-facts.ts'
import { UwGraphUnavailableError } from './uw-read-port.ts'

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function diagnostics(uw: Scope, values: readonly { code?: unknown; message?: unknown }[]): readonly UwDiagnostic[] {
  return values.map((value) =>
    diagnostic(
      uw,
      typeof value.code === 'string' ? value.code : 'uw-publication-unconfirmed',
      typeof value.message === 'string' ? value.message : 'UW publication was not confirmed',
    ),
  )
}
function postEffectDiagnostics(uw: Scope, error: unknown): readonly UwDiagnostic[] {
  if (error instanceof UwGraphUnavailableError) return error.diagnostics
  return [
    diagnostic(
      uw,
      'post-effect-read-failed',
      error instanceof Error ? error.message : 'UW read failed after durable effects',
    ),
  ]
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function sameRecord(
  left: { scope: Scope; recordId: string; kind: string } | null,
  right: { scope: Scope; recordId: string; kind: string },
): boolean {
  return (
    left !== null && sameScope(left.scope, right.scope) && left.recordId === right.recordId && left.kind === right.kind
  )
}

function sameRecords(
  left: readonly { scope: Scope; recordId: string; kind: string }[],
  right: readonly { scope: Scope; recordId: string; kind: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => {
      const candidate = right[index]
      return candidate !== undefined && sameRecord(ref, candidate)
    })
  )
}

function materialAuthority(
  uw: Scope,
  histories: readonly DecodedHistory[],
  currentSpec: CurrentOwnSpecFacts['currentSpec'],
): { ok: true; value: OwnSpecAuthority } | { ok: false; diagnostics: readonly UwDiagnostic[] } {
  const home = histories.find((history) => sameScope(history.source.scope, uw))
  if (home === undefined)
    return { ok: false, diagnostics: [diagnostic(uw, 'history-missing', 'Own UW history is absent')] }
  const authority = resolveOwnSpecAuthority(
    home,
    histories.filter((history) => history !== home),
  )
  if (!authority.ok) return { ok: false, diagnostics: diagnostics(uw, authority.diagnostics) }
  const parent = authority.value.mandate.payload.parent
  if (parent === null) return { ok: true, value: authority.value }
  const parentHistory = histories.find((history) => sameScope(history.source.scope, parent.scope))
  if (parentHistory === undefined)
    return {
      ok: false,
      diagnostics: [diagnostic(uw, 'missing-history', 'Parent mandate history is unavailable for Spec control')],
    }
  const parentAuthority = resolveOwnSpecAuthority(
    parentHistory,
    histories.filter((history) => history !== parentHistory),
  )
  if (!parentAuthority.ok) return { ok: false, diagnostics: diagnostics(uw, parentAuthority.diagnostics) }
  const commitment = parentAuthority.value.accepted.children.find((entry) => sameScope(entry.scope, uw))
  if (
    commitment === undefined ||
    commitment.specVersion !== currentSpec.snapshot.spec.version ||
    commitment.tier !== currentSpec.tier
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          uw,
          'parent-commitment-mismatch',
          'Current proposed Spec does not match the parent’s current accepted child commitment',
        ),
      ],
    }
  return { ok: true, value: authority.value }
}
async function readMaterialPublication(
  prepared: PreparedMaterialAcceptance,
  recordId: string,
  reader: UwReadPort,
): Promise<UwOperationResult> {
  const uw = prepared.proposal.uw
  let reread: UwRead
  try {
    reread = await reader.readUw(uw)
  } catch (error) {
    return { status: 'partial', uw, diagnostics: postEffectDiagnostics(uw, error) }
  }
  const expected = { scope: uw, recordId, kind: 'operator-control' }
  if (
    reread.accepted.status === 'accepted' &&
    sameRecord(reread.accepted.value.ref.sourceAccepted, expected) &&
    reread.accepted.value.ref.version === prepared.proposal.exactInputs.proposed.snapshot.spec.version
  )
    return { status: 'accepted', value: reread }
  return {
    status: 'partial',
    uw,
    diagnostics: [diagnostic(uw, 'write-unconfirmed', 'Material acceptance was not reconstructed after read-back')],
  }
}

/** Composes native reads, exact control rechecks, publication, and readback around the UI operator service. */
export function createInstalledMaterialOperations(input: {
  operator: OperatorPort
  reader: UwReadPort
  github: GitHubOptions
}): (uw: Scope) => Promise<UwOperationResult> {
  const materialFacts = async (uw: Scope) => {
    const read = await input.reader.readUw(uw)
    const current = await readCurrentOwnSpecFacts({ uw, read, reader: input.reader })
    if (!current.ok) return { ok: false as const, diagnostics: current.diagnostics }
    if (read.graph.status !== 'complete') return { ok: false as const, diagnostics: read.graph.diagnostics }
    const scopes = [
      ...new Map(read.graph.nodes.map((node) => [`${node.uw.repository}\0${node.uw.target}`, node.uw])).values(),
    ]
    const composed = await readComposedWorkflowHistory(scopes, input.github)
    if (!composed.ok) return { ok: false as const, diagnostics: diagnostics(uw, composed.diagnostics) }
    const authority = materialAuthority(uw, composed.histories, current.value.currentSpec)
    if (!authority.ok) return { ok: false as const, diagnostics: authority.diagnostics }
    return {
      ok: true as const,
      value: {
        histories: composed.histories,
        mandate: authority.value.mandate,
        currentProposed: current.value.currentSpec,
        identityAllocations: current.value.identityAllocations,
      },
    }
  }
  const material = async (
    uw: Scope,
    operationId: string,
  ): Promise<{ ok: true; value: PreparedMaterialAcceptance } | { ok: false; diagnostics: readonly UwDiagnostic[] }> => {
    const facts = await materialFacts(uw)
    if (!facts.ok) return facts
    const prepared = prepareMaterialAcceptance({ uw, operationId, ...facts.value })
    return prepared.ok ? prepared : { ok: false, diagnostics: diagnostics(uw, prepared.diagnostics) }
  }
  const materialRecheck = async (prepared: PreparedMaterialAcceptance) => {
    const facts = await materialFacts(prepared.proposal.uw)
    if (!facts.ok) return facts
    if (
      !sameCurrentAssessedState(facts.value.currentProposed, prepared.proposal.exactInputs.proposed) ||
      !sameRecords(facts.value.identityAllocations, prepared.proposal.exactInputs.identityAllocations)
    )
      return {
        ok: false as const,
        diagnostics: [
          diagnostic(
            prepared.proposal.uw,
            'proposal-stale',
            'Native Spec, tier, children, or identity allocations changed after confirmation',
          ),
        ],
      }
    const rechecked = recheckMaterialAcceptance({
      prepared,
      histories: facts.value.histories,
      mandate: facts.value.mandate,
    })
    return rechecked.ok
      ? { ok: true as const, value: { facts: facts.value, prepared: rechecked.value } }
      : { ok: false as const, diagnostics: diagnostics(prepared.proposal.uw, rechecked.diagnostics) }
  }
  return createInstalledMaterialAcceptance(input.operator, {
    prepare: (uw) => material(uw, `accept-material:${randomUUID()}`),
    async recheck(prepared) {
      const current = await materialRecheck(prepared)
      return current.ok ? { ok: true } : current
    },
    async commit({ prepared, confirmation }) {
      const current = await materialRecheck(prepared)
      if (!current.ok) return { status: 'refused', diagnostics: current.diagnostics }
      const record = buildMaterialAcceptanceControl(current.value.prepared, confirmation)
      if (!record.ok) return { status: 'refused', diagnostics: diagnostics(prepared.proposal.uw, record.diagnostics) }
      const home = current.value.facts.histories.find((entry) => sameScope(entry.source.scope, prepared.proposal.uw))
      if (home === undefined)
        return {
          status: 'refused',
          diagnostics: [
            diagnostic(prepared.proposal.uw, 'history-missing', 'Own UW history is absent before material publication'),
          ],
        }
      const published = await publishConfirmedWorkflowRecord(record.value, home, input.github, null)
      if (published.status !== 'confirmed')
        return published.status === 'uncertain'
          ? {
              status: 'partial',
              uw: prepared.proposal.uw,
              diagnostics: diagnostics(prepared.proposal.uw, published.diagnostics),
            }
          : { status: 'refused', diagnostics: diagnostics(prepared.proposal.uw, published.diagnostics) }
      return readMaterialPublication(prepared, record.value.recordId, input.reader)
    },
  })
}
