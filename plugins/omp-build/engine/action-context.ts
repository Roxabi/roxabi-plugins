import { z } from 'zod'
import { actionInputsSchema } from './action-input-schema.ts'
import { findingTargetSchema } from './finding-target-schema.ts'
import { repoRelativePathSchema } from './schema-primitives.ts'

export const requestedSourceLocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file-request'),
    repository: z.string(),
    path: repoRelativePathSchema,
    revisionHint: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal('record-request'),
    repository: z.string(),
    target: z.string(),
    recordKind: z.string().nullable(),
    requestedId: z.string().nullable(),
    selector: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal('information-request'), description: z.string() }),
])

export const missingContextItemSchema = z.strictObject({
  locator: requestedSourceLocatorSchema,
  reason: z.string().min(1),
  targets: z.array(findingTargetSchema),
})
export const missingContextOutputSchema = z.strictObject({
  outcome: z.literal('missing-context'),
  missing: z.array(missingContextItemSchema).min(1),
})
export const contextNegativeBindingSchema = z.strictObject({
  actionId: z.string().min(1),
  inputs: actionInputsSchema,
})
export type MissingContextItem = z.infer<typeof missingContextItemSchema>
export type MissingContextOutput = z.infer<typeof missingContextOutputSchema>
export type ContextActionBinding = z.infer<typeof contextNegativeBindingSchema>

/** Call only after validating the complete producer output for its role. */
export function missingContextOf(value: unknown): readonly MissingContextItem[] | null {
  const common = missingContextOutputSchema.safeParse(value)
  if (common.success) return common.data.missing
  if (
    value === null ||
    typeof value !== 'object' ||
    !('outcome' in value) ||
    value.outcome !== 'blocked' ||
    !('missing' in value)
  )
    return null
  const missing = z.array(missingContextItemSchema).min(1).safeParse(value.missing)
  return missing.success ? missing.data : null
}
