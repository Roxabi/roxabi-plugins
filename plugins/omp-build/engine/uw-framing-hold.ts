import type { DecodedHistory } from './history-schema.ts'
import type { Scope } from './record-values.ts'
import type { AcceptedOwnSpecResult } from './uw-admission.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import type { FramingReceiptRef } from './uw-framing-receipt-schema.ts'
import type { FramingRegistry } from './uw-framing-registry.ts'
import type { FramingEdge, FramingMemberKey } from './uw-framing-schema.ts'
import type { UwGraphObservation } from './uw-graph.ts'

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
export const FRAMING_ADMISSION_HOLD_CODES = [
  'framing-aggregate-incomplete',
  'framing-aggregate-unreadable',
  'framing-binding-unregistered',
  'framing-binding-conflict',
  'framing-result-drift',
] as const
export type FramingAdmissionHoldCode = (typeof FRAMING_ADMISSION_HOLD_CODES)[number]
export type FramingMissingFact =
  | { kind: 'binding' | 'claim' | 'identity'; member: FramingMemberKey }
  | { kind: 'edge'; edge: FramingEdge }
  | { kind: 'result' }
  | { kind: 'root-history' }
export type FramingMembership =
  | { status: 'none' }
  | { status: 'complete'; intent: FramingReceiptRef; result: FramingReceiptRef; member: FramingMemberKey }
  | {
      status: 'held'
      code: FramingAdmissionHoldCode
      intent: FramingReceiptRef | null
      member: FramingMemberKey | null
      missing: readonly FramingMissingFact[]
      diagnostics: readonly UwDiagnostic[]
    }
export function held(
  uw: Scope,
  code: FramingAdmissionHoldCode,
  intent: FramingReceiptRef | null,
  member: FramingMemberKey | null,
  missing: FramingMissingFact[] = [],
): FramingMembership {
  return {
    status: 'held',
    code,
    intent,
    member,
    missing,
    diagnostics: [diagnostic(uw, code, 'Framing aggregate is not complete and matching')],
  }
}
export type MembershipInput = {
  uw: Scope
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
  accepted: AcceptedOwnSpecResult
}
export type MembershipContext = MembershipInput & {
  intent: FramingReceiptRef
  member: FramingMemberKey
  registry: FramingRegistry
}
export function drift(ctx: MembershipContext, missing: FramingMissingFact[] = []): FramingMembership {
  return held(ctx.uw, 'framing-result-drift', ctx.intent, ctx.member, missing)
}
