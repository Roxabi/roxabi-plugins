import { projectionConfig, TEST_HEAD, TEST_INPUT, TEST_SCOPE } from '../../testing/record-builders.ts'

export const TAXONOMY = ['race-condition', 'candidate/isolated-hypothesis', 'test-tautology']
export const PROJECTION_CONFIG = projectionConfig(TAXONOMY)

export function refusalCodes(result: { ok: boolean; diagnostics?: { code: string }[] }): string[] {
  if (result.ok) throw new Error('Expected a refusal')
  return result.diagnostics?.map(({ code }) => code) ?? []
}

export function assessmentCodes(assessment: { diagnostics: { code: string }[] }): string[] {
  return assessment.diagnostics.map(({ code }) => code)
}

export function reviewFacts(head = TEST_HEAD, ci: 'green' | 'red' | 'pending' | 'unknown' = 'green') {
  return {
    ...TEST_SCOPE,
    candidateGitSHA: head,
    input: TEST_INPUT,
    proofAdmission: { ok: true as const, value: null },
    ci,
    acceptedEvidencePolicyRef: null,
  }
}
