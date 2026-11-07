import { z } from 'zod'
import { externalRecordRefSchema } from './record-references.ts'
import { diagnosticSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'

const dispositionRef = externalRecordRefSchema.extend({ kind: z.literal('cause-disposition') })
export const parentAdditionObservationSchema = z.strictObject({
  parent: scopeSchema,
  nativeDigest: sha256Schema,
  historyDigest: sha256Schema,
  state: z.enum(['inactive', 'active', 'indeterminate']),
  diagnostics: z.array(diagnosticSchema),
})
export const sisterContextSchema = z.strictObject({
  kind: z.literal('sister'),
  disposition: dispositionRef,
  dispositionDigest: sha256Schema,
  original: scopeSchema,
  originalObservationDigest: sha256Schema,
  parent: scopeSchema.nullable(),
  parentObservation: parentAdditionObservationSchema.nullable(),
  relation: z.enum(['original-blocked-by-sister', 'sister-blocked-by-original']),
})
export const promotionContextSchema = z.strictObject({
  kind: z.literal('report-promotion'),
  report: dispositionRef,
  reportDigest: sha256Schema,
  reason: z.string().trim().min(1),
  parentObservation: parentAdditionObservationSchema.nullable(),
})
export const causeCreationContextSchema = z.discriminatedUnion('kind', [sisterContextSchema, promotionContextSchema])
export const creationContextSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operator-create') }),
  sisterContextSchema,
  promotionContextSchema,
])
export type CreationContext = z.infer<typeof creationContextSchema>
export type CauseCreationContext = z.infer<typeof causeCreationContextSchema>
