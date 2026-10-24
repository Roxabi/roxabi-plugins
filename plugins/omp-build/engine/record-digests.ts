import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Scope } from './record-values.ts'

export function specDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}
export const failedCheckFailureSchema = z.strictObject({
  name: z.string().min(1),
  source: z.string().min(1),
  observationId: z.string().min(1),
  conclusion: z.string().min(1),
})
export type FailedCheckFailure = z.infer<typeof failedCheckFailureSchema>

type DigestFailure = {
  source: string
  observationId: string
  name: string
  conclusion: string
}

function hasFailureContent(failure: FailedCheckFailure): boolean {
  return (
    failure.name.length !== 0 &&
    failure.source.length !== 0 &&
    failure.observationId.length !== 0 &&
    failure.conclusion.length !== 0
  )
}

function normalizedFailure(failure: FailedCheckFailure, seen: Set<string>): DigestFailure | null {
  if (!hasFailureContent(failure)) return null
  const key = `${failure.source}\0${failure.observationId}`
  if (seen.has(key)) return null
  seen.add(key)
  return {
    source: failure.source,
    observationId: failure.observationId,
    name: failure.name,
    conclusion: failure.conclusion,
  }
}

function hasNoMissingFailures(failures: readonly (DigestFailure | null)[]): failures is DigestFailure[] {
  return !failures.some((failure) => failure === null)
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compareFailures(left: DigestFailure | null, right: DigestFailure | null): number {
  if (left === null || right === null) return 0
  return (
    compareStrings(left.source, right.source) ||
    compareStrings(left.observationId, right.observationId) ||
    compareStrings(left.name, right.name) ||
    compareStrings(left.conclusion, right.conclusion)
  )
}

/** Digest of the exact supplied failure identity and outcome. Native metadata stays outside this hash. */
export function failedCheckEvidenceDigest(input: {
  candidateGitSHA: string
  scope: Scope
  failures: readonly FailedCheckFailure[]
}): string | null {
  if (input.candidateGitSHA.length === 0 || input.scope.repository.length === 0 || input.scope.target.length === 0)
    return null
  if (input.failures.length === 0) return null
  const seen = new Set<string>()
  const failures = input.failures.map((failure) => normalizedFailure(failure, seen))
  if (!hasNoMissingFailures(failures)) return null
  failures.sort(compareFailures)
  return specDigest(
    JSON.stringify({
      candidateGitSHA: input.candidateGitSHA,
      scope: { repository: input.scope.repository, target: input.scope.target },
      failures,
    }),
  )
}
