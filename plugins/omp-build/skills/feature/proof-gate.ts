export type VerifyStatus = 'VERIFIED' | 'PARTIAL' | 'BLOCKED'
export type AssertledgerVerdict = 'detection' | 'WEAK_ORACLE' | 'miss' | null

export type GateInput = {
  verify: VerifyStatus
  gaps: string[]
  noTest: Record<string, string>
  acceptedReasons: string[]
  assertledger: AssertledgerVerdict
  hasAdapter: boolean
  typeFix: boolean
}

export type GateResult = { pass: true } | { pass: false; reason: string }

const DEFAULT_REASONS = ['infra-not-wired', 'prompt-logic-only', 'ui-manual-only', 'out-of-scope']

export function proofGate(input: GateInput): GateResult {
  if (input.verify === 'BLOCKED') return { pass: false, reason: 'BLOCKED' }
  if (input.verify === 'PARTIAL') {
    const accepted = new Set(input.acceptedReasons.length ? input.acceptedReasons : DEFAULT_REASONS)
    const unjustified = input.gaps.filter((gap) => !accepted.has(input.noTest[gap] ?? ''))
    if (unjustified.length) return { pass: false, reason: `unjustified PARTIAL: ${unjustified.join(', ')}` }
  }
  if (input.typeFix && input.hasAdapter && input.assertledger !== 'detection') {
    return { pass: false, reason: input.assertledger ?? 'assertledger-missing' }
  }
  return { pass: true }
}
