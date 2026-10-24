import { readFileSync } from 'node:fs'
import path from 'node:path'
import { roxabiRecordFixtures } from '../../../../testing/roxabi-presets.ts'
import type { SimState } from '../../__fixtures__/proof/sandbox-types.ts'
import { proofComments, proofData } from '../../__fixtures__/proof/wire.ts'

export type Captured = { code: number | null; stdout: string; stderr: string; data?: unknown | unknown[] }
export type ReplayCapture = {
  token: { from: string; to: string }
  version: Captured
  invalid: Captured
  valid: Captured
}
export type Capture = { sha: Record<string, string>; records: Record<string, Captured>; replays?: ReplayCapture }
export type Records = { semctx: Capture; assertledger: Capture; both: Capture }
export type HistoricalCapture = { code: number | null; stdout: string; stderr: string; data?: unknown }
export type HistoricalRecords = {
  sha: Record<string, string>
  records: Record<'valid' | 'partial' | 'blocked' | 'ownSuperseded' | 'borrowedProvenance', HistoricalCapture>
}

export const RECORDS: Records = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', '..', '__fixtures__', 'proof', 'records.json'), 'utf8'),
)
export const HISTORICAL_RECORDS: HistoricalRecords = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', '..', '__fixtures__', 'proof', 'historical.records.json'), 'utf8'),
)

export type Land = {
  status: string
  mode?: string
  reason?: string
  producer?: string
  error?: string
  disarmed?: true
  reviews?: number
  proof?: unknown
}

export type LandRun = {
  result: Land
  calls: SimState['calls']
  gate: {
    labels: string[] | undefined
    autoMerge: { enabledAt: string; matchHeadCommit?: string } | null
  }
  producers: string[]
}
export type FixtureReview = {
  head: string
  verdict: 'Approve (clean)' | 'Request changes'
  prefix: string
  createdAt?: string | null
  updatedAt?: string | null
}
export type FixtureComment = string | FixtureReview

let fixtureReviewSequence = 0
export const review = (head: string, verdict: FixtureReview['verdict']): FixtureReview => ({
  head,
  verdict,
  prefix: `proof-review-${++fixtureReviewSequence}`,
})
export const approve = (head: string): FixtureReview => review(head, 'Approve (clean)')
export const red = (head: string): FixtureReview => review(head, 'Request changes')

const { encodedAdmissionReviewGraph } = roxabiRecordFixtures()

export function fixtureReviewBodies(pr: number, review: FixtureReview, input: string | null = null): string[] {
  return encodedAdmissionReviewGraph({
    scope: { repository: 'acme/app', target: `acme/app#${pr}` },
    head: review.head,
    input,
    verdict: review.verdict,
    prefix: review.prefix,
  }).comments.map(({ body }) => body)
}

export function fixtureProof(data: unknown): { producer: 'semctx' | 'assertledger'; candidate: string; pr: number } {
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('producer' in data) ||
    (data.producer !== 'semctx' && data.producer !== 'assertledger') ||
    !('invocation' in data) ||
    data.invocation === null ||
    typeof data.invocation !== 'object' ||
    Array.isArray(data.invocation) ||
    !('candidate' in data.invocation) ||
    typeof data.invocation.candidate !== 'string' ||
    !('pr' in data.invocation) ||
    typeof data.invocation.pr !== 'number' ||
    !Number.isSafeInteger(data.invocation.pr)
  )
    throw new Error('retained proof data has no producer, candidate, and PR identity')
  return { producer: data.producer, candidate: data.invocation.candidate, pr: data.invocation.pr }
}

export function wireProof(data: unknown, scopePr?: number): string[] {
  const { producer, candidate, pr: sourcePr } = fixtureProof(data)
  return proofComments(producer, candidate, data, scopePr ?? sourcePr)
}

/** Common-codec comments around retained native proof data. */
export function conserved(capture: Capture, name: string, scopePr?: number): string[] {
  const data = capture.records[name]?.data
  if (data === undefined) throw new Error(`records.json holds no ${name} native proof data`)
  return (Array.isArray(data) ? data : [data]).flatMap((record) => wireProof(record, scopePr))
}

export function encodeFixtureProof(producer: 'semctx' | 'assertledger', candidate: string, data: unknown): string[] {
  const { pr } = fixtureProof(data)
  return proofComments(producer, candidate, data, pr)
}

export function decodeFixtureProof(
  comments: { author: { login: string }; body: string }[],
  producer: 'semctx' | 'assertledger',
  candidate: string,
  pr: number,
): { record: unknown; parts: { body: string }[] } {
  return {
    record: proofData(
      producer,
      candidate,
      comments.map((comment) => comment.body),
      pr,
    ),
    parts: comments,
  }
}

export const proofFramePrefix = (_producer: 'semctx' | 'assertledger'): string =>
  '<!-- omp-build-record v=1 kind=proof '
export const proofOperationMarker = (producer: 'semctx' | 'assertledger', candidate: string): string =>
  `operationId=${encodeURIComponent(`proof:${producer}:${candidate}:`)}`
