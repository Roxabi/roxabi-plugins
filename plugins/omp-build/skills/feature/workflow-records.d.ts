import type { DecodedHistory, Result, ReviewSummary, Scope } from '../../contracts.ts'
import type { Gh } from './review-base.ts'

export type ReviewRecordOptions = { taxonomy?: readonly string[]; acceptedEvidencePolicyRef?: string | null }
export type ReviewComment = {
  author: { login: string }
  body: string
  id?: number
  createdAt?: string
  updatedAt?: string
}

export declare function reviewTaxonomy(): string[]
export declare function reviewRefusal(refusal: { diagnostics?: readonly { message?: string; code?: string }[] }): Error
export declare function repositoryScope(cwd: string, pr: number | string, ghFn?: Gh): Promise<Scope>
/** Summarizes only decoded canonical records; malformed, legacy and partial records refuse. */
export declare function reviewRecords(history: DecodedHistory, options?: ReviewRecordOptions): Result<ReviewSummary>
export declare function readReviewHistory(cwd: string, pr: number | string, ghFn?: Gh): Promise<DecodedHistory>
export declare function readReviewRecords(
  cwd: string,
  pr: number | string,
  options?: ReviewRecordOptions & { gh?: Gh },
): Promise<Result<ReviewSummary>>
export declare function requiredReviewRecords(
  cwd: string,
  pr: number | string,
  options?: ReviewRecordOptions & { gh?: Gh },
): Promise<ReviewSummary>
export declare function requiredReviewAdmission(
  cwd: string,
  pr: number | string,
  options?: ReviewRecordOptions & { gh?: Gh },
): Promise<{ records: ReviewSummary; operation: DecodedHistory['operations'][number] | null }>
export declare function readComments(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh },
): Promise<{ me: string; comments: ReviewComment[] }>
