import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { PreparedMaterialAcceptance } from '../engine/workflow-spec-assessment.ts'
import type { OperatorPort, UwOperationResult } from './uw-contract.ts'

export type MaterialAcceptancePorts = {
  /** Cold exact-chain preparation from current history/native Spec; never argv-derived. */
  prepare(
    uw: Scope,
  ): Promise<{ ok: true; value: PreparedMaterialAcceptance } | { ok: false; diagnostics: readonly UwDiagnostic[] }>
  /** Replays current native/history facts against the exact displayed material proposal. */
  recheck(
    prepared: PreparedMaterialAcceptance,
  ): Promise<{ ok: true } | { ok: false; diagnostics: readonly UwDiagnostic[] }>
  /** Publishes the exact confirmed control, then reads it back/replays the accepted chain. */
  commit(input: {
    prepared: PreparedMaterialAcceptance
    confirmation: OperatorConfirmationEvidence
  }): Promise<UwOperationResult>
}

/**
 * The material route has the same proposal/confirmation/recheck discipline as write/create,
 * without manufacturing a draft, tier, or identity allocation.
 */
export function createInstalledMaterialAcceptance(
  operator: OperatorPort,
  ports: MaterialAcceptancePorts,
): (uw: Scope) => Promise<UwOperationResult> {
  return async (uw) => {
    const prepared = await ports.prepare(uw)
    if (!prepared.ok) return { status: 'refused', diagnostics: prepared.diagnostics }
    const confirmed = await operator.executeConfirmed(prepared.value, async (confirmation) => {
      const current = await ports.recheck(prepared.value)
      if (!current.ok) return { status: 'refused' as const, diagnostics: current.diagnostics }
      return ports.commit({ prepared: prepared.value, confirmation })
    })
    return confirmed.status === 'confirmed'
      ? confirmed.value
      : { status: 'refused', diagnostics: confirmed.diagnostics }
  }
}
