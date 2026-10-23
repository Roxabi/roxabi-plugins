import { createHash } from 'node:crypto'
import { z } from 'zod'

export const jsonSchema = z.json()
export type Json = z.infer<typeof jsonSchema>

const identifierSchema = z.string().min(1)
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const shaSchema = z.string().min(1)

export const scopeSchema = z.strictObject({ repository: z.string(), target: z.string() })
export type Scope = z.infer<typeof scopeSchema>

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
export const specRowSchema = z.strictObject({ criterionText: z.string().min(1), verdict: z.enum(['met', 'missing']) })
export type SpecRow = z.infer<typeof specRowSchema>
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
export const nativeOutcomeSchema = z.strictObject({
  completion: z.enum(['completed', 'error', 'cancelled', 'incomplete']),
  strict: z.enum(['valid', 'invalid', 'absent']),
  raw: jsonSchema,
  bashCalls: z.array(nativeProofBashCallSchema).optional(),
})
export type NativeOutcome = z.infer<typeof nativeOutcomeSchema>
export const submissionSchema = z.strictObject({
  attemptIndex: z.number().int().nonnegative(),
  data: jsonSchema.nullable(),
  raw: jsonSchema,
  partialText: z.string().nullable(),
})
export type Submission = z.infer<typeof submissionSchema>
export const contributionSchema = z.strictObject({
  content: z.enum(['operator-request', 'findings', 'decision', 'action-result']),
  inventoryId: identifierSchema.nullable(),
  host: z.strictObject({
    origin: z.enum(['native', 'operator']),
    phase: phaseSchema.nullable(),
    role: identifierSchema.nullable(),
    slotId: identifierSchema.nullable(),
    chunk: z.number().int().nonnegative().nullable(),
    childId: identifierSchema.nullable(),
  }),
  rawAttempts: z.array(submissionSchema),
  native: nativeOutcomeSchema.nullable(),
  structured: jsonSchema.nullable(),
  findings: z.array(originalFindingSchema).nullable(),
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
const repoRelativePathSchema = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?![A-Za-z]:\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\r\n\\]+$/)
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
}
const failedActionResultFields = {
  outcome: z.literal('failed'),
  commitSHAs: z.array(z.string()),
  commands: z.array(commandResultSchema),
  proofPaths: z.array(repoRelativePathSchema),
  guardInventory: z.null(),
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
})
export type Slot = z.infer<typeof slotSchema>

export const observedCommentSchema = z.strictObject({
  locator: z.string().min(1),
  nativeId: z.string().min(1).nullable(),
  body: z.string(),
  author: z.string().min(1).nullable(),
  createdAt: z.string().min(1).nullable(),
  updatedAt: z.string().min(1).nullable(),
})
export type ObservedComment = z.infer<typeof observedCommentSchema>
const selectedProofPartSchema = z.strictObject({
  id: z.number().int().positive(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export const reviewInputSnapshotSchema = z.strictObject({
  body: z.strictObject({ body: z.string(), lastEditedAt: z.string().nullable() }).nullable(),
  spec: z
    .strictObject({ reference: z.string().min(1), body: z.string(), lastEditedAt: z.string().nullable() })
    .nullable(),
  semctxParts: z.array(selectedProofPartSchema).nullable(),
  assertledgerParts: z.array(selectedProofPartSchema).nullable(),
})
export type ReviewInputSnapshot = z.infer<typeof reviewInputSnapshotSchema>
export const reviewSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pull-request') }),
  z.strictObject({ kind: z.literal('epic-range'), range: z.string().regex(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/) }),
])
export type ReviewSubject = z.infer<typeof reviewSubjectSchema>
const initialPullRequestInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('initial'),
  purpose: z.literal('review'),
  tier: z.enum(['S', 'F-lite', 'F-full']),
  allocation: jsonSchema,
  policy: policySchema,
  subject: z.strictObject({ kind: z.literal('pull-request') }),
  inputSnapshot: reviewInputSnapshotSchema,
})
const initialEpicReviewInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('initial'),
  purpose: z.literal('review'),
  tier: z.null(),
  allocation: jsonSchema,
  policy: policySchema,
  subject: z.strictObject({ kind: z.literal('epic-range'), range: z.string().regex(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/) }),
  inputSnapshot: z.null(),
})
const initialCorrectionInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('initial'),
  purpose: z.literal('correction'),
  requestId: identifierSchema,
  policy: policySchema,
})
const recallInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('recall'),
  purpose: z.literal('review'),
  plan: recallPlanSchema,
  policy: policySchema,
})
const synthesisInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('synthesis'),
  purpose: z.enum(['review', 'correction']),
  policy: policySchema,
})
export const inventorySchema = z.union([
  initialPullRequestInventorySchema,
  initialEpicReviewInventorySchema,
  initialCorrectionInventorySchema,
  recallInventorySchema,
  synthesisInventorySchema,
])
export type Inventory = z.infer<typeof inventorySchema>

