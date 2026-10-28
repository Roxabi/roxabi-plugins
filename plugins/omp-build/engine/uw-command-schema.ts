import { z } from 'zod'
import { scopeSchema, sha256Schema } from './record-values.ts'
import { complexityFactorsSchema, normalizationDecisionSchema, tierOverrideSchema } from './uw-normalization-schema.ts'
import { specDraftSchema } from './uw-spec-schema.ts'

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
const issueRefSchema = z.strictObject({ repository: repositorySchema, number: z.number().int().positive() })
const labelIntentSchema = z.strictObject({ add: z.array(z.string().min(1)), remove: z.array(z.string().min(1)) })
const relationIntentSchema = z.strictObject({
  parent: issueRefSchema.nullable().optional(),
  addChildren: z.array(issueRefSchema),
  removeChildren: z.array(issueRefSchema),
  addBlockers: z.array(issueRefSchema),
  removeBlockers: z.array(issueRefSchema),
})
const writesSchema = z.strictObject({ labels: labelIntentSchema, relations: relationIntentSchema })

const shared = {
  draft: specDraftSchema,
  title: z.string().min(1),
  factors: complexityFactorsSchema,
  writes: writesSchema,
  normalization: z.array(normalizationDecisionSchema),
  tierOverride: tierOverrideSchema,
}

/** Strict untrusted CLI JSON schemas; the host imports these only through dist/contracts.js. */
export const uwProposalInputSchema = z.strictObject({ uw: scopeSchema, sourceBodySha256: sha256Schema, ...shared })
export const uwCreateInputSchema = z.strictObject({ repository: repositorySchema, ...shared })
export type UwProposalInputJson = z.infer<typeof uwProposalInputSchema>
export type UwCreateInputJson = z.infer<typeof uwCreateInputSchema>
