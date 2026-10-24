import type { Json, Scope } from '../dist/contracts.js'
import type { DebtEvidence } from './fix-domain'

export type DebtFilingTarget = Scope & {
  number: number
  kind: 'issue' | 'pull-request'
  state: 'open' | 'closed'
  candidateGitSHA: string | null
}

export type DebtFilingInput = {
  receiptId: string
  target: DebtFilingTarget
  decisionId: string
  fixRequestId: string
  findingIds: readonly string[]
  causeIds: readonly string[]
  evidence: DebtEvidence
  retentionDiagnostics: readonly string[]
  acceptedEvidencePolicyRef: string | null
}

export type DebtFilingResult<T> = { ok: true; value: T } | { ok: false; diagnostics: string[] }

export type DebtFiling = {
  file(input: DebtFilingInput): Promise<DebtFilingResult<{ target: string; raw: Json }>>
}
