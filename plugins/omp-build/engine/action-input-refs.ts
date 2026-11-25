import { z } from 'zod'
import { sameRef } from './record-diagnostics.ts'
import { externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import { repoRelativePathSchema, sha256Schema } from './schema-primitives.ts'

const jsonPointerSchema = z.string().regex(/^(?:\/(?:[^/~]|~0|~1)*)+$/)
export const recordInputRefSchema = z.strictObject({
  source: z.literal('record'),
  record: externalRecordRefSchema,
  selector: jsonPointerSchema,
  digest: sha256Schema,
})
export type RecordInputRef = z.infer<typeof recordInputRefSchema>
export const pinnedFileRefSchema = z.strictObject({
  source: z.literal('git-file'),
  repository: z.string().min(1),
  commit: gitObjectIdSchema,
  path: repoRelativePathSchema,
  digest: sha256Schema,
})
export type PinnedFileRef = z.infer<typeof pinnedFileRefSchema>

type InputRef = PinnedFileRef | RecordInputRef

/** Match the selected content, not metadata from the manifest field holding the citation. */
export function sameInputRef(left: InputRef, right: InputRef): boolean {
  if (left.digest !== right.digest) return false
  if (left.source === 'record')
    return right.source === 'record' && sameRef(left.record, right.record) && left.selector === right.selector
  return (
    right.source === 'git-file' &&
    left.repository === right.repository &&
    left.commit === right.commit &&
    left.path === right.path
  )
}