export const finalFindingSchema = z.discriminatedUnion('state', [
  z.strictObject({
    id: identifierSchema,
    label: labelSchema.nullable(),
    impactReason: z.string().min(1),
    state: z.literal('usable'),
    sourceFindingIds: z.array(identifierSchema).min(1),
    description: z.string().min(1),
    mergeReason: z.string().min(1).optional(),
  }),
  z.strictObject({
    id: identifierSchema,
    label: labelSchema.nullable(),
    impactReason: z.string().min(1),
    state: z.literal('unusable'),
    sourceFindingIds: z.tuple([identifierSchema]),
  }),
])
export type FinalFinding = z.infer<typeof finalFindingSchema>
export const causeSchema = z.strictObject({
  id: identifierSchema,
  title: z.string().min(1),
  mechanism: z.string().min(1),
  fix: z.string().min(1),
  failure: z.string().min(1),
  restored: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  proof: z.string().min(1),
  findingIds: z.array(identifierSchema).min(1),
  authorization: z.union([z.literal('required'), z.strictObject({ optionalNeighborOf: identifierSchema })]).optional(),
  admission: jsonSchema.optional(),
})
export type Cause = z.infer<typeof causeSchema>
export const standardsRowSchema = z.strictObject({ smell: z.string().min(1), assessment: z.string().min(1) })
export const reviewStandardsSchema = z.union([
  z.strictObject({ state: z.literal('ras') }),
  z.strictObject({ state: z.literal('observed'), rows: z.array(standardsRowSchema).min(1) }),
])
export type ReviewStandards = z.infer<typeof reviewStandardsSchema>
const reviewDecisionSchema = z.strictObject({
  purpose: z.literal('review'),
  policy: policySchema,
  sourceContributionIds: z.array(identifierSchema),
  findings: z.array(finalFindingSchema),
  causes: z.array(causeSchema),
  standards: reviewStandardsSchema.nullable(),
})
const correctionDecisionSchema = z.strictObject({
  purpose: z.literal('correction'),
  policy: policySchema,
  sourceContributionIds: z.array(identifierSchema),
  findings: z.array(finalFindingSchema),
  causes: z.array(causeSchema),
})
export const decisionSchema = z.discriminatedUnion('purpose', [reviewDecisionSchema, correctionDecisionSchema])
export type Decision = z.infer<typeof decisionSchema>
export const decisionPayloadSchema = z.strictObject({
  originalContributionId: identifierSchema,
  judgment: decisionSchema,
})

export const finalReviewSchema = z.strictObject({
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  inventoryIds: z.array(identifierSchema).min(1),
  decisionId: identifierSchema,
})
export type FinalReview = z.infer<typeof finalReviewSchema>
export const fixRequestSchema = z.strictObject({
  requestContributionId: identifierSchema,
  existingReviewId: identifierSchema.nullable(),
  scope: z.string().min(1),
  landing: z.literal(false),
})
export type FixRequest = z.infer<typeof fixRequestSchema>
export const correctionResultSchema = z.strictObject({
  decisionId: identifierSchema,
  causeId: identifierSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  outcome: z.enum(['applied', 'failed', 'reverted', 'withdrawn']),
  commitSHAs: z.array(shaSchema),
  raw: jsonSchema,
})
export type CorrectionResult = z.infer<typeof correctionResultSchema>
export const falsificationResultSchema = z.strictObject({
  correctionResultId: identifierSchema,
  result: z.enum(['pass', 'fail', 'skipped']),
  notes: z.string(),
  raw: jsonSchema,
})
export type FalsificationResult = z.infer<typeof falsificationResultSchema>
export const debtReceiptSchema = z.strictObject({
  decisionId: identifierSchema,
  findingIds: z.array(identifierSchema),
  causeIds: z.array(identifierSchema),
  disposition: z.enum(['filed', 'deferred', 'retained']),
  target: z.string().nullable(),
  evidence: jsonSchema,
})
export type DebtReceipt = z.infer<typeof debtReceiptSchema>
export const fixResultSchema = z.strictObject({
  requestId: identifierSchema,
  decisionId: identifierSchema,
  candidateGitSHA: shaSchema,
  correctionResultIds: z.array(identifierSchema),
  falsificationResultIds: z.array(identifierSchema),
  debtReceiptIds: z.array(identifierSchema),
})
export type FixResult = z.infer<typeof fixResultSchema>
export const stopSchema = z.strictObject({
  reason: z.enum(['review-bound', 'ci-failed']),
  reviewId: identifierSchema,
  detail: jsonSchema,
})
export type Stop = z.infer<typeof stopSchema>
export function specDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}
export const failedCheckFailureSchema = z.strictObject({
  name: z.string().min(1),
  source: z.string().min(1),
  observationId: z.string().min(1),
  conclusion: z.string().min(1),
})
export type FailedCheckFailure = z.infer<typeof failedCheckFailureSchema>

