import { z } from 'zod'
import { contextNegativeBindingSchema, missingContextOutputSchema } from './action-context.ts'
import {
  commandRunSchema,
  evidenceProvenanceSchema,
  producerCriterionDeclarationSchema,
} from './criterion-evidence-schema.ts'
import { type CriterionVerdict, criterionVerdictSchema } from './criterion-verdict-schema.ts'
import { identifierSchema, jsonSchema, repoRelativePathSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'

export type { Json, Scope } from './schema-primitives.ts'
export { identifierSchema, jsonSchema, repoRelativePathSchema, scopeSchema, sha256Schema }
export const shaSchema = z.string().min(1)

export const diagnosticSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  recordId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  findingId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  detail: jsonSchema.optional(),
})
export type Diagnostic = z.infer<typeof diagnosticSchema>

export const labelSchema = z.enum([
  'issue',
  'issue(blocking)',
  'todo',
  'suggestion(blocking)',
  'suggestion',
  'suggestion(non-blocking)',
  'nitpick',
  'thought',
  'question',
  'praise',
])
export type Label = z.infer<typeof labelSchema>

export const verdictSchema = z.enum(['Request changes', 'Approve with comments', 'Approve', 'Approve (clean)'])
export type Verdict = z.infer<typeof verdictSchema>
export const groupSchema = z.enum(['Blockers', 'Warnings', 'Suggestions', 'Praise'])
export type Group = z.infer<typeof groupSchema>
export const phaseSchema = z.enum(['spec', 'panel', 'recall', 'intake', 'synthesis', 'fix', 'falsification'])
export type Phase = z.infer<typeof phaseSchema>
export const locationSchema = z.strictObject({ file: z.string().min(1), line: z.number().int().positive() })
export type Location = z.infer<typeof locationSchema>

export const policySchema = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal('baseline') }),
  z.strictObject({ version: z.literal('evidence-v1'), acceptanceRef: identifierSchema }),
])
export type Policy = z.infer<typeof policySchema>

export const findingSchema = z.strictObject({
  label: labelSchema,
  description: z.string().min(1),
  location: locationSchema,
  rootCause: z.string().min(1),
  symptomsEvidence: z.string().min(1),
  classes: z.array(identifierSchema).optional(),
  rawCallsites: z.array(locationSchema).optional(),
  confidence: jsonSchema.optional(),
  extensions: z.record(z.string(), jsonSchema).optional(),
})
export type FindingData = z.infer<typeof findingSchema>

export const findingReportSchema = z.strictObject({ findings: z.array(findingSchema) })
export type FindingReport = z.infer<typeof findingReportSchema>
export const specRowSchema = criterionVerdictSchema
export type SpecRow = CriterionVerdict
export const specReportSchema = findingReportSchema.extend({ specRows: z.array(specRowSchema) }).strict()
export type SpecReport = z.infer<typeof specReportSchema>

export const originalFindingSchema = z.strictObject({
  id: identifierSchema,
  attemptIndex: z.number().int().nonnegative(),
  data: jsonSchema,
})
export type OriginalFinding = z.infer<typeof originalFindingSchema>
export const nativeProofBashCallSchema = z.strictObject({
  toolCallId: identifierSchema,
  input: jsonSchema,
  effectiveCwd: z.string().nullable(),
  result: jsonSchema.nullable(),
  exitCode: z.number().int().nullable(),
})
export type NativeProofBashCallRecord = z.infer<typeof nativeProofBashCallSchema>
export const submissionSchema = z.strictObject({
  attemptIndex: z.number().int().nonnegative(),
  data: jsonSchema.nullable(),
  raw: jsonSchema,
  partialText: z.string().nullable(),
})
export type Submission = z.infer<typeof submissionSchema>
export const nativeOutcomeSchema = z.strictObject({
  completion: z.enum(['completed', 'error', 'cancelled', 'incomplete']),
  strict: z.enum(['valid', 'invalid', 'absent']),
  raw: jsonSchema,
  observation: z
    .strictObject({
      actionId: identifierSchema,
      childId: identifierSchema,
      submissionIndex: z.number().int().nonnegative(),
      submission: submissionSchema,
    })
    .optional(),
  commandRuns: z.array(commandRunSchema).optional(),
  commandProvenance: evidenceProvenanceSchema.optional(),
  bashCalls: z.array(nativeProofBashCallSchema).optional(),
})
export type NativeOutcome = z.infer<typeof nativeOutcomeSchema>
export const contributionSchema = z
  .strictObject({
    content: z.enum(['operator-request', 'findings', 'decision', 'action-result']),
    inventoryId: identifierSchema.nullable(),
    host: z.strictObject({
      origin: z.enum(['native', 'operator']),
      phase: phaseSchema.nullable(),
      role: identifierSchema.nullable(),
      slotId: identifierSchema.nullable(),
      chunk: z.number().int().nonnegative().nullable(),
      childId: identifierSchema.nullable(),
      action: contextNegativeBindingSchema.optional(),
    }),
    rawAttempts: z.array(submissionSchema),
    native: nativeOutcomeSchema.nullable(),
    structured: jsonSchema.nullable(),
    findings: z.array(originalFindingSchema).nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.host.slotId !== null &&
      missingContextOutputSchema.safeParse(value.structured).success &&
      (value.host.origin !== 'native' || !value.host.action)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['host', 'action'],
        message: 'missing-context contributions require their native action binding',
      })
    }
  })
