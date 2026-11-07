import { randomUUID } from 'node:crypto'
import type { GitHubOptions } from '../dist/contracts.js'
import {
  acceptedMetadataOwner,
  buildMaterialAcceptanceControl,
  prepareMaterialAcceptance,
  publishConfirmedWorkflowRecord,
  recheckMaterialAcceptance,
  resolveOwnSpecAuthority,
  sameCurrentAssessedState,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OwnSpecAuthority } from '../engine/workflow-mandate-admission.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { PreparedMaterialAcceptance } from '../engine/workflow-spec-assessment.ts'
import { composeObservedUwCausalContext } from './fix-uw-histories.ts'
import { createInstalledMaterialAcceptance } from './material-acceptance-service.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import type { OperatorPort, UwOperationResult, UwRead, UwReadPort } from './uw-contract.ts'
import { type CurrentOwnSpecFacts, readAssessmentSpecFacts } from './uw-current-facts.ts'
import { diagnostic, diagnostics, postEffectDiagnostics } from './uw-installed-reports.ts'

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
  causal: WorkflowCausalContext,
): { ok: true; value: OwnSpecAuthority } | { ok: false; diagnostics: readonly UwDiagnostic[] } {
  const home = histories.find((history) => sameScope(history.source.scope, uw))
  if (home === undefined)
    return { ok: false, diagnostics: [diagnostic(uw, 'history-missing', 'Own UW history is absent')] }
  const authority = resolveOwnSpecAuthority(
    home,
    histories.filter((history) => history !== home),
    causal,
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
    causal,
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
  const step = reread.accepted.status === 'accepted' ? reread.accepted.value.chain.at(-1) : undefined
  const owner =
    step === undefined || reread.observation.status !== 'complete'
      ? null
      : acceptedMetadataOwner(step, reread.observation.histories)
  if (
    reread.accepted.status === 'accepted' &&
    step !== undefined &&
    sameRecord(step.source, expected) &&
    owner?.ok &&
    sameRecord(owner.value.record, prepared.proposal.assessment) &&
    owner.value.selector === '/payload/exactInputs/proposed' &&
    sameCurrentAssessedState(
      {
        snapshot: reread.accepted.value.snapshot,
        tier: reread.accepted.value.tier,
        children: reread.accepted.value.children,
        inheritedOwnSpecRefs: reread.accepted.value.inheritedOwnSpecRefs,
        coverage: reread.accepted.value.coverage,
      },
      prepared.proposal.exactInputs.proposed,
    )
  )
    return { status: 'accepted', value: reread }
  return {
    status: 'partial',
    uw,
    diagnostics: [diagnostic(uw, 'write-unconfirmed', 'Material acceptance was not reconstructed after read-back')],
  }
}

async function readMaterialUw(
  reader: UwReadPort,
  uw: Scope,
): Promise<{ ok: true; read: UwRead } | { ok: false; diagnostics: readonly UwDiagnostic[] }> {
  try {
    return { ok: true, read: await reader.readUw(uw) }
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          uw,
          'framing-aggregate-unreadable',
          error instanceof Error ? error.message : 'Current UW could not be read',
        ),
      ],
    }
  }
}

function assessmentDiagnostics(
  uw: Scope,
  current: Extract<Awaited<ReturnType<typeof readAssessmentSpecFacts>>, { ok: false }>,
): readonly UwDiagnostic[] {
  return 'diagnostics' in current
    ? current.diagnostics
    : [diagnostic(uw, current.reason, 'No unique current assessed coverage proposal')]
}

/** Composes native reads, exact control rechecks, publication, and readback around the UI operator service. */
export function createInstalledMaterialOperations(input: {
  operator: OperatorPort
  reader: UwReadPort
  github: GitHubOptions
}): (uw: Scope) => Promise<UwOperationResult> {
  const materialFacts = async (uw: Scope) => {
    const fresh = await readMaterialUw(input.reader, uw)
    if (!fresh.ok) return fresh
    const read = fresh.read
    if (read.admission.aggregate.status === 'held')
      return { ok: false as const, diagnostics: read.admission.aggregate.diagnostics }
    const current = await readAssessmentSpecFacts({ uw, read })
    if (!current.ok) return { ok: false as const, diagnostics: assessmentDiagnostics(uw, current) }
    if (read.graph.status !== 'complete') return { ok: false as const, diagnostics: read.graph.diagnostics }
    if (read.observation.status !== 'complete') return { ok: false as const, diagnostics: read.observation.diagnostics }
    const histories = read.observation.histories
    const causal = await composeObservedUwCausalContext(read, histories, input.github)
    if (!causal.ok)
      return {
        ok: false as const,
        diagnostics: diagnostics(
          uw,
          causal.diagnostics.map((code) => ({ code })),
        ),
      }
    const authority = materialAuthority(uw, histories, current.value.currentSpec, causal.value)
    if (!authority.ok) return { ok: false as const, diagnostics: authority.diagnostics }
    return {
      ok: true as const,
      value: {
        histories,
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
      const record = buildMaterialAcceptanceControl(current.value.prepared, confirmation, {
        histories: current.value.facts.histories,
        mandate: current.value.facts.mandate,
      })
      if (!record.ok) return { status: 'refused', diagnostics: diagnostics(prepared.proposal.uw, record.diagnostics) }
      const home = current.value.facts.histories.find((entry) => sameScope(entry.source.scope, prepared.proposal.uw))
      if (home === undefined)
        return {
          status: 'refused',
          diagnostics: [
            diagnostic(prepared.proposal.uw, 'history-missing', 'Own UW history is absent before material publication'),
          ],
        }
      const published = await publishConfirmedWorkflowRecord(
        record.value,
        input.github,
        createPublicationContextResolver(input.github, null),
        current.value.facts.histories,
      )
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