/** Digest of the exact supplied failure identity and outcome. Native metadata stays outside this hash. */
export function failedCheckEvidenceDigest(input: {
  candidateGitSHA: string
  scope: Scope
  failures: readonly FailedCheckFailure[]
}): string | null {
  if (input.candidateGitSHA.length === 0 || input.scope.repository.length === 0 || input.scope.target.length === 0)
    return null
  if (input.failures.length === 0) return null
  const seen = new Set<string>()
  const failures = input.failures.map((failure) => {
    if (
      failure.name.length === 0 ||
      failure.source.length === 0 ||
      failure.observationId.length === 0 ||
      failure.conclusion.length === 0
    )
      return null
    const key = `${failure.source}\0${failure.observationId}`
    if (seen.has(key)) return null
    seen.add(key)
    return {
      source: failure.source,
      observationId: failure.observationId,
      name: failure.name,
      conclusion: failure.conclusion,
    }
  })
  if (failures.some((failure) => failure === null)) return null
  failures.sort((left, right) => {
    if (left === null || right === null) return 0
    return (
      (left.source < right.source ? -1 : left.source > right.source ? 1 : 0) ||
      (left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0) ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
      (left.conclusion < right.conclusion ? -1 : left.conclusion > right.conclusion ? 1 : 0)
    )
  })
  return specDigest(
    JSON.stringify({
      candidateGitSHA: input.candidateGitSHA,
      scope: { repository: input.scope.repository, target: input.scope.target },
      failures,
    }),
  )
}

export const KIND_NAMES = [
  'review-attempt',
  'contribution',
  'decision',
  'review',
  'fix-request',
  'fix-result',
  'correction-result',
  'falsification-result',
  'debt-receipt',
  'proof',
  'stop',
  'epic-event',
  'mandate',
  'operator-control',
  'action-receipt',
  'workflow-binding',
] as const
export const kindSchema = z.enum(KIND_NAMES)
export const WORKFLOW_RECORD_KINDS = ['mandate', 'operator-control', 'action-receipt', 'workflow-binding'] as const
export type WorkflowRecordKind = (typeof WORKFLOW_RECORD_KINDS)[number]

export function isWorkflowKind(kind: string): kind is WorkflowRecordKind {
  return (WORKFLOW_RECORD_KINDS as readonly string[]).includes(kind)
}

export function stopBotMayAuthor(claimedKinds: readonly string[]): boolean {
  return claimedKinds.length > 0 && claimedKinds.every((kind) => kind === 'stop')
}

export const externalRecordRefSchema = z.strictObject({
  scope: scopeSchema,
  recordId: identifierSchema,
  kind: kindSchema,
})
export type ExternalRecordRef = z.infer<typeof externalRecordRefSchema>
export const scopedRecordRefSchema = externalRecordRefSchema
export type ScopedRecordRef = ExternalRecordRef

const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}$/)
const proofPinPathSchema = repoRelativePathSchema.refine(
  (path) => !path.includes('://'),
  'proof pin path must be a relative git path',
)

export const proofConfigPinSchema = z.strictObject({
  sourceCommit: gitObjectIdSchema,
  path: proofPinPathSchema,
  blob: gitObjectIdSchema.nullable(),
})
export type ProofConfigPin = z.infer<typeof proofConfigPinSchema>

