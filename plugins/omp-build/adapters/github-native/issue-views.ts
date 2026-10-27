import type { Gh } from '../github/types.ts'

type RecordValue = Record<string, unknown>

export type SelectionIssueView = { title: string; body: string; labels: string[]; updatedAt: string }
export type ReviewIssueView = { body: string; updatedAt: string | null; state: unknown; labels: unknown }
export type EpicLiveIssueView = { body: string; updatedAt: string | null; labels: string[] }
export type IssueViewOptions = { cwd: string; gh: Gh }

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : null
}

function labelNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((label) => {
        const item = record(label)
        return item !== null && typeof item.name === 'string' ? [item.name] : []
      })
    : []
}

async function issueView(
  repository: string,
  number: number,
  options: IssueViewOptions,
  fields: string,
): Promise<unknown> {
  return JSON.parse(
    await options.gh(options.cwd, ['issue', 'view', String(number), '--repo', repository, '--json', fields]),
  )
}

export async function readSelectionIssueView(
  repository: string,
  number: number,
  options: IssueViewOptions,
): Promise<SelectionIssueView | null> {
  const parsed = record(await issueView(repository, number, options, 'title,body,labels,updatedAt'))
  if (parsed === null || typeof parsed.title !== 'string' || typeof parsed.body !== 'string') return null
  return {
    title: parsed.title,
    body: parsed.body,
    labels: labelNames(parsed.labels),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
  }
}

export async function readReviewIssueView(
  repository: string,
  number: number,
  options: IssueViewOptions,
): Promise<ReviewIssueView | null> {
  const parsed = record(await issueView(repository, number, options, 'body,updatedAt,state,labels'))
  if (
    parsed === null ||
    typeof parsed.body !== 'string' ||
    (parsed.updatedAt !== null && typeof parsed.updatedAt !== 'string')
  )
    return null
  return { body: parsed.body, updatedAt: parsed.updatedAt, state: parsed.state, labels: parsed.labels }
}

export async function readEpicInputIssueView(
  repository: string,
  number: number,
  options: IssueViewOptions,
): Promise<ReviewIssueView | null> {
  const parsed = record(await issueView(repository, number, options, 'body,updatedAt,state,labels'))
  if (parsed === null || typeof parsed.body !== 'string') return null
  return {
    body: parsed.body,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    state: parsed.state,
    labels: parsed.labels,
  }
}

export async function readEpicLiveIssueView(
  repository: string,
  number: number,
  options: IssueViewOptions,
): Promise<EpicLiveIssueView | null> {
  const parsed = record(await issueView(repository, number, options, 'body,updatedAt,labels'))
  if (parsed === null || typeof parsed.body !== 'string') return null
  return {
    body: parsed.body,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    labels: labelNames(parsed.labels),
  }
}
