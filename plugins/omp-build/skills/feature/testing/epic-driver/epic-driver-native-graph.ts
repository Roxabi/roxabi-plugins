import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Scope } from '../../../../engine/record-values.ts'

/** Read the complete native issue closure, retaining the independently observed parent claims. */
export function readEpicFixtureIssues(root: Scope, state: string) {
  const reference = z.object({
    number: z.number().int().positive(),
    repository: z.object({ nameWithOwner: z.literal('o/r') }),
  })
  const connection = <T extends z.ZodType>(item: T) =>
    z.object({
      nodes: z.array(item),
      pageInfo: z.object({ hasNextPage: z.literal(false), endCursor: z.string().nullable() }),
    })
  const response = z.object({
    data: z.object({
      repository: z.object({
        issue: z.object({
          number: z.number().int().positive(),
          title: z.string(),
          body: z.string(),
          updatedAt: z.string(),
          state: z.enum(['OPEN', 'CLOSED']),
          stateReason: z.string().nullable(),
          repository: z.object({ nameWithOwner: z.literal('o/r') }),
          parent: reference.nullable(),
          labels: connection(z.object({ name: z.string() })),
          subIssues: connection(reference),
          blockedBy: connection(reference),
        }),
      }),
    }),
  })
  const start = Number(root.target.slice(root.target.lastIndexOf('#') + 1))
  const pending = [start]
  const seen = new Set<number>()
  const issues: unknown[] = []
  const parentClaims = new Map<number, number | null>()
  while (pending.length) {
    const number = pending.pop()
    if (number === undefined) throw new Error('Native issue traversal lost a pending issue')
    if (seen.has(number)) continue
    const source = JSON.parse(readFileSync(path.join(state, `uw-${number}.json`), 'utf8'))
    const issue = response.parse(source).data.repository.issue
    if (issue.number !== number) throw new Error(`Unexpected native issue in uw-${number}.json`)
    seen.add(number)
    parentClaims.set(number, issue.parent?.number ?? null)
    const subIssues = issue.subIssues.nodes.map((entry) => entry.number)
    const blockedBy = issue.blockedBy.nodes.map((entry) => entry.number)
    pending.push(...subIssues, ...blockedBy, ...(issue.parent ? [issue.parent.number] : []))
    issues.push({ ...issue, labels: issue.labels.nodes.map((entry) => entry.name), subIssues, blockedBy })
  }
  return { issues, parentClaims }
}
