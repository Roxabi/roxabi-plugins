import { z } from 'zod'
import { specDigest } from './record-digests.ts'
import type { Scope } from './record-values.ts'
import type { UwNativeNode } from './uw-graph.ts'
import { issueRefSchema } from './uw-write-intent-schema.ts'

export const nativeIssueObservationSchema = z.strictObject({
  issue: issueRefSchema,
  title: z.string(),
  body: z.string(),
  updatedAt: z.string(),
  nativeState: z.strictObject({ state: z.enum(['OPEN', 'CLOSED']), stateReason: z.string().nullable() }),
  labels: z.array(z.string()),
  parent: issueRefSchema.nullable(),
  children: z.array(issueRefSchema),
  blockers: z.array(issueRefSchema),
})
export type NativeIssueObservation = z.infer<typeof nativeIssueObservationSchema>

function issueFromScope(scope: Scope): { repository: string; number: number } | null {
  const prefix = `${scope.repository}#`
  if (!scope.target.startsWith(prefix)) return null
  const suffix = scope.target.slice(prefix.length)
  if (!/^[1-9][0-9]*$/.test(suffix)) return null
  const number = Number(suffix)
  return Number.isSafeInteger(number) ? { repository: scope.repository, number } : null
}

export function nativeIssueObservationFromNode(node: UwNativeNode): NativeIssueObservation | null {
  if (node.parent !== null && issueFromScope(node.parent) === null) return null
  const parsed = nativeIssueObservationSchema.safeParse({
    issue: issueFromScope(node.uw),
    title: node.title,
    body: node.raw.body,
    updatedAt: node.updatedAt,
    nativeState: node.native,
    labels: node.labels,
    parent: node.parent === null ? null : issueFromScope(node.parent),
    children: node.children.map(issueFromScope),
    blockers: node.blockers.map(issueFromScope),
  })
  return parsed.success ? parsed.data : null
}

/** Same asserted facts as IssueWriter: unordered relation/label sets, no descriptive updatedAt. */
export function nativeObservationDigest(value: NativeIssueObservation): string {
  const ref = (item: NativeIssueObservation['issue']) => ({ number: item.number, repository: item.repository })
  const refs = (items: readonly NativeIssueObservation['issue'][]) =>
    items.map(ref).sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number)
  return specDigest(
    JSON.stringify({
      blockers: refs(value.blockers),
      body: value.body,
      children: refs(value.children),
      issue: ref(value.issue),
      labels: [...value.labels].sort(),
      nativeState: { state: value.nativeState.state, stateReason: value.nativeState.stateReason },
      parent: value.parent === null ? null : ref(value.parent),
      title: value.title,
    }),
  )
}
