import { z } from 'zod'
import { identifierSchema, sha256Schema } from './schema-primitives.ts'

/** Observed callback metadata for one native tool call — not a no-effects certificate. */
export const nativeObservedToolCallSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  inputDigest: sha256Schema.nullable(),
  resultDigest: sha256Schema.nullable(),
  completion: z.enum(['pending', 'returned', 'deferred', 'ambiguous', 'unavailable']),
  isError: z.boolean().nullable(),
  exitCode: z.number().int().nullable(),
})
export type NativeObservedToolCall = z.infer<typeof nativeObservedToolCallSchema>

/**
 * Conserved native tool-callback observation for one executed child.
 * Missing historical fields stay unavailable; this is not readonly/global cessation proof.
 * `closed` means the settlement admission fence refuses further guarded starts for this owner.
 */
export const nativeToolObservationSchema = z.strictObject({
  format: z.literal('omp-build-native-tool-observation/1'),
  scope: z.literal('guarded-tool-admission'),
  actionId: identifierSchema,
  childId: identifierSchema,
  sessionId: identifierSchema,
  boundary: z.enum(['open', 'closed', 'invalid']),
  closedBy: z.enum(['settlement-fence']).nullable(),
  calls: z.array(nativeObservedToolCallSchema),
})
export type NativeToolObservation = z.infer<typeof nativeToolObservationSchema>
