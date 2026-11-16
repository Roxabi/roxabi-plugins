import { z } from 'zod'
import { identifierSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'

/** A transport reservation is not a reference to an existing record. */
export function reservedRecordIdentitySchema<K extends string>(kind: K) {
  return z.strictObject({
    scope: scopeSchema,
    kind: z.literal(kind),
    runId: identifierSchema,
    operationId: identifierSchema,
    recordId: identifierSchema,
  })
}

export type ReservedRecordIdentity<K extends string> = {
  scope: z.infer<typeof scopeSchema>
  kind: K
  runId: string
  operationId: string
  recordId: string
}

export const partPinSchema = z
  .strictObject({
    locator: z.string().min(1),
    nativeId: z.string().min(1),
    author: z.string().min(1),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    bodyDigest: sha256Schema,
    part: z.number().int().safe().positive(),
    total: z.number().int().safe().positive(),
  })
  .refine((value) => value.part <= value.total, { message: 'Part ordinal exceeds total' })
export type PartPin = z.infer<typeof partPinSchema>

export function recordPinSchema<K extends string>(kind: K) {
  return z.strictObject({
    identity: reservedRecordIdentitySchema(kind),
    envelopeDigest: sha256Schema,
    parts: z.array(partPinSchema).min(1),
  })
}

export type RecordPin<K extends string> = {
  identity: ReservedRecordIdentity<K>
  envelopeDigest: string
  parts: PartPin[]
}
