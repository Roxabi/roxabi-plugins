import { z } from 'zod'
import { codeRangeSchema } from './code-range-schema.ts'
import { criterionDeclarationSchema } from './criterion-evidence-schema.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { implementationCommandSchema } from './record-values.ts'
import { ownSpecRefSchema } from './uw-spec-schema.ts'
import { parentCoverageSchema } from './workflow-mandate-schema.ts'

export const integrationOutputSchema = z.strictObject({
  outcome: z.literal('integrated'),
  code: codeRangeSchema,
  children: z
    .array(
      z.strictObject({
        spec: ownSpecRefSchema,
        code: codeRangeSchema,
        sources: z.array(externalRecordRefSchema).min(1),
      }),
    )
    .min(1),
  coverage: parentCoverageSchema,
  commands: z.array(implementationCommandSchema),
  criteria: z.array(criterionDeclarationSchema),
  reason: z.string(),
})
export type IntegrationOutput = z.infer<typeof integrationOutputSchema>