export const specAssessmentSchema = z.strictObject({
  classification: z.enum(['editorial', 'material', 'unknown']),
})
export type SpecAssessment = z.infer<typeof specAssessmentSchema>
export const planStepSchema = z.strictObject({
  id: identifierSchema,
  change: z.string().min(1),
  doneWhen: z.string().min(1),
  criterion: z.string().min(1),
  evidence: z.string().min(1),
  paths: z.array(repoRelativePathSchema).min(1),
})
export const planBlockerRefSchema = z.strictObject({
  sourceId: identifierSchema,
  slotId: identifierSchema,
  blockerId: identifierSchema,
})
export type PlanBlockerRef = z.infer<typeof planBlockerRefSchema>
export const planResolutionSchema = z.strictObject({
  blocker: planBlockerRefSchema,
  stepIds: z.array(identifierSchema).min(1),
  reason: z.string().min(1),
})
export type PlanResolution = z.infer<typeof planResolutionSchema>
export const planOutputSchema = z
  .strictObject({
    steps: z.array(planStepSchema).min(1),
    resolutions: z.array(planResolutionSchema),
  })
  .superRefine((value, context) => {
    const stepIds = new Set<string>()
    for (const [index, step] of value.steps.entries()) {
      if (stepIds.has(step.id)) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'id'], message: 'step id is repeated' })
      }
      stepIds.add(step.id)
    }
    const seen = new Set<string>()
    for (const [index, resolution] of value.resolutions.entries()) {
      const key = `${resolution.blocker.sourceId}\0${resolution.blocker.slotId}\0${resolution.blocker.blockerId}`
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['resolutions', index, 'blocker'],
          message: 'resolution reference is repeated',
        })
      }
      seen.add(key)
      for (const [stepIndex, stepId] of resolution.stepIds.entries()) {
        if (!stepIds.has(stepId)) {
          context.addIssue({
            code: 'custom',
            path: ['resolutions', index, 'stepIds', stepIndex],
            message: 'resolution names an unknown step',
          })
        }
      }
    }
  })
export type PlanStep = z.infer<typeof planStepSchema>
export type PlanOutput = z.infer<typeof planOutputSchema>
export function planDigest(plan: PlanOutput): string {
  return specDigest(JSON.stringify(plan))
}
const planReviewBlockerSchema = z.strictObject({
  id: identifierSchema,
  criterion: z.string().min(1),
  gap: z.string().min(1),
})
export const planReviewSchema = z
  .strictObject({
    outcome: z.enum(['clear', 'blocking']),
    blockers: z.array(planReviewBlockerSchema),
  })
  .superRefine((value, context) => {
    if (value.outcome === 'clear' && value.blockers.length !== 0) {
      context.addIssue({ code: 'custom', path: ['blockers'], message: 'clear plan review has no blockers' })
    }
    if (value.outcome === 'blocking' && value.blockers.length === 0) {
      context.addIssue({ code: 'custom', path: ['blockers'], message: 'blocking plan review names a blocker' })
    }
    const ids = new Set<string>()
    for (const [index, blocker] of value.blockers.entries()) {
      if (ids.has(blocker.id)) {
        context.addIssue({ code: 'custom', path: ['blockers', index, 'id'], message: 'blocker id is repeated' })
      }
      ids.add(blocker.id)
    }
  })
export type PlanReview = z.infer<typeof planReviewSchema>
export const implementationOutputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('implemented'),
    commitSHAs: z.array(shaSchema).min(1),
    commands: z.array(implementationCommandSchema).min(1),
    proofToolCallId: identifierSchema,
    proofUnavailableReason: z.null(),
    reason: z.string(),
  }),
  z.strictObject({
    outcome: z.literal('blocked'),
    commitSHAs: z.array(shaSchema),
    commands: z.array(implementationCommandSchema),
    proofToolCallId: z.null(),
    proofUnavailableReason: z.string().min(1),
    reason: z.string().min(1),
  }),
])
export type ImplementationOutput = z.infer<typeof implementationOutputSchema>
export const ciAttributionSchema = z.strictObject({
  attribution: z.enum(['change', 'pre-existing', 'infra', 'unknown', 'out-of-scope']),
  evidence: jsonSchema,
})
export type CiAttribution = z.infer<typeof ciAttributionSchema>

const mandateConfigSchema = z.strictObject({
  productVersion: z.string().min(1),
  version: z.string().min(1),
  digest: sha256Schema,
  effective: jsonSchema,
})
const mandateSpecSchema = z.strictObject({
  reference: z.string().min(1),
  body: z.string(),
  bodySha256: sha256Schema,
  lastEditedAt: z.string().min(1),
})
const approvedChildSchema = z.strictObject({
  scope: scopeSchema,
  specDigest: sha256Schema,
  specBody: z.string(),
})
const mandateShared = {
  branch: z.string().min(1).nullable(),
  base: z.string().min(1),
  lineageHead: shaSchema.nullable(),
  config: mandateConfigSchema,
  proofPins: z.array(proofConfigPinSchema),
  parent: externalRecordRefSchema.nullable(),
  antecedent: externalRecordRefSchema.nullable(),
  spec: mandateSpecSchema,
}
const featureMandateSchema = z.strictObject({
  role: z.literal('feature'),
  ...mandateShared,
  run: z.null(),
  children: z.null(),
  permissions: z.strictObject({ landing: z.literal(true), correct: z.literal(true) }),
})
const epicMandateSchema = z.strictObject({
  role: z.literal('epic'),
  ...mandateShared,
  run: z.string().regex(/^[a-z0-9]{8}$/),
  children: z.array(approvedChildSchema),
  permissions: z.strictObject({ landing: z.boolean(), correct: z.boolean() }),
})
const fixOnlyMandateSchema = z.strictObject({
  role: z.literal('fix-only'),
  ...mandateShared,
  run: z.null(),
  children: z.null(),
  permissions: z.strictObject({ landing: z.literal(false), correct: z.literal(true) }),
})

