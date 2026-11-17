import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'

type Continuation = (
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
  noImplicitResume?: boolean,
  completedReport?: boolean,
  landingReentry?: string,
) => Promise<ContinueFeatureResult>

export function afterMandatePublication(input: ContinueFeatureInput): ContinueFeatureInput {
  const { parentCoverage: _coverage, parentCoverageBasis: _basis, contextHandoff, ...rest } = input
  return contextHandoff === undefined ? rest : { ...rest, control: 'continue' }
}

export function contextSuccessionCoverage(
  result: ContinueFeatureResult,
  input: ContinueFeatureInput,
  mandateRef: ScopedRecordRef,
  continueAt: Continuation,
  noImplicitResume: boolean,
  completedReport: boolean,
): ContinueFeatureResult {
  if (
    result.kind !== 'blocked' ||
    result.coverageRequest === undefined ||
    result.coverageRequest.parent.uw.repository !== mandateRef.scope.repository ||
    result.coverageRequest.parent.uw.target !== mandateRef.scope.target
  )
    return result
  const basis = structuredClone(result.coverageRequest)
  const exactMandate = structuredClone(mandateRef)
  let available = true
  return {
    ...result,
    continueCoverage: async (coverage) => {
      if (!available) return { kind: 'blocked', reason: 'parent-coverage-continuation-consumed' }
      available = false
      if (input.owned?.() === false) return { kind: 'blocked', reason: 'continuation-owner-revoked' }
      return continueAt(
        { ...input, parentCoverage: coverage, parentCoverageBasis: basis },
        exactMandate,
        noImplicitResume,
        completedReport,
      )
    },
  }
}
