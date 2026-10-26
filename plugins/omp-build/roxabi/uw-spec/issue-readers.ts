import type { Gh } from '../../adapters/github/types.ts'
import {
  type IssueViewOptions,
  type ReviewIssueView,
  readEpicInputIssueView,
  readEpicLiveIssueView,
  readReviewIssueView,
  readSelectionIssueView,
} from '../../adapters/github-native/issue-views.ts'
import type { Result } from '../../dist/contracts.js'
import { specDigest } from '../../dist/contracts.js'

export type SelectionIssueSpec = { title: string; body: string; labels: string[]; updatedAt: string }

export type ReviewIssueSpec = {
  reference: string
  number: number
  body: string
  digest: string
  lastEditedAt: string | null
  labels: readonly string[]
}

export type LiveIssueSpec = {
  reference: string
  number: number
  body: string
  digest: string
  lastEditedAt: string | null
  labels: string[]
}

function failed<T>(code: string, message: string): Result<T> {
  return { ok: false, diagnostics: [{ code, message }] }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readSelectionIssueSpec(
  cwd: string,
  repository: string,
  number: number,
  gh: Gh,
): Promise<SelectionIssueSpec | null> {
  return readSelectionIssueView(repository, number, { cwd, gh })
}

export async function readReviewIssueSpec(
  cwd: string,
  repository: string,
  number: number,
  gh: Gh,
): Promise<Result<ReviewIssueSpec>> {
  try {
    const issue: ReviewIssueView | null = await readReviewIssueView(repository, number, {
      cwd,
      gh,
    } satisfies IssueViewOptions)
    if (
      issue === null ||
      (issue.state !== 'OPEN' && issue.state !== 'CLOSED') ||
      typeof issue.body !== 'string' ||
      (issue.updatedAt !== null && typeof issue.updatedAt !== 'string') ||
      !Array.isArray(issue.labels)
    ) {
      return failed('tracker-issue-unreadable', `tracker issue #${number} is unreadable`)
    }
    return {
      ok: true,
      value: {
        reference: `#${number}`,
        number,
        body: issue.body,
        digest: specDigest(issue.body),
        lastEditedAt: issue.updatedAt,
        labels: issue.labels.flatMap((label) =>
          isObject(label) && typeof label.name === 'string' ? [label.name] : [],
        ),
      },
    }
  } catch (error) {
    return failed('tracker-issue-unreadable', error instanceof Error ? error.message : String(error))
  }
}

export async function readEpicInputSpec(
  cwd: string,
  repository: string,
  target: string,
  epic: number,
  gh: Gh,
): Promise<LiveIssueSpec> {
  const issue: ReviewIssueView | null = await readEpicInputIssueView(repository, epic, {
    cwd,
    gh,
  } satisfies IssueViewOptions)
  if (
    issue === null ||
    (issue.state !== 'OPEN' && issue.state !== 'CLOSED') ||
    typeof issue.body !== 'string' ||
    !Array.isArray(issue.labels)
  ) {
    throw new Error('epic issue unreadable')
  }
  return {
    reference: target,
    number: epic,
    body: issue.body,
    digest: specDigest(issue.body),
    lastEditedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
    labels: issue.labels.flatMap((label) =>
      typeof label === 'object' && label !== null && 'name' in label && typeof label.name === 'string'
        ? [label.name]
        : [],
    ),
  }
}

export async function readEpicLiveSpec(
  cwd: string,
  repository: string,
  target: string,
  epic: number,
  gh: Gh,
): Promise<LiveIssueSpec> {
  const issue = await readEpicLiveIssueView(repository, epic, { cwd, gh } satisfies IssueViewOptions)
  if (issue === null) throw new Error('epic-live-spec-unreadable')
  return {
    reference: target,
    number: epic,
    body: issue.body,
    digest: specDigest(issue.body),
    lastEditedAt: issue.updatedAt,
    labels: issue.labels,
  }
}