function sameRefMeaning(refs: Array<ExternalRecordRef | null>, context: z.RefinementCtx): void {
  const seen = new Map<string, string>()
  for (const ref of refs) {
    if (ref === null) continue
    const key = `${ref.scope.repository}\0${ref.scope.target}\0${ref.recordId}`
    const prior = seen.get(key)
    if (prior !== undefined && prior !== ref.kind) {
      context.addIssue({
        code: 'custom',
        message: 'same scope and recordId must share one kind',
      })
    }
    seen.set(key, ref.kind)
  }
}

export const mandatePayloadSchema = z
  .discriminatedUnion('role', [featureMandateSchema, epicMandateSchema, fixOnlyMandateSchema])
  .superRefine((mandate, context) => {
    if (specDigest(mandate.spec.body) !== mandate.spec.bodySha256) {
      context.addIssue({ code: 'custom', path: ['spec', 'bodySha256'], message: 'spec body digest mismatch' })
    }
    sameRefMeaning([mandate.parent, mandate.antecedent], context)
    if (mandate.role !== 'epic') return
    const seenScopes = new Set<string>()
    for (const [index, child] of mandate.children.entries()) {
      const key = `${child.scope.repository}\0${child.scope.target}`
      if (seenScopes.has(key)) {
        context.addIssue({ code: 'custom', path: ['children', index, 'scope'], message: 'child scope is repeated' })
      }
      seenScopes.add(key)
      if (specDigest(child.specBody) !== child.specDigest) {
        context.addIssue({
          code: 'custom',
          path: ['children', index, 'specDigest'],
          message: 'child snapshot digest mismatch',
        })
      }
    }
  })
export type MandatePayload = z.infer<typeof mandatePayloadSchema>

const disarmSchema = z.strictObject({ observed: z.literal(true), evidence: jsonSchema })
const controlShared = { controlId: identifierSchema, mandate: externalRecordRefSchema }
export const operatorControlPayloadSchema = z
  .discriminatedUnion('control', [
    z.strictObject({ control: z.literal('pause-requested'), predecessor: z.null(), ...controlShared }),
    z.strictObject({
      control: z.literal('pause-confirmed'),
      predecessor: externalRecordRefSchema,
      disarm: disarmSchema,
      ...controlShared,
    }),
    z.strictObject({ control: z.literal('resume'), predecessor: externalRecordRefSchema, ...controlShared }),
    z.strictObject({
      control: z.literal('abandon'),
      predecessor: externalRecordRefSchema.nullable(),
      ...controlShared,
    }),
    z.strictObject({
      control: z.literal('accept-material'),
      predecessor: externalRecordRefSchema,
      assessment: externalRecordRefSchema,
      specDigest: sha256Schema,
      ...controlShared,
    }),
    z.strictObject({
      control: z.literal('select-successor'),
      predecessor: externalRecordRefSchema,
      successor: externalRecordRefSchema,
      ...controlShared,
    }),
  ])
  .superRefine((control, context) => {
    const refs: Array<ExternalRecordRef | null> = [control.mandate, control.predecessor]
    if (control.control === 'accept-material') refs.push(control.assessment)
    if (control.control === 'select-successor') refs.push(control.successor)
    sameRefMeaning(refs, context)
  })
export type OperatorControlPayload = z.infer<typeof operatorControlPayloadSchema>

export const workflowBindingPayloadSchema = z
  .strictObject({
    mandate: externalRecordRefSchema,
    branch: z.string().min(1),
    base: z.string().min(1),
  })
  .superRefine((payload, context) => {
    if (payload.mandate.kind !== 'mandate') {
      context.addIssue({
        code: 'custom',
        path: ['mandate', 'kind'],
        message: 'workflow binding must name a mandate',
      })
    }
  })
