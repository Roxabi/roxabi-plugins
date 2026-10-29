import { z } from 'zod'
import { uwDiagnosticSchema } from './uw-diagnostics.ts'
import { specDraftSchema } from './uw-spec-schema.ts'

const positionSchema = z.strictObject({ line: z.number().int().positive(), column: z.number().int().positive() })
const sourceSpanSchema = z.strictObject({ start: positionSchema, end: positionSchema })
const criterionSourceSchema = z.strictObject({
  id: z.string().nullable(),
  statement: z.string(),
  span: sourceSpanSchema,
  source: z.string(),
})
const contentTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('section'), section: z.enum(['origin', 'context', 'change']) }),
  z.strictObject({ kind: z.literal('exclusion'), index: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('open-question'), index: z.number().int().nonnegative() }),
])
const preservedContentSchema = z.strictObject({
  span: sourceSpanSchema,
  text: z.string(),
  sectionHint: z.string().min(1).optional(),
})

/** Existing normalization extraction form. Source ids may be absent; they are not allocated criterion identities. */
export const issueSpecAnalysisSchema = z.strictObject({
  criterionSources: z.array(criterionSourceSchema),
  invariantSources: z.array(criterionSourceSchema),
  contentSources: z.array(
    z.strictObject({
      target: contentTargetSchema,
      statement: z.string(),
      span: sourceSpanSchema,
      source: z.string(),
    }),
  ),
  preservedContent: z.array(preservedContentSchema),
})
export type IssueSpecAnalysis = z.infer<typeof issueSpecAnalysisSchema>

export const unframedParserSchema = z
  .strictObject({
    status: z.enum(['legacy', 'malformed', 'draft']),
    diagnostics: z.array(uwDiagnosticSchema),
    analysis: issueSpecAnalysisSchema,
    draft: specDraftSchema.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.status === 'draft') !== (value.draft !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['draft'],
        message: 'unframed draft is present only when parser status is draft',
      })
    }
  })
export type UnframedParser = z.infer<typeof unframedParserSchema>
