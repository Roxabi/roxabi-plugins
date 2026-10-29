import { z } from 'zod'
import { evidenceRefSchema, observationRefSchema } from './criterion-evidence-schema.ts'
import { criterionTargetSchema, findingTargetSchema } from './finding-target-schema.ts'
import { identifierSchema } from './schema-primitives.ts'
import { exclusionRefSchema } from './uw-spec-schema.ts'

export const codeLinkJudgmentSchema = z.strictObject({
  support: z.enum(['supported', 'unsupported', 'unknown']),
  reason: z.string().min(1),
  references: z.array(observationRefSchema),
})
export type CodeLinkJudgment = z.infer<typeof codeLinkJudgmentSchema>
export const evidenceCodeLinkSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('test'),
    after: codeLinkJudgmentSchema,
    before: codeLinkJudgmentSchema.nullable(),
  }),
  z.strictObject({ method: z.literal('observation'), current: codeLinkJudgmentSchema }),
])
export type EvidenceCodeLink = z.infer<typeof evidenceCodeLinkSchema>
export const evidenceJudgmentSchema = z.strictObject({
  evidence: evidenceRefSchema,
  truth: z.enum(['supported', 'unsupported', 'unknown']),
  applicability: z.enum(['applies', 'does-not-apply', 'unknown']),
  codeLink: evidenceCodeLinkSchema,
  reason: z.string().min(1),
})
export type EvidenceJudgment = z.infer<typeof evidenceJudgmentSchema>
export const criterionVerdictSchema = z.strictObject({
  target: criterionTargetSchema,
  verdict: z.enum(['satisfied', 'missing', 'unverified']),
  criterionKind: z.enum(['content', 'behavior']),
  bugRegression: z.boolean(),
  restoration: z.enum(['demonstrated', 'not-demonstrated', 'not-applicable']),
  examined: z.array(evidenceJudgmentSchema),
  reason: z.string().min(1),
})
export type CriterionVerdict = z.infer<typeof criterionVerdictSchema>
export const criterionVerdictRefSchema = z.strictObject({
  contributionId: identifierSchema,
  target: criterionTargetSchema,
})
export type CriterionVerdictRef = z.infer<typeof criterionVerdictRefSchema>
export const exclusionClaimSchema = z.strictObject({
  sourceFindingId: identifierSchema,
  target: findingTargetSchema,
  exclusion: exclusionRefSchema,
  concern: z.enum(['additional-work', 'introduced-regression', 'security', 'invariant-violation', 'unknown']),
  reason: z.string().min(1),
})
export type ExclusionClaim = z.infer<typeof exclusionClaimSchema>
export type ExclusionConcern = ExclusionClaim['concern']