export type WorkflowBindingPayload = z.infer<typeof workflowBindingPayloadSchema>
export const workflowReceiptActionSchema = z.enum([
  'frame',
  'assess-spec',
  'plan',
  'plan-review',
  'implement',
  'attribute-ci',
])
export type WorkflowReceiptAction = z.infer<typeof workflowReceiptActionSchema>
const assessSpecExactSchema = z
  .strictObject({
    acceptedDigest: sha256Schema,
    currentDigest: sha256Schema,
    acceptedBody: z.string(),
    currentBody: z.string(),
  })
  .superRefine((value, context) => {
    if (specDigest(value.acceptedBody) !== value.acceptedDigest) {
      context.addIssue({ code: 'custom', path: ['acceptedDigest'], message: 'accepted body digest mismatch' })
    }
    if (specDigest(value.currentBody) !== value.currentDigest) {
      context.addIssue({ code: 'custom', path: ['currentDigest'], message: 'current body digest mismatch' })
    }
  })
const frameExactSchema = z.strictObject({
  specDigest: sha256Schema,
  branch: z.string().min(1),
  base: z.string().min(1),
})
export const PLAN_REVIEW_SPECIALISTS = ['R-workflow-plan-architect', 'R-workflow-plan-adversarial'] as const
export const planReviewSpecialistSchema = z.enum(PLAN_REVIEW_SPECIALISTS)
export const planReviewSlotSchema = z.strictObject({
  slotId: identifierSchema,
  specialist: planReviewSpecialistSchema,
})
export type PlanReviewSlot = z.infer<typeof planReviewSlotSchema>

const planExactSchema = z
  .strictObject({
    mandateId: identifierSchema,
    specDigest: sha256Schema,
    amendsReviewActionId: identifierSchema.nullable(),
    requiredBlockers: z.array(planBlockerRefSchema),
  })
  .superRefine((value, context) => {
    if (value.amendsReviewActionId === null && value.requiredBlockers.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['requiredBlockers'],
        message: 'a draft does not require review blockers',
      })
    }
    const seen = new Set<string>()
    for (const [index, ref] of value.requiredBlockers.entries()) {
      const key = `${ref.sourceId}\0${ref.slotId}\0${ref.blockerId}`
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['requiredBlockers', index],
          message: 'blocker reference is repeated',
        })
      }
      seen.add(key)
    }
  })
const planReviewExactSchema = z.strictObject({
  mandateId: identifierSchema,
  specDigest: sha256Schema,
  planDigest: sha256Schema,
  draftActionId: identifierSchema,
})
const implementExactSchema = z.strictObject({ mandateId: identifierSchema, planActionId: identifierSchema })
const ciExactSchema = z
  .strictObject({
    candidateGitSHA: shaSchema,
    scope: scopeSchema,
    failedChecks: z.array(z.string().min(1)),
    evidenceDigest: sha256Schema,
    failures: z.array(failedCheckFailureSchema).min(1),
  })
  .superRefine((value, context) => {
    const digest = failedCheckEvidenceDigest(value)
    if (digest === null || digest !== value.evidenceDigest) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceDigest'],
        message: 'evidence digest does not match the native check identity',
      })
    }
  })
export const implementationAdmissionCommandSchema = z.strictObject({
  toolCallId: identifierSchema,
  command: z.string(),
  exitCode: z.number().int(),
  cwd: z.string().min(1),
})
export type ImplementationAdmissionCommand = z.infer<typeof implementationAdmissionCommandSchema>
export const hostEffectAdmissionSchema = z.strictObject({
  admitted: z.boolean(),
  commits: z.array(gitObjectIdSchema),
  paths: z.array(repoRelativePathSchema),
  commands: z.array(implementationAdmissionCommandSchema),
  remoteBranch: z.string().min(1).nullable(),
  remoteTip: gitObjectIdSchema.nullable(),
  published: z.boolean(),
  reason: z.string(),
})
export type HostEffectAdmission = z.infer<typeof hostEffectAdmissionSchema>
const nestedPlanContributionSchema = contributionSchema.superRefine((value, context) => {
  if (value.inventoryId !== null) {
    context.addIssue({
      code: 'custom',
      path: ['inventoryId'],
      message: 'plan-review contribution inventoryId must be null',
    })
  }
  if (value.host.slotId === null) {
    context.addIssue({
      code: 'custom',
      path: ['host', 'slotId'],
      message: 'plan-review contribution names its declared slot',
    })
  }
})

