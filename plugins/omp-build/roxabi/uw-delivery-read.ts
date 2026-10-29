import { historyFor, resolveAcceptedSpec, resolveOwnSpecEffective } from '../dist/contracts.js'
import type { CodeVersion, CriterionDeclaration } from '../engine/criterion-evidence-schema.ts'
import type { CriterionVerdict } from '../engine/criterion-verdict-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Diagnostic, Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { SpecEffective } from '../engine/spec-effective.ts'
import type { UwResult } from '../engine/uw-diagnostics.ts'
import type { RecordInputRef } from './uw-action-contract.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'
import type { UwRead } from './uw-contract.ts'
import { collectDeclarations, collectVerdicts } from './uw-delivery-collect.ts'

export type UwDeliveryDeclaration = { value: CriterionDeclaration; code: CodeVersion; receipt: RecordInputRef }
export type UwDeliveryVerdict = { value: CriterionVerdict; code: CodeVersion; source: RecordInputRef }
export type UwDeliveryRead = {
  uw: Scope
  effective: UwResult<SpecEffective>
  declarations: readonly UwDeliveryDeclaration[]
  verdicts: readonly UwDeliveryVerdict[]
  diagnostics: readonly Diagnostic[]
}
export type UwDeliveryReadPorts = {
  readUw(uw: Scope): Promise<UwRead>
  readDeliveryHistories(uw: Scope): Promise<Result<readonly DecodedHistory[]>>
}

function absent(uw: Scope, code: string, message: string): UwResult<never> {
  return {
    ok: false,
    diagnostics: [{ code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }],
  }
}
function effectiveOf(uw: Scope, histories: readonly DecodedHistory[]): UwResult<SpecEffective> {
  const issue = historyFor(uw, histories)
  if (issue === null) return absent(uw, 'spec-not-accepted', 'UW history is absent')
  const mandate = currentAccountedMandate(issue)
  if (!mandate.ok)
    return absent(
      uw,
      mandate.diagnostics[0]?.code ?? 'spec-not-accepted',
      mandate.diagnostics[0]?.message ?? 'No current accounted mandate',
    )
  const accepted = resolveAcceptedSpec(mandate.value, histories)
  if (!accepted.ok)
    return absent(
      uw,
      accepted.evidence[0]?.code ?? 'spec-not-accepted',
      accepted.evidence[0]?.message ?? 'Accepted Spec is absent',
    )
  const effective = resolveOwnSpecEffective(accepted.spec)
  if (!effective.ok)
    return absent(
      uw,
      effective.diagnostics[0]?.code ?? 'spec-not-accepted',
      effective.diagnostics[0]?.message ?? 'Own Spec is not effective',
    )
  return { ok: true, value: effective.value }
}

async function loadDeliveryHistories(
  uw: Scope,
  ports: UwDeliveryReadPorts,
): Promise<UwResult<readonly DecodedHistory[]>> {
  const histories = await ports.readDeliveryHistories(uw)
  if (!histories.ok)
    return absent(
      uw,
      histories.diagnostics[0]?.code ?? 'record-unreadable',
      histories.diagnostics[0]?.message ?? 'Delivery histories are unreadable',
    )
  return { ok: true, value: histories.value }
}

export async function readUwDelivery(uw: Scope, ports: UwDeliveryReadPorts): Promise<UwResult<UwDeliveryRead>> {
  const read = await ports.readUw(uw)
  if (!read.identity.ok) return { ok: false, diagnostics: read.identity.diagnostics }
  const histories = await loadDeliveryHistories(uw, ports)
  if (!histories.ok) return histories
  const diagnostics: Diagnostic[] = []
  const declarations = collectDeclarations(uw, histories.value, diagnostics)
  const verdicts = collectVerdicts(histories.value, new Set(declarations.map((item) => item.code.commit)), diagnostics)
  if (declarations.length === 0)
    diagnostics.push({ code: 'criterion-declaration-absent', message: 'No eligible criterion declaration' })
  if (verdicts.length === 0) diagnostics.push({ code: 'criterion-verdict-absent', message: 'No criterion verdict' })
  return { ok: true, value: { uw, effective: effectiveOf(uw, histories.value), declarations, verdicts, diagnostics } }
}