export type Contribution = z.infer<typeof contributionSchema>
export const commandResultSchema = z.strictObject({
  command: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
})
/** T3 model claim only. Streams and cwd stay on the host capture, not this command. */
export const implementationCommandSchema = z.strictObject({
  toolCallId: identifierSchema,
  command: z.string(),
  exitCode: z.number().int(),
})
export type ImplementationCommand = z.infer<typeof implementationCommandSchema>
const selectedProofEvidence = { proofToolCallId: identifierSchema, proofUnavailableReason: z.null() }
const unavailableProofEvidence = { proofToolCallId: z.null(), proofUnavailableReason: z.string().min(1) }
const guardInventoryEntrySchema = z.strictObject({
  guardId: identifierSchema,
  productionGuard: z.string().min(1),
  paths: z.array(z.string().min(1)),
  intendedScenario: z.string().min(1),
})
const uniqueGuardIds = <T extends { guardId: string }>(entries: readonly T[], context: z.RefinementCtx): void => {
  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    if (seen.has(entry.guardId))
      context.addIssue({ code: 'custom', path: [index, 'guardId'], message: `Guard ${entry.guardId} is repeated` })
    seen.add(entry.guardId)
  })
}
const guardInventorySchema = z.array(guardInventoryEntrySchema).superRefine(uniqueGuardIds)
const appliedActionResultFields = {
  outcome: z.literal('applied'),
  commitSHAs: z.array(z.string()),
  commands: z.array(commandResultSchema),
  proofPaths: z.array(repoRelativePathSchema),
  guardInventory: guardInventorySchema,
  criteria: z.array(producerCriterionDeclarationSchema).optional(),
}
const failedActionResultFields = {
  outcome: z.literal('failed'),
  commitSHAs: z.array(z.string()),
  commands: z.array(commandResultSchema),
  proofPaths: z.array(repoRelativePathSchema),
  guardInventory: z.null(),
  criteria: z.array(producerCriterionDeclarationSchema).optional(),
}
export const applyActionResultSchema = z.union([
  z.strictObject({ ...appliedActionResultFields, ...selectedProofEvidence }),
  z.strictObject({ ...appliedActionResultFields, ...unavailableProofEvidence }),
  z.strictObject({ ...failedActionResultFields, ...selectedProofEvidence }),
  z.strictObject({ ...failedActionResultFields, ...unavailableProofEvidence }),
])
const guardFactFields = {
  guardId: identifierSchema,
  removed: z.boolean(),
  intendedScenario: z.string().min(1),
  proofFailed: z.boolean(),
}
const guardFactSchema = z.union([
  z.strictObject({ ...guardFactFields, ...selectedProofEvidence }),
  z.strictObject({ ...guardFactFields, ...unavailableProofEvidence }),
])
const guardFactsSchema = z.array(guardFactSchema).min(1).superRefine(uniqueGuardIds)
export const falsifyActionResultSchema = z.strictObject({
  facts: guardFactsSchema,
  skippedReason: z.string().nullable(),
  commands: z.array(commandResultSchema),
  criteria: z.array(producerCriterionDeclarationSchema).optional(),
})
export const actionResultSchema = z.union([applyActionResultSchema, falsifyActionResultSchema])
export type ActionResult = z.infer<typeof actionResultSchema>

export const recallClassSchema = z.strictObject({
  classId: identifierSchema,
  chunks: z.array(z.number().int().nonnegative()),
  callsites: z.array(locationSchema),
  sourceFindingIds: z.array(identifierSchema),
})
export type RecallClass = z.infer<typeof recallClassSchema>
export const recallPlanSchema = z.strictObject({
  index: z.array(recallClassSchema),
  triggeredClassIds: z.array(identifierSchema),
  diagnostics: z.array(diagnosticSchema),
})
export type RecallPlan = z.infer<typeof recallPlanSchema>
export const slotSchema = z.strictObject({
  slotId: identifierSchema,
  phase: phaseSchema,
  role: identifierSchema,
  chunk: z.number().int().nonnegative().nullable(),
  required: z.boolean(),
  output: z.enum(['spec', 'findings', 'decision', 'action-result']),
  classId: identifierSchema.nullable(),
  sourceFindingIds: z.array(identifierSchema),
  action: contextNegativeBindingSchema.optional(),
  correction: z
    .strictObject({
      phase: z.enum(['apply', 'falsify', 'restore-proof', 'revalidate']),
      causeId: identifierSchema,
      context: jsonSchema,
    })
    .optional(),
})
export type Slot = z.infer<typeof slotSchema>