function actionReceipt<A extends WorkflowReceiptAction, E extends z.ZodType, S extends z.ZodType>(
  action: A,
  exact: E,
  structured: S,
) {
  return [
    z.strictObject({
      phase: z.literal('start'),
      action: z.literal(action),
      actionId: identifierSchema,
      mandate: externalRecordRefSchema,
      exactInputs: exact,
    }),
    z.strictObject({
      phase: z.literal('result'),
      action: z.literal(action),
      actionId: identifierSchema,
      mandate: externalRecordRefSchema,
      start: externalRecordRefSchema,
      exactInputs: exact,
      native: nativeOutcomeSchema,
      structured: structured.nullable(),
      admission: hostEffectAdmissionSchema.nullable(),
      diagnostics: z.array(diagnosticSchema),
    }),
  ] as const
}

const declaredPlanSlots = (slots: readonly PlanReviewSlot[], context: z.RefinementCtx): void => {
  const ids = new Set<string>()
  const specialists = new Set<string>()
  for (const [index, slot] of slots.entries()) {
    if (ids.has(slot.slotId)) {
      context.addIssue({ code: 'custom', path: ['slots', index, 'slotId'], message: `slot ${slot.slotId} is repeated` })
    }
    ids.add(slot.slotId)
    if (specialists.has(slot.specialist)) {
      context.addIssue({
        code: 'custom',
        path: ['slots', index, 'specialist'],
        message: `specialist ${slot.specialist} is repeated`,
      })
    }
    specialists.add(slot.specialist)
  }
  for (const name of PLAN_REVIEW_SPECIALISTS) {
    if (!specialists.has(name)) {
      context.addIssue({ code: 'custom', path: ['slots'], message: `missing specialist ${name}` })
    }
  }
}
const [frameStart, frameResult] = actionReceipt('frame', frameExactSchema, z.null())
const [assessStart, assessResult] = actionReceipt('assess-spec', assessSpecExactSchema, specAssessmentSchema)
const [planStart, planResult] = actionReceipt('plan', planExactSchema, planOutputSchema)
const planReviewStart = z
  .strictObject({
    phase: z.literal('start'),
    action: z.literal('plan-review'),
    actionId: identifierSchema,
    mandate: externalRecordRefSchema,
    exactInputs: planReviewExactSchema,
    slots: z.array(planReviewSlotSchema).length(PLAN_REVIEW_SPECIALISTS.length),
  })
  .superRefine((value, context) => declaredPlanSlots(value.slots, context))
const planReviewResult = z.strictObject({
  phase: z.literal('result'),
  action: z.literal('plan-review'),
  actionId: identifierSchema,
  mandate: externalRecordRefSchema,
  start: externalRecordRefSchema,
  exactInputs: planReviewExactSchema,
  slots: z.array(planReviewSlotSchema).length(PLAN_REVIEW_SPECIALISTS.length),
  contributions: z.array(nestedPlanContributionSchema),
  native: nativeOutcomeSchema,
  structured: z.null(),
  admission: hostEffectAdmissionSchema.nullable(),
  diagnostics: z.array(diagnosticSchema),
})
const [implementStart, implementResult] = actionReceipt('implement', implementExactSchema, implementationOutputSchema)
const [ciStart, ciResult] = actionReceipt('attribute-ci', ciExactSchema, ciAttributionSchema)
// z.infer of the combined union drops action/phase pairing. The explicit union is the type.
export type AssessSpecResultPayload = z.infer<typeof assessResult>
export type ActionReceiptPayload =
  | z.infer<typeof frameStart>
  | z.infer<typeof frameResult>
  | z.infer<typeof assessStart>
  | z.infer<typeof assessResult>
  | z.infer<typeof planStart>
  | z.infer<typeof planResult>
  | z.infer<typeof planReviewStart>
  | z.infer<typeof planReviewResult>
  | z.infer<typeof implementStart>
  | z.infer<typeof implementResult>
  | z.infer<typeof ciStart>
  | z.infer<typeof ciResult>
export const actionReceiptPayloadSchema = z
  .union([
    frameStart,
    frameResult,
    assessStart,
    assessResult,
    planStart,
    planResult,
    planReviewStart,
    planReviewResult,
    implementStart,
    implementResult,
    ciStart,
    ciResult,
  ])
  .superRefine((receipt, context) => {
    const refs: ExternalRecordRef[] = [receipt.mandate]
    if (receipt.phase === 'result') refs.push(receipt.start)
    sameRefMeaning(refs, context)
    if (receipt.action !== 'plan-review') return
    declaredPlanSlots(receipt.slots, context)
    if (receipt.phase !== 'result') return
    const ids = new Set(receipt.slots.map((slot) => slot.slotId))
    for (const [index, contribution] of receipt.contributions.entries()) {
      if (contribution.host.slotId === null || !ids.has(contribution.host.slotId)) {
        context.addIssue({
          code: 'custom',
          path: ['contributions', index, 'host', 'slotId'],
          message: 'contribution slot is not declared',
        })
      }
    }
  }) as z.ZodType<ActionReceiptPayload>

