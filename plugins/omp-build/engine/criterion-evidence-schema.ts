import { z } from 'zod'
import { pinnedFileRefSchema, recordInputRefSchema } from './action-input-refs.ts'
import { criterionTargetSchema } from './finding-target-schema.ts'
import { externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import { identifierSchema, sha256Schema } from './schema-primitives.ts'
export const observationRefSchema = z.union([recordInputRefSchema, pinnedFileRefSchema])
export type ObservationRef = z.infer<typeof observationRefSchema>

export const CRITERION_EVIDENCE_FORMAT = 'omp-build-criterion-evidence/1' as const

export const codeVersionSchema = z.strictObject({
  repository: z.string().min(1),
  commit: gitObjectIdSchema,
})
export type CodeVersion = z.infer<typeof codeVersionSchema>

export const commandOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('combined'), text: z.string() }),
  z.strictObject({ kind: z.literal('separate'), stdout: z.string(), stderr: z.string() }),
  z.strictObject({
    kind: z.literal('sdk-view'),
    text: z.string(),
    source: z.literal('native-tool-result'),
    completeness: z.enum(['potentially-incomplete', 'known-incomplete']),
  }),
])
export type CommandOutput = z.infer<typeof commandOutputSchema>
export const gitBoundaryObservationSchema = z.strictObject({
  repository: z.string().min(1),
  commit: gitObjectIdSchema,
  tree: gitObjectIdSchema,
})
export type GitBoundaryObservation = z.infer<typeof gitBoundaryObservationSchema>
export const commandRunSchema = z.strictObject({
  toolCallId: identifierSchema,
  command: z.string().min(1),
  exitCode: z.number().int(),
  output: commandOutputSchema,
  context: z.strictObject({
    probeCwd: z.string().nullable(),
    start: gitBoundaryObservationSchema.nullable(),
    end: gitBoundaryObservationSchema.nullable(),
  }),
})
export type CommandRun = z.infer<typeof commandRunSchema>
export const executionVersionClaimSchema = z.strictObject({
  code: codeVersionSchema,
  reason: z.string().min(1),
  references: z.array(observationRefSchema),
})
export type ExecutionVersionClaim = z.infer<typeof executionVersionClaimSchema>
export const testExecutionSchema = z.strictObject({
  run: commandRunSchema,
  versionClaim: executionVersionClaimSchema,
})
export type TestExecution = z.infer<typeof testExecutionSchema>
const nativeProvenanceSchema = z.strictObject({
  kind: z.literal('native'),
  actionId: identifierSchema,
  childId: identifierSchema,
  submissionIndex: z.number().int().nonnegative(),
  toolCallIds: z.array(identifierSchema),
})
const operatorProvenanceSchema = z.strictObject({ kind: z.literal('operator'), source: externalRecordRefSchema })
export const evidenceProvenanceSchema = z.discriminatedUnion('kind', [nativeProvenanceSchema, operatorProvenanceSchema])
const testProvenanceSchema = z.discriminatedUnion('kind', [
  nativeProvenanceSchema.extend({ toolCallIds: z.array(identifierSchema).min(1) }),
  operatorProvenanceSchema,
])
export type EvidenceProvenance = z.infer<typeof evidenceProvenanceSchema>
const evidenceBase = {
  format: z.literal(CRITERION_EVIDENCE_FORMAT),
  id: identifierSchema,
  target: criterionTargetSchema,
  code: codeVersionSchema,
  provenance: evidenceProvenanceSchema,
}
const promptObservationEvidenceSchema = z.strictObject({
  ...evidenceBase,
  method: z.literal('prompt-observation'),
  scenario: z.string().min(1),
  observedResult: z.string().min(1),
  references: z.array(observationRefSchema).min(1),
})
const manualInterfaceEvidenceSchema = z.strictObject({
  ...evidenceBase,
  method: z.literal('manual-interface'),
  steps: z.array(z.string().min(1)).min(1),
  address: z.string().min(1),
  observedResult: z.string().min(1),
  references: z.array(observationRefSchema).min(1),
})
const contentReadingEvidenceSchema = z.strictObject({
  ...evidenceBase,
  method: z.literal('content-reading'),
  references: z.array(pinnedFileRefSchema).min(1),
  finding: z.string().min(1),
})
const testEvidenceSchema = z.strictObject({
  ...evidenceBase,
  provenance: testProvenanceSchema,
  method: z.literal('test'),
  scenario: z.string().min(1),
  after: testExecutionSchema,
  before: testExecutionSchema.nullable(),
})
const producerPromptObservationEvidenceSchema = promptObservationEvidenceSchema.omit({ provenance: true })
const producerManualInterfaceEvidenceSchema = manualInterfaceEvidenceSchema.omit({ provenance: true })
const producerContentReadingEvidenceSchema = contentReadingEvidenceSchema.omit({ provenance: true })
export const criterionEvidenceSchema = z.discriminatedUnion('method', [
  testEvidenceSchema,
  promptObservationEvidenceSchema,
  manualInterfaceEvidenceSchema,
  contentReadingEvidenceSchema,
])
export type CriterionEvidence = z.infer<typeof criterionEvidenceSchema>
export const evidenceRefSchema = z.strictObject({
  receipt: externalRecordRefSchema,
  evidenceId: identifierSchema,
  digest: sha256Schema,
})
export type EvidenceRef = z.infer<typeof evidenceRefSchema>
export const producerTestExecutionSchema = z.strictObject({
  toolCallId: identifierSchema,
  versionClaim: executionVersionClaimSchema,
})
export type ProducerTestExecution = z.infer<typeof producerTestExecutionSchema>
export const producerTestCitationSchema = z.strictObject({
  id: identifierSchema,
  target: criterionTargetSchema,
  method: z.literal('test'),
  scenario: z.string().min(1),
  after: producerTestExecutionSchema,
  before: producerTestExecutionSchema.nullable(),
})
export type ProducerTestCitation = z.infer<typeof producerTestCitationSchema>
export const producerCriterionDeclarationSchema = z.discriminatedUnion('verification', [
  z.strictObject({
    target: criterionTargetSchema,
    verification: z.literal('evidence'),
    evidence: z
      .array(
        z.union([
          producerTestCitationSchema,
          producerPromptObservationEvidenceSchema,
          producerManualInterfaceEvidenceSchema,
          producerContentReadingEvidenceSchema,
        ]),
      )
      .min(1),
  }),
  z.strictObject({
    target: criterionTargetSchema,
    verification: z.literal('unverified'),
    reason: z.string().min(1),
  }),
])
export type ProducerCriterionDeclaration = z.infer<typeof producerCriterionDeclarationSchema>
export const criterionDeclarationSchema = z.discriminatedUnion('verification', [
  z.strictObject({
    target: criterionTargetSchema,
    verification: z.literal('evidence'),
    evidence: z.array(criterionEvidenceSchema).min(1),
  }),
  z.strictObject({
    target: criterionTargetSchema,
    verification: z.literal('unverified'),
    reason: z.string().min(1),
  }),
])
export type CriterionDeclaration = z.infer<typeof criterionDeclarationSchema>
