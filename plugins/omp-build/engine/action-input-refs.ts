import { z } from 'zod'
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