const envelope = {
  version: z.literal(1),
  recordId: identifierSchema,
  runId: identifierSchema,
  operationId: identifierSchema,
  inputs: z.array(identifierSchema),
}
const record = <K extends string, T extends z.ZodType>(kind: K, payload: T) =>
  scopeSchema.extend({ ...envelope, kind: z.literal(kind), payload }).strict()
export type CanonicalRecord = {
  [K in keyof PayloadByKind]: {
    repository: string
    target: string
    version: 1
    recordId: string
    runId: string
    operationId: string
    inputs: string[]
    kind: K
    payload: PayloadByKind[K]
  }
}[keyof PayloadByKind]
type PayloadByKind = {
  'review-attempt': z.infer<typeof inventorySchema>
  contribution: z.infer<typeof contributionSchema>
  decision: z.infer<typeof decisionPayloadSchema>
  review: z.infer<typeof finalReviewSchema>
  'fix-request': z.infer<typeof fixRequestSchema>
  'fix-result': z.infer<typeof fixResultSchema>
  'correction-result': z.infer<typeof correctionResultSchema>
  'falsification-result': z.infer<typeof falsificationResultSchema>
  'debt-receipt': z.infer<typeof debtReceiptSchema>
  proof: { candidateGitSHA: string; data: Json }
  stop: z.infer<typeof stopSchema>
  'epic-event': Json
  mandate: MandatePayload
  'operator-control': OperatorControlPayload
  'action-receipt': ActionReceiptPayload
  'workflow-binding': WorkflowBindingPayload
}
// The schema stays the runtime authority. Its inferred union is too large for TS to
// keep kind and payload paired, so the export type is the explicit pairing above.
export const recordSchema = z.discriminatedUnion('kind', [
  record('review-attempt', inventorySchema),
  record('contribution', contributionSchema),
  record('decision', decisionPayloadSchema),
  record('review', finalReviewSchema),
  record('fix-request', fixRequestSchema),
  record('fix-result', fixResultSchema),
  record('correction-result', correctionResultSchema),
  record('falsification-result', falsificationResultSchema),
  record('debt-receipt', debtReceiptSchema),
  record('proof', z.strictObject({ candidateGitSHA: shaSchema, data: jsonSchema })),
  record('stop', stopSchema),
  record('epic-event', jsonSchema),
  record('mandate', mandatePayloadSchema),
  record('operator-control', operatorControlPayloadSchema),
  record('action-receipt', actionReceiptPayloadSchema),
  record('workflow-binding', workflowBindingPayloadSchema),
]) as z.ZodType<CanonicalRecord>
export type Kind = CanonicalRecord['kind']
export type Payloads = {
  [K in Kind]: Extract<CanonicalRecord, { kind: K }>['payload']
}

export const historySchema = z.strictObject({
  scope: scopeSchema,
  expectedAuthor: z.string().min(1),
  stopAuthor: z.string().min(1).nullable(),
  complete: z.boolean(),
  comments: z.array(observedCommentSchema),
  diagnostics: z.array(diagnosticSchema),
})
export type History = z.infer<typeof historySchema>
export const operationAuthoritySchema = z.enum(['authority', 'foreign', 'accounted'])
export type OperationAuthority = z.infer<typeof operationAuthoritySchema>
export const operationReadSchema = z.strictObject({
  operationId: z.string().min(1).nullable(),
  recordId: z.string().min(1).nullable(),
  kind: z.string().min(1).nullable(),
  status: z.enum(['complete', 'incomplete', 'conflict', 'invalid', 'legacy']),
  parts: z.array(observedCommentSchema),
  record: recordSchema.nullable(),
  claimedKinds: z
    .array(z.string().min(1))
    .refine((kinds) => new Set(kinds).size === kinds.length, 'claimed kinds must be distinct'),
  authority: operationAuthoritySchema,
})
export type OperationRead = z.infer<typeof operationReadSchema>
export const decodedHistorySchema = z.strictObject({
  source: historySchema,
  operations: z.array(operationReadSchema),
  diagnostics: z.array(diagnosticSchema),
})
export type DecodedHistory = z.infer<typeof decodedHistorySchema>
