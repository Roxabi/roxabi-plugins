import { z } from 'zod'
import {
  type ActionReceiptPayload,
  actionResultSchema,
  type CanonicalRecord,
  type Contribution,
  causeSchema,
  ciAttributionSchema,
  type DecodedHistory,
  type Diagnostic,
  decisionSchema,
  type ExternalRecordRef,
  findingReportSchema,
  findingSchema,
  type Group,
  implementationOutputSchema,
  isWorkflowKind,
  type Json,
  type Kind,
  type Label,
  type MandatePayload,
  type OperationAuthority,
  type OperatorControlPayload,
  planOutputSchema,
  planReviewSchema,
  type RecallClass,
  type RecallPlan,
  recordSchema,
  type Scope,
  type Stop,
  specAssessmentSchema,
  specReportSchema,
  type Verdict,
  type WorkflowBindingPayload,
} from './schemas.ts'

export { isWorkflowKind, stopBotMayAuthor, WORKFLOW_RECORD_KINDS } from './schemas.ts'

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: Diagnostic[]; knownReviews?: number; countExact?: boolean; spent?: boolean | null }

export type FindingInspection = { usable: boolean; knownLabel: Label | null; diagnostics: Diagnostic[] }
export type DecisionAssessment = {
  admissible: boolean
  groups: Record<Group, string[]>
  verdict: Verdict | null
  findings: { id: string; inspection: FindingInspection }[]
  diagnostics: Diagnostic[]
}
export type ReviewFacts = Scope & {
  candidateGitSHA: string
  input: string | null
  proofAdmission: Result<Json>
  ci: 'green' | 'red' | 'pending' | 'unknown'
  acceptedEvidencePolicyRef: string | null
}
export type ReviewSummary = {
  reviews: number
  reviewId: string | null
  verdict: Verdict | null
  head: string | null
  input: string | null
  at: string | null
  spent: boolean
}
export type ReviewState =
  | { ok: true; summary: ReviewSummary; next: 'review' | 'fix' | 'admit' | 'wait' | 'stop'; requiredStop: Stop | null }
  | {
      ok: false
      next: 'stop'
      knownReviews: number
      countExact: boolean
      spent: boolean | null
      diagnostics: Diagnostic[]
    }

export type RecordProjectionConfig = {
  taxonomy: readonly string[]
  acceptedPolicy: string | null
}

const diagnostic = (code: string, message: string, detail?: Json): Diagnostic =>
  detail === undefined ? { code, message } : { code, message, detail }
const fail = <T>(
  diagnostics: Diagnostic[],
  metadata: Omit<Extract<Result<T>, { ok: false }>, 'ok' | 'diagnostics'> = {},
): Result<T> => ({ ok: false, diagnostics, ...metadata })
export function equalScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length
const recordMap = (history: DecodedHistory): Map<string, CanonicalRecord> => {
  const records = new Map<string, CanonicalRecord>()
  for (const operation of history.operations) {
    if (operation.status === 'complete' && operation.record !== null && !records.has(operation.record.recordId))
      records.set(operation.record.recordId, operation.record)
  }
  return records
}

export type HistoryOperationClass = {
  index: number
  operationId: string | null
  authority: OperationAuthority
}
export type HistoryClassification = {
  classes: HistoryOperationClass[]
  authorityHistory: DecodedHistory
}

function stampedAuthority(operation: DecodedHistory['operations'][number]): OperationAuthority | null {
  const authority: unknown = Reflect.get(operation, 'authority')
  return authority === 'authority' || authority === 'foreign' || authority === 'accounted' ? authority : null
}

function stampedClaimedKinds(operation: DecodedHistory['operations'][number]): string[] | null {
  const claimedKinds: unknown = Reflect.get(operation, 'claimedKinds')
  if (
    !Array.isArray(claimedKinds) ||
    claimedKinds.some((kind) => typeof kind !== 'string' || kind.length === 0) ||
    new Set(claimedKinds).size !== claimedKinds.length
  )
    return null
  return claimedKinds
}

const claimsReviewOrStop = (operation: DecodedHistory['operations'][number]): boolean =>
  stampedClaimedKinds(operation)?.some((kind) => kind === 'review' || kind === 'stop') ?? false

const operationClaimsWorkflow = (operation: DecodedHistory['operations'][number]): boolean =>
  isWorkflowKind(operation.record?.kind ?? operation.kind ?? '') ||
  (stampedClaimedKinds(operation)?.some((kind) => isWorkflowKind(kind)) ?? false)

function retainAccountedWorkflow(history: DecodedHistory, authorities: OperationAuthority[]): void {
  const collided = new Set<number>()
  const byOperationId = new Map<string, number[]>()
  history.operations.forEach((operation, index) => {
    if (operation.operationId === null) return
    const indexes = byOperationId.get(operation.operationId) ?? []
    indexes.push(index)
    byOperationId.set(operation.operationId, indexes)
  })
  for (const indexes of byOperationId.values()) {
    const reviewOrStop = indexes.some((index) => claimsReviewOrStop(history.operations[index]))
    const workflow = indexes.some((index) => operationClaimsWorkflow(history.operations[index]))
    if (reviewOrStop && workflow) for (const index of indexes) collided.add(index)
  }
  history.operations.forEach((operation, index) => {
    if (!operationClaimsWorkflow(operation) || authorities[index] === 'foreign' || collided.has(index)) return
    authorities[index] = 'accounted'
  })
}

type CompleteRecord = { index: number; record: CanonicalRecord }

function correctionAccountedIndexes(history: DecodedHistory, authorities: readonly OperationAuthority[]): Set<number> {
  const byRecordId = new Map<string, CompleteRecord[]>()
  const operationCounts = new Map<string, number>()
  for (const [index, operation] of history.operations.entries()) {
    if (operation.operationId !== null)
      operationCounts.set(operation.operationId, (operationCounts.get(operation.operationId) ?? 0) + 1)
    if (
      operation.status !== 'complete' ||
      operation.record === null ||
      operation.operationId !== operation.record.operationId ||
      operation.recordId !== operation.record.recordId ||
      operation.kind !== operation.record.kind ||
      !equalScope(operation.record, history.source.scope) ||
      operation.parts.some((part) => part.author !== history.source.expectedAuthor)
    )
      continue
    const entries = byRecordId.get(operation.record.recordId) ?? []
    entries.push({ index, record: operation.record })
    byRecordId.set(operation.record.recordId, entries)
  }
  const uniqueRecord = (recordId: string): CompleteRecord | null => {
    const entries = byRecordId.get(recordId)
    if (entries === undefined || entries.length !== 1) return null
    const entry = entries[0]
    return operationCounts.get(entry.record.operationId) === 1 ? entry : null
  }
  const correctionRoot = (inventoryId: string): string | null => {
    const inventory = uniqueRecord(inventoryId)
    if (inventory?.record.kind !== 'review-attempt' || inventory.record.payload.purpose !== 'correction') return null
    const payload = inventory.record.payload
    if (payload.stage === 'initial') {
      const request = uniqueRecord(payload.requestId)
      return request?.record.kind === 'fix-request' &&
        payload.rootAttemptId === inventory.record.recordId &&
        inventory.record.inputs.includes(request.record.recordId)
        ? inventory.record.recordId
        : null
    }
    if (payload.stage !== 'synthesis') return null
    const root = uniqueRecord(payload.rootAttemptId)
    if (
      root?.record.kind !== 'review-attempt' ||
      root.record.payload.purpose !== 'correction' ||
      root.record.payload.stage !== 'initial'
    )
      return null
    const request = uniqueRecord(root.record.payload.requestId)
    return request?.record.kind === 'fix-request' &&
      root.record.inputs.includes(request.record.recordId) &&
      inventory.record.inputs.includes(root.record.recordId)
      ? root.record.recordId
      : null
  }
  const contributionRoots = new Map<string, string>()
  for (const entries of byRecordId.values()) {
    if (entries.length !== 1) continue
    const entry = entries[0]
    if (entry.record.kind !== 'contribution' || entry.record.payload.inventoryId === null) continue
    const root = correctionRoot(entry.record.payload.inventoryId)
    if (root !== null && entry.record.inputs.includes(entry.record.payload.inventoryId))
      contributionRoots.set(entry.record.recordId, root)
  }
  const accounted = new Set<number>()
  for (const entries of byRecordId.values()) {
    if (entries.length !== 1) continue
    const entry = entries[0]
    if (authorities[entry.index] !== 'authority') continue
    if (entry.record.kind === 'contribution' && contributionRoots.has(entry.record.recordId)) {
      accounted.add(entry.index)
      continue
    }
    if (entry.record.kind !== 'decision' || entry.record.payload.judgment.purpose !== 'correction') continue
    const root = contributionRoots.get(entry.record.payload.originalContributionId)
    const sources = entry.record.payload.judgment.sourceContributionIds
    if (
      root !== undefined &&
      sources.length > 0 &&
      entry.record.inputs.includes(entry.record.payload.originalContributionId) &&
      sources.every((sourceId) => contributionRoots.get(sourceId) === root) &&
      sources.every((sourceId) => entry.record.inputs.includes(sourceId))
    )
      accounted.add(entry.index)
  }
  return accounted
}

function promoteReviewDependencies(history: DecodedHistory, authorities: OperationAuthority[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const byRecordId = new Map<string, CompleteRecord[]>()
  for (const [index, operation] of history.operations.entries()) {
    if (operation.status !== 'complete' || operation.record === null) continue
    const entries = byRecordId.get(operation.record.recordId) ?? []
    entries.push({ index, record: operation.record })
    byRecordId.set(operation.record.recordId, entries)
  }
  const visit = (recordId: string, visiting: Set<string>): void => {
    if (visiting.has(recordId)) return
    const entries = byRecordId.get(recordId)
    if (entries === undefined) return
    if (entries.length !== 1) {
      for (const entry of entries) if (authorities[entry.index] !== 'foreign') authorities[entry.index] = 'authority'
      diagnostics.push(diagnostic('duplicate-reference', `Review dependency ${recordId} is ambiguous`))
      return
    }
    const entry = entries[0]
    if (authorities[entry.index] === 'foreign') return
    authorities[entry.index] = 'authority'
    const next = new Set(visiting)
    next.add(recordId)
    for (const input of entry.record.inputs) visit(input, next)
  }
  for (const [index, operation] of history.operations.entries()) {
    if (authorities[index] !== 'authority' || operation.record?.kind !== 'review') continue
    for (const input of operation.record.inputs) visit(input, new Set([operation.record.recordId]))
  }
  return diagnostics
}

export function classifyHistory(history: DecodedHistory): HistoryClassification {
  const unclassified: number[] = []
  const authorities: OperationAuthority[] = history.operations.map((operation, index) => {
    const authority = stampedAuthority(operation)
    if (authority !== null && stampedClaimedKinds(operation) !== null) return authority
    unclassified.push(index)
    return authority ?? 'authority'
  })
  const byOperationId = new Map<string, number[]>()
  history.operations.forEach((operation, index) => {
    if (operation.operationId === null) return
    const indexes = byOperationId.get(operation.operationId) ?? []
    indexes.push(index)
    byOperationId.set(operation.operationId, indexes)
  })
  for (const indexes of byOperationId.values()) {
    if (indexes.length < 2) continue
    const classifications = new Set(indexes.map((index) => authorities[index]))
    const reviewOrStop = indexes.some((index) => claimsReviewOrStop(history.operations[index]))
    if (classifications.size > 1 || (reviewOrStop && classifications.has('authority')))
      for (const index of indexes) authorities[index] = 'authority'
  }
  for (const index of correctionAccountedIndexes(history, authorities)) authorities[index] = 'accounted'
  const dependencyDiagnostics = promoteReviewDependencies(history, authorities)
  retainAccountedWorkflow(history, authorities)
  const classes = history.operations.map((operation, index) => ({
    index,
    operationId: operation.operationId,
    authority: authorities[index],
  }))
  const authorityOperationIds = new Set(
    classes
      .filter((entry) => entry.authority === 'authority' && entry.operationId !== null)
      .map((entry) => entry.operationId),
  )
  return {
    classes,
    authorityHistory: {
      ...history,
      source: history.source,
      operations: history.operations.filter((_, index) => authorities[index] === 'authority'),
      diagnostics: [
        ...history.diagnostics.filter(
          (diagnostic) => diagnostic.operationId === undefined || authorityOperationIds.has(diagnostic.operationId),
        ),
        ...dependencyDiagnostics,
        ...unclassified.map((index) =>
          diagnostic(
            'unclassified',
            `Operation ${history.operations[index].operationId ?? 'unknown'} has invalid authority or kind claims`,
          ),
        ),
      ],
    },
  }
}

export function parseRecord(value: unknown): Result<CanonicalRecord> {
  const parsed = recordSchema.safeParse(value)
  if (!parsed.success)
    return fail([
      diagnostic(
        'malformed',
        'Record does not match the canonical schema',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      ),
    ])
  const meaning = workflowInputMeaning(parsed.data)
  return meaning === null ? { ok: true, value: parsed.data } : fail([meaning])
}
export type RecordDraft = {
  [K in CanonicalRecord['kind']]: Omit<Extract<CanonicalRecord, { kind: K }>, 'inputs'>
}[CanonicalRecord['kind']]

function derivedInputs(draft: RecordDraft): string[] {
  switch (draft.kind) {
    case 'review-attempt':
      if (draft.payload.stage !== 'initial') return [draft.payload.rootAttemptId]
      return draft.payload.purpose === 'correction' ? [draft.payload.requestId] : []
    case 'contribution':
      return draft.payload.inventoryId === null ? [] : [draft.payload.inventoryId]
    case 'decision':
      return [draft.payload.originalContributionId, ...draft.payload.judgment.sourceContributionIds]
    case 'review':
      return [draft.payload.decisionId, ...draft.payload.inventoryIds]
    case 'fix-request':
      return draft.payload.existingReviewId === null
        ? [draft.payload.requestContributionId]
        : [draft.payload.requestContributionId, draft.payload.existingReviewId]
    case 'correction-result':
      return [draft.payload.decisionId]
    case 'falsification-result':
      return [draft.payload.correctionResultId]
    case 'debt-receipt':
      return [draft.payload.decisionId]
    case 'fix-result':
      return [
        draft.payload.requestId,
        draft.payload.decisionId,
        ...draft.payload.correctionResultIds,
        ...draft.payload.falsificationResultIds,
        ...draft.payload.debtReceiptIds,
      ]
    case 'stop':
      return [draft.payload.reviewId]
    case 'proof':
    case 'epic-event':
      return []
    case 'mandate':
    case 'operator-control':
    case 'action-receipt':
    case 'workflow-binding':
      return scopedRefsOf(draft)
        .filter((ref) => equalScope(ref.scope, { repository: draft.repository, target: draft.target }))
        .map((ref) => ref.recordId)
  }
}

export function scopedRefsOf(record: { kind: Kind; payload: unknown }): ExternalRecordRef[] {
  switch (record.kind) {
    case 'mandate': {
      const payload = record.payload as MandatePayload
      return [payload.parent, payload.antecedent].filter((ref): ref is ExternalRecordRef => ref !== null)
    }
    case 'operator-control': {
      const payload = record.payload as OperatorControlPayload
      const refs: Array<ExternalRecordRef | null> = [payload.mandate, payload.predecessor]
      if (payload.control === 'accept-material') refs.push(payload.assessment)
      if (payload.control === 'select-successor') refs.push(payload.successor)
      return refs.filter((ref): ref is ExternalRecordRef => ref !== null)
    }
    case 'action-receipt': {
      const payload = record.payload as ActionReceiptPayload
      const refs = [payload.mandate]
      if (payload.phase === 'result') refs.push(payload.start)
      return refs
    }
    case 'workflow-binding':
      return [(record.payload as WorkflowBindingPayload).mandate]
    default:
      return []
  }
}

export function partitionScopedRefs(record: Pick<CanonicalRecord, 'kind' | 'payload' | 'repository' | 'target'>): {
  sameScope: ExternalRecordRef[]
  external: ExternalRecordRef[]
} {
  const scope = { repository: record.repository, target: record.target }
  const refs = scopedRefsOf(record)
  return {
    sameScope: refs.filter((ref) => equalScope(ref.scope, scope)),
    external: refs.filter((ref) => !equalScope(ref.scope, scope)),
  }
}

function workflowInputMeaning(record: CanonicalRecord): Diagnostic | null {
  if (!isWorkflowKind(record.kind)) return null
  const { sameScope, external } = partitionScopedRefs(record)
  for (const ref of sameScope) {
    if (!record.inputs.includes(ref.recordId))
      return diagnostic('unbound', `Same-scope reference ${ref.recordId} is missing from inputs`)
  }
  for (const ref of external) {
    if (record.inputs.includes(ref.recordId) || sameScope.some((item) => item.recordId === ref.recordId))
      return diagnostic('ambiguous', `External reference ${ref.recordId} must not be an input`)
  }
  return null
}

export function buildRecord<K extends CanonicalRecord['kind']>(
  draft: Extract<RecordDraft, { kind: K }>,
  contextInputs?: readonly string[],
): Result<Extract<CanonicalRecord, { kind: K }>>
export function buildRecord(draft: RecordDraft, contextInputs: readonly string[] = []): Result<CanonicalRecord> {
  return parseRecord({ ...draft, inputs: [...new Set([...derivedInputs(draft), ...contextInputs])] })
}

export const PRODUCER_OUTPUTS = [
  'spec',
  'findings',
  'decision',
  'action-result',
  'spec-assessment',
  'plan',
  'plan-review',
  'implementation',
  'ci-attribution',
] as const
export type ProducerOutput = (typeof PRODUCER_OUTPUTS)[number]

const producerSchemas = {
  spec: specReportSchema,
  findings: findingReportSchema,
  decision: decisionSchema,
  'action-result': actionResultSchema,
  'spec-assessment': specAssessmentSchema,
  plan: planOutputSchema,
  'plan-review': planReviewSchema,
  implementation: implementationOutputSchema,
  'ci-attribution': ciAttributionSchema,
} as const satisfies Record<ProducerOutput, z.ZodType>

export function producerJsonSchema(output: string): Json {
  if (!Object.hasOwn(producerSchemas, output)) {
    throw new Error(`producerJsonSchema has no output ${output}`)
  }
  const schema = producerSchemas[output as ProducerOutput]
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' })))
}

export function inspectFinding(data: Json, taxonomy: readonly string[]): FindingInspection {
  const parsed = findingSchema.safeParse(data)
  if (!parsed.success) {
    const label =
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      typeof data.label === 'string' &&
      labelIsKnown(data.label)
        ? data.label
        : null
    return {
      usable: false,
      knownLabel: label,
      diagnostics: [diagnostic('unusable-finding', 'Original finding is not a strict canonical finding')],
    }
  }
  const diagnostics: Diagnostic[] = []
  const candidateClasses = (parsed.data.classes ?? []).filter((findingClass) => findingClass.startsWith('candidate/'))
  if (candidateClasses.length > 1)
    diagnostics.push(diagnostic('unusable-finding', 'Finding has more than one advisory candidate class'))
  for (const findingClass of candidateClasses)
    if (!/^candidate\/[a-z][a-z0-9-]{1,48}$/.test(findingClass))
      diagnostics.push(diagnostic('unknown-reference', `Candidate class ${findingClass} is malformed`))
  for (const findingClass of parsed.data.classes ?? []) {
    if (!findingClass.startsWith('candidate/') && !taxonomy.includes(findingClass))
      diagnostics.push(
        diagnostic('unknown-reference', `Finding class ${findingClass} is not in the canonical taxonomy`),
      )
  }
  if ((parsed.data.classes?.length ?? 0) > 0 && (parsed.data.rawCallsites?.length ?? 0) === 0)
    diagnostics.push(diagnostic('unusable-finding', 'Classified finding is missing raw callsites'))
  return { usable: diagnostics.length === 0, knownLabel: parsed.data.label, diagnostics }
}

function labelIsKnown(value: string): value is Label {
  return [
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
  ].includes(value)
}

function inventoryRoot(
  records: Map<string, CanonicalRecord>,
  inventory: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
): Extract<CanonicalRecord, { kind: 'review-attempt' }> | null {
  const root = records.get(inventory.payload.rootAttemptId)
  return root?.kind === 'review-attempt' ? root : null
}
function isJsonObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function sameJson(left: Json, right: Json): boolean {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      const entry = left[index]
      const candidate = right[index]
      if (entry === undefined || candidate === undefined || !sameJson(entry, candidate)) return false
    }
    return true
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false
    const entry = left[key]
    const candidate = right[key]
    if (entry === undefined || candidate === undefined || !sameJson(entry, candidate)) return false
  }
  return true
}

function capturedFindingMembers(value: Json): Json[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.findings)) return null
  return value.findings
}

function requiredSlotsComplete(
  records: Map<string, CanonicalRecord>,
  inventory: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
  diagnostics: Diagnostic[],
  enforceClosure: boolean,
): void {
  const slots = new Map(inventory.payload.slots.map((slot) => [slot.slotId, slot]))
  if (slots.size !== inventory.payload.slots.length)
    diagnostics.push(diagnostic('duplicate-reference', `Inventory ${inventory.recordId} repeats a slot ID`))
  const matched = new Map<string, Extract<CanonicalRecord, { kind: 'contribution' }>[]>()
  for (const record of records.values()) {
    if (record.kind !== 'contribution' || record.payload.inventoryId !== inventory.recordId) continue
    const slotId = record.payload.host.slotId
    if (slotId === null || !slots.has(slotId)) {
      if (enforceClosure)
        diagnostics.push(
          diagnostic('unknown-reference', `Contribution ${record.recordId} names no inventory slot`, record.recordId),
        )
      continue
    }
    const slot = slots.get(slotId)
    if (slot === undefined) continue
    if (
      enforceClosure &&
      (record.payload.host.phase !== slot.phase ||
        record.payload.host.role !== slot.role ||
        record.payload.host.chunk !== slot.chunk)
    )
      diagnostics.push(
        diagnostic('unbound', `Contribution ${record.recordId} host provenance does not match slot ${slotId}`),
      )
    const entries = matched.get(slotId) ?? []
    entries.push(record)
    matched.set(slotId, entries)
  }
  for (const slot of inventory.payload.slots) {
    const entries = matched.get(slot.slotId) ?? []
    if (enforceClosure && entries.length > 1)
      diagnostics.push(diagnostic('duplicate-reference', `Slot ${slot.slotId} has multiple contributions`))
    if (enforceClosure && slot.required && entries.length !== 1)
      diagnostics.push(diagnostic('missing-contribution', `Required slot ${slot.slotId} is not closed`))
    for (const entry of entries) {
      const expectedContent =
        slot.output === 'decision' ? 'decision' : slot.output === 'action-result' ? 'action-result' : 'findings'
      if (enforceClosure && entry.payload.content !== expectedContent)
        diagnostics.push(
          diagnostic('unbound', `Contribution ${entry.recordId} content does not satisfy slot ${slot.slotId}`),
        )
      if (
        enforceClosure &&
        slot.required &&
        (entry.payload.host.origin !== 'native' || entry.payload.host.childId === null)
      )
        diagnostics.push(diagnostic('unbound', `Required slot ${slot.slotId} lacks observed native child provenance`))
      if (
        enforceClosure &&
        slot.required &&
        entry.payload.host.origin === 'native' &&
        entry.payload.rawAttempts.length === 0
      )
        diagnostics.push(
          diagnostic('incomplete', `Required native contribution ${entry.recordId} retained no raw submissions`),
        )
      if (
        enforceClosure &&
        slot.required &&
        entry.payload.host.origin === 'native' &&
        (entry.payload.native === null ||
          entry.payload.native.strict !== 'valid' ||
          entry.payload.native.completion !== 'completed')
      )
        diagnostics.push(
          diagnostic('incomplete', `Required native contribution ${entry.recordId} has no valid completed outcome`),
        )
      if (enforceClosure && slot.required && entry.payload.structured === null)
        diagnostics.push(diagnostic('malformed', `Required slot ${slot.slotId} has no structured output`))
      if (
        enforceClosure &&
        entry.payload.structured !== null &&
        slot.output === 'findings' &&
        !findingReportSchema.safeParse(entry.payload.structured).success
      )
        diagnostics.push(
          diagnostic('malformed', `Contribution ${entry.recordId} structured output is not a finding report`),
        )
      if (
        enforceClosure &&
        entry.payload.structured !== null &&
        slot.output === 'spec' &&
        !specReportSchema.safeParse(entry.payload.structured).success
      )
        diagnostics.push(
          diagnostic('malformed', `Contribution ${entry.recordId} structured output is not a spec report`),
        )
      if (
        enforceClosure &&
        entry.payload.structured !== null &&
        slot.output === 'decision' &&
        !decisionSchema.safeParse(entry.payload.structured).success
      )
        diagnostics.push(diagnostic('malformed', `Contribution ${entry.recordId} structured output is not a decision`))
      if (
        enforceClosure &&
        entry.payload.structured !== null &&
        slot.output === 'action-result' &&
        !actionResultSchema.safeParse(entry.payload.structured).success
      )
        diagnostics.push(
          diagnostic('malformed', `Contribution ${entry.recordId} structured output is not an action result`),
        )
      if (enforceClosure && slot.required && entry.payload.content === 'findings' && entry.payload.findings === null)
        diagnostics.push(
          diagnostic('unusable-finding', `Required finding contribution ${entry.recordId} has no extractable findings`),
        )
    }
  }
}

export function validateRecordGraph(history: DecodedHistory, enforceAdmission = true): Result<CanonicalRecord[]> {
  const diagnostics: Diagnostic[] = [...history.diagnostics, ...history.source.diagnostics]
  if (!history.source.complete) diagnostics.push(diagnostic('incomplete', 'History pagination is incomplete'))
  const records = recordMap(history)
  const operationsById = new Map<string, CanonicalRecord>()
  const recordsById = new Map<string, CanonicalRecord>()
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || operation.record === null) {
      diagnostics.push(
        diagnostic(
          operation.status === 'legacy' ? 'legacy-format' : operation.status,
          `Operation ${operation.operationId ?? 'unknown'} is not a complete canonical record`,
        ),
      )
      continue
    }
    if (
      operation.operationId !== operation.record.operationId ||
      operation.recordId !== operation.record.recordId ||
      operation.kind !== operation.record.kind
    )
      diagnostics.push(
        diagnostic('unbound', `Observed operation metadata does not identify record ${operation.record.recordId}`),
      )
    const authorized =
      operation.record.kind === 'stop'
        ? (author: string | null) =>
            author === history.source.expectedAuthor ||
            (history.source.stopAuthor !== null && author === history.source.stopAuthor)
        : (author: string | null) => author === history.source.expectedAuthor
    if (operation.parts.some((part) => !authorized(part.author)))
      diagnostics.push(diagnostic('unbound', `Operation ${operation.operationId} has an unauthorized native author`))
    const priorOperation = operationsById.get(operation.record.operationId)
    const priorRecord = recordsById.get(operation.record.recordId)
    if (
      (priorOperation !== undefined && JSON.stringify(priorOperation) !== JSON.stringify(operation.record)) ||
      (priorRecord !== undefined && JSON.stringify(priorRecord) !== JSON.stringify(operation.record))
    )
      diagnostics.push(
        diagnostic(
          'duplicate-reference',
          `Operation ${operation.record.operationId} or record ${operation.record.recordId} appears more than once with different content`,
        ),
      )
    operationsById.set(operation.record.operationId, operation.record)
    recordsById.set(operation.record.recordId, operation.record)
  }
  for (const record of records.values()) {
    if (!equalScope(record, history.source.scope))
      diagnostics.push(diagnostic('unbound', `Record ${record.recordId} has another scope`))
    if (!unique(record.inputs))
      diagnostics.push(diagnostic('duplicate-reference', `Record ${record.recordId} repeats an input`))
    for (const input of record.inputs)
      if (!records.has(input))
        diagnostics.push(diagnostic('unknown-reference', `Record ${record.recordId} references missing input ${input}`))
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      diagnostics.push(diagnostic('cycle', `Record graph contains a cycle at ${id}`))
      return
    }
    visiting.add(id)
    const current = records.get(id)
    if (current !== undefined) for (const input of current.inputs) if (records.has(input)) visit(input)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of records.keys()) visit(id)
  for (const record of records.values()) {
    if (record.kind !== 'review-attempt') continue
    const inventory = record.payload
    if (!unique(inventory.slots.map((slot) => slot.slotId)))
      diagnostics.push(diagnostic('duplicate-reference', `Inventory ${record.recordId} repeats slot IDs`))
    if (inventory.stage === 'initial') {
      if (inventory.rootAttemptId !== record.recordId)
        diagnostics.push(diagnostic('unbound', `Initial inventory ${record.recordId} does not root itself`))
      if (
        inventory.purpose === 'review' &&
        inventory.subject.kind === 'epic-range' &&
        inventory.subject.range.slice(-40) !== inventory.candidateGitSHA
      )
        diagnostics.push(
          diagnostic('unbound', `Epic range subject for ${record.recordId} does not end at the candidate SHA`),
        )
    } else {
      const root = inventoryRoot(records, record)
      if (root === null || root.payload.stage !== 'initial')
        diagnostics.push(diagnostic('unknown-reference', `Inventory ${record.recordId} has no initial root`))
      else if (
        !record.inputs.includes(root.recordId) ||
        root.payload.candidateGitSHA !== inventory.candidateGitSHA ||
        root.payload.input !== inventory.input ||
        root.payload.purpose !== inventory.purpose ||
        JSON.stringify(root.payload.policy) !== JSON.stringify(inventory.policy)
      )
        diagnostics.push(
          diagnostic('unbound', `Inventory ${record.recordId} diverges from root ${inventory.rootAttemptId}`),
        )
    }
    requiredSlotsComplete(records, record, diagnostics, false)
  }
  for (const record of records.values()) {
    if (record.kind !== 'contribution') continue
    const contribution = record.payload
    if (contribution.content === 'decision' && contribution.findings !== null)
      diagnostics.push(diagnostic('malformed', `Decision contribution ${record.recordId} must not carry findings`))
    if (contribution.content === 'operator-request' && contribution.findings !== null)
      diagnostics.push(diagnostic('malformed', `Operator request ${record.recordId} must not carry findings`))
    if (contribution.findings !== null) {
      if (!unique(contribution.findings.map((finding) => finding.id)))
        diagnostics.push(
          diagnostic('duplicate-reference', `Contribution ${record.recordId} repeats original finding IDs`),
        )
      for (const [index, finding] of contribution.findings.entries())
        if (finding.id !== `${record.recordId}:f${index}`)
          diagnostics.push(
            diagnostic('unbound', `Original finding ${finding.id} does not retain its source allocation`),
          )
    }
    const submissions = new Map<number, (typeof contribution.rawAttempts)[number]>()
    let duplicateSubmission = false
    let structuredCaptured = false
    for (const attempt of contribution.rawAttempts) {
      if (submissions.has(attempt.attemptIndex)) duplicateSubmission = true
      submissions.set(attempt.attemptIndex, attempt)
      if (attempt.data !== null && contribution.structured !== null && sameJson(attempt.data, contribution.structured))
        structuredCaptured = true
    }
    if (duplicateSubmission)
      diagnostics.push(
        diagnostic('duplicate-reference', `Contribution ${record.recordId} repeats a captured submission index`),
      )
    if (contribution.structured !== null && !structuredCaptured)
      diagnostics.push(
        diagnostic('unbound', `Contribution ${record.recordId} structured output is not a captured model submission`),
      )
    if (contribution.content === 'findings' && contribution.findings !== null) {
      for (const original of contribution.findings) {
        const attempt = submissions.get(original.attemptIndex)
        const capturedFindings =
          attempt === undefined || attempt.data === null ? null : capturedFindingMembers(attempt.data)
        if (capturedFindings === null || !capturedFindings.some((finding) => sameJson(finding, original.data)))
          diagnostics.push(
            diagnostic('unbound', `Original finding ${original.id} is not retained in its captured submission`),
          )
      }
      for (const attempt of submissions.values()) {
        const capturedFindings = attempt.data === null ? null : capturedFindingMembers(attempt.data)
        if (
          capturedFindings?.some(
            (finding) =>
              !contribution.findings?.some(
                (original) => original.attemptIndex === attempt.attemptIndex && sameJson(original.data, finding),
              ),
          )
        )
          diagnostics.push(
            diagnostic(
              'unusable-finding',
              `Finding contribution ${record.recordId} loses a captured submission finding`,
            ),
          )
      }
    }
    if (contribution.inventoryId !== null) {
      const inventory = records.get(contribution.inventoryId)
      if (inventory?.kind !== 'review-attempt')
        diagnostics.push(
          diagnostic('unknown-reference', `Contribution ${record.recordId} references unknown inventory`),
        )
      else if (!record.inputs.includes(inventory.recordId))
        diagnostics.push(diagnostic('unbound', `Contribution ${record.recordId} is not bound to its inventory input`))
    }
  }
  for (const record of records.values()) {
    if (record.kind !== 'decision') continue
    const source = records.get(record.payload.originalContributionId)
    if (source?.kind !== 'contribution' || source.payload.content !== 'decision')
      diagnostics.push(
        diagnostic('missing-contribution', `Decision ${record.recordId} lacks its synthesis contribution`),
      )
    if (!record.inputs.includes(record.payload.originalContributionId))
      diagnostics.push(diagnostic('unbound', `Decision ${record.recordId} does not bind its synthesis contribution`))
    if (source?.kind === 'contribution' && source.payload.structured !== null) {
      const structuredDecision = decisionSchema.safeParse(source.payload.structured)
      if (!structuredDecision.success || !sameJson(structuredDecision.data, record.payload.judgment))
        diagnostics.push(
          diagnostic('unbound', `Decision ${record.recordId} differs from its retained structured synthesis`),
        )
      const finalSubmission = source.payload.rawAttempts.reduce<(typeof source.payload.rawAttempts)[number] | null>(
        (latest, attempt) => (latest === null || attempt.attemptIndex > latest.attemptIndex ? attempt : latest),
        null,
      )
      if (
        finalSubmission?.data === null ||
        finalSubmission === null ||
        !sameJson(finalSubmission.data, record.payload.judgment)
      )
        diagnostics.push(
          diagnostic('unbound', `Decision ${record.recordId} is not its final captured model submission`),
        )
    }
    if (source?.kind === 'contribution' && source.payload.content === 'decision' && source.payload.inventoryId === null)
      diagnostics.push(
        diagnostic('unbound', `Decision ${record.recordId} synthesis contribution is not bound to an inventory`),
      )
    for (const sourceId of record.payload.judgment.sourceContributionIds) {
      const contribution = records.get(sourceId)
      if (contribution?.kind !== 'contribution' || contribution.payload.content !== 'findings')
        diagnostics.push(
          diagnostic(
            'missing-contribution',
            `Decision ${record.recordId} references non-finding contribution ${sourceId}`,
          ),
        )
    }
    if (
      source?.kind === 'contribution' &&
      source.payload.content === 'decision' &&
      source.payload.inventoryId !== null
    ) {
      const synthesis = records.get(source.payload.inventoryId)
      if (
        synthesis?.kind !== 'review-attempt' ||
        synthesis.payload.stage !== 'synthesis' ||
        synthesis.payload.purpose !== record.payload.judgment.purpose
      ) {
        diagnostics.push(
          diagnostic(
            'unbound',
            `Decision ${record.recordId} synthesis contribution is not bound to a matching synthesis inventory`,
          ),
        )
      } else {
        const root = inventoryRoot(records, synthesis)
        if (
          root === null ||
          root.payload.purpose !== record.payload.judgment.purpose ||
          JSON.stringify(root.payload.policy) !== JSON.stringify(record.payload.judgment.policy)
        ) {
          diagnostics.push(
            diagnostic('unbound', `Decision ${record.recordId} policy or purpose diverges from its root inventory`),
          )
        } else {
          if (
            record.payload.judgment.purpose === 'review' &&
            root.payload.stage === 'initial' &&
            root.payload.purpose === 'review' &&
            root.payload.subject.kind === 'pull-request' &&
            record.payload.judgment.standards === null
          )
            diagnostics.push(
              diagnostic('incomplete', `Pull-request review decision ${record.recordId} lacks its standards display`),
            )
          for (const inventory of records.values()) {
            if (inventory.kind === 'review-attempt' && inventory.payload.rootAttemptId === root.recordId)
              requiredSlotsComplete(records, inventory, diagnostics, enforceAdmission)
          }
          const expectedSources = [...records.values()]
            .filter((candidate): candidate is Extract<CanonicalRecord, { kind: 'contribution' }> => {
              if (
                candidate.kind !== 'contribution' ||
                candidate.payload.content !== 'findings' ||
                candidate.payload.inventoryId === null
              )
                return false
              const inventory = records.get(candidate.payload.inventoryId)
              return inventory?.kind === 'review-attempt' && inventory.payload.rootAttemptId === root.recordId
            })
            .map((candidate) => candidate.recordId)
          for (const sourceId of expectedSources)
            if (!record.payload.judgment.sourceContributionIds.includes(sourceId))
              diagnostics.push(
                diagnostic('missing-contribution', `Decision ${record.recordId} omits source contribution ${sourceId}`),
              )
          for (const sourceId of record.payload.judgment.sourceContributionIds) {
            const contribution = records.get(sourceId)
            if (contribution?.kind !== 'contribution' || contribution.payload.inventoryId === null) continue
            const inventory = records.get(contribution.payload.inventoryId)
            if (inventory?.kind !== 'review-attempt' || inventory.payload.rootAttemptId !== root.recordId)
              diagnostics.push(
                diagnostic('unbound', `Decision ${record.recordId} source ${sourceId} is outside its root inventory`),
              )
          }
        }
      }
    }
  }
  for (const record of records.values()) {
    if (record.kind !== 'review') continue
    const decision = records.get(record.payload.decisionId)
    if (decision?.kind !== 'decision' || decision.payload.judgment.purpose !== 'review')
      diagnostics.push(diagnostic('unknown-reference', `Review ${record.recordId} has no review decision`))
    if (!record.inputs.includes(record.payload.decisionId))
      diagnostics.push(diagnostic('unbound', `Review ${record.recordId} does not bind its decision`))
    const inventories = record.payload.inventoryIds.map((id) => records.get(id))
    if (!unique(record.payload.inventoryIds) || inventories.some((inventory) => inventory?.kind !== 'review-attempt'))
      diagnostics.push(diagnostic('unknown-reference', `Review ${record.recordId} has unknown inventory IDs`))
    else {
      const typed = inventories.filter(
        (inventory): inventory is Extract<CanonicalRecord, { kind: 'review-attempt' }> =>
          inventory?.kind === 'review-attempt',
      )
      const rootIds = new Set(typed.map((inventory) => inventory.payload.rootAttemptId))
      if (
        rootIds.size !== 1 ||
        typed.some(
          (inventory) =>
            inventory.payload.purpose !== 'review' ||
            inventory.payload.candidateGitSHA !== record.payload.candidateGitSHA ||
            inventory.payload.input !== record.payload.input ||
            !record.inputs.includes(inventory.recordId),
        )
      )
        diagnostics.push(diagnostic('unbound', `Review ${record.recordId} inventories do not bind one candidate`))
      const rootId = typed[0]?.payload.rootAttemptId
      if (rootId !== undefined) {
        const allForRoot = [...records.values()]
          .filter(
            (candidate): candidate is Extract<CanonicalRecord, { kind: 'review-attempt' }> =>
              candidate.kind === 'review-attempt' && candidate.payload.rootAttemptId === rootId,
          )
          .map((candidate) => candidate.recordId)
        if (
          !unique(allForRoot) ||
          allForRoot.length !== record.payload.inventoryIds.length ||
          !allForRoot.every((id) => record.payload.inventoryIds.includes(id))
        )
          diagnostics.push(
            diagnostic('incomplete', `Review ${record.recordId} does not list every inventory for its root`),
          )
        const root = records.get(rootId)
        if (
          root?.kind !== 'review-attempt' ||
          root.payload.stage !== 'initial' ||
          root.payload.purpose !== 'review' ||
          root.payload.subject.kind !== 'pull-request'
        )
          diagnostics.push(diagnostic('unbound', `Review ${record.recordId} is not bound to a pull-request subject`))
        if (decision?.kind === 'decision') {
          const synthesisContribution = records.get(decision.payload.originalContributionId)
          const synthesisInventory =
            synthesisContribution?.kind === 'contribution' && synthesisContribution.payload.inventoryId !== null
              ? records.get(synthesisContribution.payload.inventoryId)
              : null
          const decisionRoot =
            synthesisInventory?.kind === 'review-attempt' ? inventoryRoot(records, synthesisInventory) : null
          if (decisionRoot?.recordId !== rootId)
            diagnostics.push(
              diagnostic('unbound', `Review ${record.recordId} decision belongs to another inventory root`),
            )
        }
      }
      for (const inventory of typed) requiredSlotsComplete(records, inventory, diagnostics, enforceAdmission)
    }
  }
  const slotsByRoot = new Map<string, Set<string>>()
  for (const inventory of records.values()) {
    if (inventory.kind !== 'review-attempt') continue
    const slotIds = slotsByRoot.get(inventory.payload.rootAttemptId) ?? new Set<string>()
    for (const slot of inventory.payload.slots) {
      if (slotIds.has(slot.slotId))
        diagnostics.push(
          diagnostic('duplicate-reference', `Root ${inventory.payload.rootAttemptId} repeats slot ${slot.slotId}`),
        )
      slotIds.add(slot.slotId)
    }
    slotsByRoot.set(inventory.payload.rootAttemptId, slotIds)
  }
  for (const record of records.values()) {
    if (record.kind !== 'stop') continue
    const review = records.get(record.payload.reviewId)
    if (review?.kind !== 'review')
      diagnostics.push(diagnostic('unknown-reference', `Stop ${record.recordId} references no final review`))
    if (!record.inputs.includes(record.payload.reviewId))
      diagnostics.push(diagnostic('unbound', `Stop ${record.recordId} does not bind its final review`))
  }
  for (const record of records.values()) {
    if (record.kind === 'fix-request') {
      const request = records.get(record.payload.requestContributionId)
      if (request?.kind !== 'contribution')
        diagnostics.push(
          diagnostic('unknown-reference', `Fix request ${record.recordId} lacks its request contribution`),
        )
      if (!record.inputs.includes(record.payload.requestContributionId))
        diagnostics.push(diagnostic('unbound', `Fix request ${record.recordId} does not bind its request contribution`))
      if (record.payload.existingReviewId !== null) {
        const review = records.get(record.payload.existingReviewId)
        if (review?.kind !== 'review' || !record.inputs.includes(record.payload.existingReviewId))
          diagnostics.push(diagnostic('unknown-reference', `Fix request ${record.recordId} lacks its existing review`))
      }
    }
    if (record.kind === 'correction-result') {
      const decision = records.get(record.payload.decisionId)
      if (
        decision?.kind !== 'decision' ||
        !decision.payload.judgment.causes.some((cause) => cause.id === record.payload.causeId)
      )
        diagnostics.push(diagnostic('unknown-reference', `Correction ${record.recordId} lacks its decision cause`))
      if (!record.inputs.includes(record.payload.decisionId))
        diagnostics.push(diagnostic('unbound', `Correction ${record.recordId} does not bind its decision`))
    }
    if (record.kind === 'falsification-result') {
      const correction = records.get(record.payload.correctionResultId)
      if (correction?.kind !== 'correction-result')
        diagnostics.push(
          diagnostic('unknown-reference', `Falsification ${record.recordId} lacks its correction result`),
        )
      if (!record.inputs.includes(record.payload.correctionResultId))
        diagnostics.push(diagnostic('unbound', `Falsification ${record.recordId} does not bind its correction result`))
    }
    if (record.kind === 'debt-receipt') {
      const decision = records.get(record.payload.decisionId)
      if (decision?.kind !== 'decision')
        diagnostics.push(diagnostic('unknown-reference', `Debt receipt ${record.recordId} lacks its decision`))
      else {
        const findings = new Set(decision.payload.judgment.findings.map((finding) => finding.id))
        const causes = new Set(decision.payload.judgment.causes.map((cause) => cause.id))
        if (
          record.payload.findingIds.some((id) => !findings.has(id)) ||
          record.payload.causeIds.some((id) => !causes.has(id))
        )
          diagnostics.push(
            diagnostic('unknown-reference', `Debt receipt ${record.recordId} references another decision`),
          )
      }
      if (!record.inputs.includes(record.payload.decisionId))
        diagnostics.push(diagnostic('unbound', `Debt receipt ${record.recordId} does not bind its decision`))
    }
    if (record.kind === 'fix-result') {
      const request = records.get(record.payload.requestId)
      const decision = records.get(record.payload.decisionId)
      if (request?.kind !== 'fix-request' || decision?.kind !== 'decision')
        diagnostics.push(diagnostic('unknown-reference', `Fix result ${record.recordId} lacks request or decision`))
      if (!record.inputs.includes(record.payload.requestId) || !record.inputs.includes(record.payload.decisionId))
        diagnostics.push(diagnostic('unbound', `Fix result ${record.recordId} does not bind request and decision`))
      for (const correctionId of record.payload.correctionResultIds)
        if (records.get(correctionId)?.kind !== 'correction-result' || !record.inputs.includes(correctionId))
          diagnostics.push(
            diagnostic('unknown-reference', `Fix result ${record.recordId} lacks correction ${correctionId}`),
          )
      for (const falsificationId of record.payload.falsificationResultIds)
        if (records.get(falsificationId)?.kind !== 'falsification-result' || !record.inputs.includes(falsificationId))
          diagnostics.push(
            diagnostic('unknown-reference', `Fix result ${record.recordId} lacks falsification ${falsificationId}`),
          )
      for (const receiptId of record.payload.debtReceiptIds)
        if (records.get(receiptId)?.kind !== 'debt-receipt' || !record.inputs.includes(receiptId))
          diagnostics.push(
            diagnostic('unknown-reference', `Fix result ${record.recordId} lacks debt receipt ${receiptId}`),
          )
    }
  }
  return diagnostics.length === 0 ? { ok: true, value: [...records.values()] } : fail(diagnostics)
}

export function deriveRecallPlan(
  history: DecodedHistory,
  rootAttemptId: string,
  canonicalClasses: readonly string[],
): Result<RecallPlan> {
  const graph = validateRecordGraph(history)
  if (!graph.ok) return fail(graph.diagnostics)
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  const root = records.get(rootAttemptId)
  if (root?.kind !== 'review-attempt' || root.payload.stage !== 'initial' || root.payload.purpose !== 'review')
    return fail([diagnostic('unknown-reference', `Recall root ${rootAttemptId} is not an initial review inventory`)])
  const closureDiagnostics: Diagnostic[] = []
  requiredSlotsComplete(records, root, closureDiagnostics, true)
  if (closureDiagnostics.length > 0) return fail(closureDiagnostics)
  const originalEntries: { id: string; data: Json; contribution: Contribution }[] = []
  for (const record of records.values()) {
    if (
      record.kind !== 'contribution' ||
      record.payload.content !== 'findings' ||
      record.payload.host.phase !== 'panel' ||
      record.payload.inventoryId === null ||
      record.payload.findings === null
    )
      continue
    const inventory = records.get(record.payload.inventoryId)
    if (inventory?.kind !== 'review-attempt' || inventory.payload.rootAttemptId !== rootAttemptId) continue
    for (const original of record.payload.findings)
      originalEntries.push({ id: original.id, data: original.data, contribution: record.payload })
  }
  const classes = new Map<
    string,
    { chunks: Set<number>; callsites: Map<string, { file: string; line: number }>; sourceFindingIds: Set<string> }
  >()
  for (const entry of originalEntries) {
    const inspected = inspectFinding(entry.data, canonicalClasses)
    if (!inspected.usable) continue
    const finding = findingSchema.parse(entry.data)
    for (const classId of finding.classes ?? []) {
      if (!canonicalClasses.includes(classId) || classId.startsWith('candidate/')) continue
      const indexed = classes.get(classId) ?? {
        chunks: new Set<number>(),
        callsites: new Map(),
        sourceFindingIds: new Set<string>(),
      }
      if (entry.contribution.host.chunk !== null) indexed.chunks.add(entry.contribution.host.chunk)
      for (const callsite of finding.rawCallsites ?? [])
        indexed.callsites.set(`${callsite.file}:${callsite.line}`, callsite)
      indexed.sourceFindingIds.add(entry.id)
      classes.set(classId, indexed)
    }
  }
  const index: RecallClass[] = [...classes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([classId, value]) => ({
      classId,
      chunks: [...value.chunks].sort((left, right) => left - right),
      callsites: [...value.callsites.values()].sort(
        (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
      ),
      sourceFindingIds: [...value.sourceFindingIds].sort(),
    }))
  return {
    ok: true,
    value: {
      index,
      triggeredClassIds: index
        .filter((entry) => entry.chunks.length >= 2 && entry.callsites.length >= 3)
        .map((entry) => entry.classId),
      diagnostics: [],
    },
  }
}

function groupFor(label: Label): Group {
  if (label === 'issue' || label === 'issue(blocking)' || label === 'todo' || label === 'suggestion(blocking)')
    return 'Blockers'
  if (label === 'suggestion' || label === 'suggestion(non-blocking)' || label === 'nitpick') return 'Warnings'
  if (label === 'thought' || label === 'question') return 'Suggestions'
  return 'Praise'
}

export type DecisionBindings = {
  admissible: boolean
  diagnostics: Diagnostic[]
  records: ReadonlyMap<string, CanonicalRecord>
  originals: ReadonlyMap<string, Json>
}

function validateDecisionBindingsFromGraph(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  graph: Result<CanonicalRecord[]>,
): DecisionBindings {
  const diagnostics: Diagnostic[] = graph.ok ? [] : [...graph.diagnostics]
  const records = graph.ok ? new Map(graph.value.map((entry) => [entry.recordId, entry])) : recordMap(history)
  const observed = records.get(record.recordId)
  if (observed?.kind !== 'decision' || JSON.stringify(observed) !== JSON.stringify(record))
    diagnostics.push(diagnostic('unbound', `Decision ${record.recordId} is not the observed immutable decision record`))
  const decision = record.payload.judgment
  if (!unique(decision.sourceContributionIds))
    diagnostics.push(diagnostic('duplicate-reference', `Decision ${record.recordId} repeats a source contribution`))
  const originals = new Map<string, Json>()
  for (const sourceId of decision.sourceContributionIds) {
    const source = records.get(sourceId)
    if (source?.kind !== 'contribution' || source.payload.content !== 'findings' || source.payload.findings === null) {
      diagnostics.push(diagnostic('missing-contribution', `Decision source ${sourceId} is unavailable`))
      continue
    }
    for (const original of source.payload.findings) {
      if (originals.has(original.id))
        diagnostics.push(
          diagnostic('duplicate-reference', `Original finding ${original.id} occurs in multiple sources`),
        )
      originals.set(original.id, original.data)
    }
  }
  const covered = new Set<string>()
  if (!unique(decision.findings.map((finding) => finding.id)))
    diagnostics.push(diagnostic('duplicate-reference', 'Decision repeats final finding IDs'))
  for (const finalFinding of decision.findings) {
    if (!unique(finalFinding.sourceFindingIds))
      diagnostics.push(diagnostic('duplicate-reference', `Final finding ${finalFinding.id} repeats a source`))
    if (
      finalFinding.state === 'usable' &&
      finalFinding.sourceFindingIds.length > 1 &&
      finalFinding.mergeReason === undefined
    )
      diagnostics.push(diagnostic('malformed', `Merged finding ${finalFinding.id} lacks merge reason`))
    for (const sourceId of finalFinding.sourceFindingIds) {
      if (!originals.has(sourceId)) {
        diagnostics.push(diagnostic('unknown-reference', `Final finding ${finalFinding.id} references ${sourceId}`))
        continue
      }
      if (covered.has(sourceId))
        diagnostics.push(diagnostic('duplicate-reference', `Original finding ${sourceId} is covered more than once`))
      covered.add(sourceId)
    }
  }
  for (const sourceId of originals.keys())
    if (!covered.has(sourceId))
      diagnostics.push(
        diagnostic('missing-contribution', `Original finding ${sourceId} is not represented in decision`),
      )
  const caused = new Set<string>()
  if (!unique(decision.causes.map((cause) => cause.id)))
    diagnostics.push(diagnostic('duplicate-reference', 'Decision repeats cause IDs'))
  const finalIds = new Set(decision.findings.map((finding) => finding.id))
  for (const cause of decision.causes) {
    if (!causeSchema.safeParse(cause).success)
      diagnostics.push(diagnostic('malformed', `Cause ${cause.id} is incomplete`))
    if (!unique(cause.findingIds))
      diagnostics.push(diagnostic('duplicate-reference', `Cause ${cause.id} repeats a finding`))
    for (const findingId of cause.findingIds) {
      if (!finalIds.has(findingId))
        diagnostics.push(diagnostic('unknown-reference', `Cause ${cause.id} references unknown finding ${findingId}`))
      if (caused.has(findingId))
        diagnostics.push(diagnostic('duplicate-reference', `Finding ${findingId} belongs to more than one cause`))
      caused.add(findingId)
    }
  }
  return { admissible: diagnostics.length === 0, diagnostics, records, originals }
}

export function validateDecisionBindings(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
): DecisionBindings {
  return validateDecisionBindingsFromGraph(record, history, validateRecordGraph(history, false))
}

export function validateRetainedUnusableLabels(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  bindings: DecisionBindings,
): Result<null> {
  const diagnostics: Diagnostic[] = []
  for (const finalFinding of record.payload.judgment.findings) {
    if (finalFinding.state !== 'unusable') continue
    for (const sourceId of finalFinding.sourceFindingIds) {
      const original = bindings.originals.get(sourceId)
      if (original === undefined) continue
      const knownLabel = inspectFinding(original, []).knownLabel
      if (knownLabel === null || knownLabel !== finalFinding.label)
        diagnostics.push(
          diagnostic('malformed', `Unusable finding ${finalFinding.id} does not retain a known source label`),
        )
    }
  }
  return diagnostics.length === 0 ? { ok: true, value: null } : fail(diagnostics)
}

export type ReviewDecisionBindings = {
  review: Extract<CanonicalRecord, { kind: 'review' }>
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  bindings: DecisionBindings
}

export function validateReviewDecisionBindings(
  review: Extract<CanonicalRecord, { kind: 'review' }>,
  history: DecodedHistory,
): Result<ReviewDecisionBindings> {
  const authorityHistory = classifyHistory(history).authorityHistory
  const admissionGraph = validateRecordGraph(authorityHistory)
  if (!admissionGraph.ok) return fail(admissionGraph.diagnostics)
  const candidateDecision = recordMap(authorityHistory).get(review.payload.decisionId)
  if (candidateDecision?.kind !== 'decision')
    return fail([diagnostic('unknown-reference', `Review ${review.recordId} lacks its decision`)])
  const bindings = validateDecisionBindingsFromGraph(candidateDecision, authorityHistory, admissionGraph)
  if (!bindings.admissible) return fail(bindings.diagnostics)
  const identity = analyzeReviewIdentity(authorityHistory, bindings.records)
  if (identity.transportDiagnostics.length > 0) return fail(identity.transportDiagnostics)
  if (identity.incompleteFinal) return fail([diagnostic('incomplete', 'A final review operation is not complete')])
  if (identity.pendingRoot !== null)
    return fail([
      diagnostic(
        'incomplete',
        `Pull-request review inventory ${identity.pendingRoot.recordId} is pending completion by its own final review`,
        { rootId: identity.pendingRoot.recordId, pendingRoot: true },
      ),
    ])
  if (identity.latest === null || identity.latest.recordId !== review.recordId)
    return fail([diagnostic('unbound', `Review ${review.recordId} is not the latest canonical final review`)])
  const observedReview = bindings.records.get(review.recordId)
  if (observedReview?.kind !== 'review' || JSON.stringify(observedReview) !== JSON.stringify(review))
    return fail([diagnostic('unbound', `Review ${review.recordId} is not the observed immutable review record`)])
  const decision = bindings.records.get(review.payload.decisionId)
  if (decision?.kind !== 'decision')
    return fail([diagnostic('unknown-reference', `Review ${review.recordId} lacks its decision`)])
  const retainedLabels = validateRetainedUnusableLabels(decision, bindings)
  if (!retainedLabels.ok) return retainedLabels
  return { ok: true, value: { review: observedReview, decision, bindings } }
}

export function validateDecision(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
): DecisionAssessment {
  const admissionGraph = validateRecordGraph(history)
  const bindings = validateDecisionBindingsFromGraph(record, history, admissionGraph)
  const diagnostics = [...bindings.diagnostics]
  const groups: Record<Group, string[]> = { Blockers: [], Warnings: [], Suggestions: [], Praise: [] }
  const decision = record.payload.judgment
  const retainedLabels = validateRetainedUnusableLabels(record, bindings)
  if (!retainedLabels.ok) diagnostics.push(...retainedLabels.diagnostics)
  if (decision.policy.version === 'evidence-v1' && decision.policy.acceptanceRef !== acceptedPolicyRef)
    diagnostics.push(diagnostic('policy-not-accepted', 'Evidence policy is not independently accepted'))
  const findingInspections: { id: string; inspection: FindingInspection }[] = []
  for (const finalFinding of decision.findings) {
    if (finalFinding.state === 'usable' && finalFinding.label === null)
      diagnostics.push(diagnostic('malformed', `Usable finding ${finalFinding.id} has no model label`))
    for (const sourceId of finalFinding.sourceFindingIds) {
      const original = bindings.originals.get(sourceId)
      if (original === undefined) continue
      const inspection = inspectFinding(original, taxonomy)
      findingInspections.push({ id: sourceId, inspection })
      if (!inspection.usable) diagnostics.push(...inspection.diagnostics)
    }
    if (finalFinding.label !== null) groups[groupFor(finalFinding.label)].push(finalFinding.id)
  }
  const hasUnusable =
    decision.findings.some((finding) => finding.state === 'unusable') ||
    findingInspections.some(({ inspection }) => !inspection.usable)
  const verdict: Verdict | null =
    hasUnusable || diagnostics.length > 0
      ? null
      : groups.Blockers.length > 0
        ? 'Request changes'
        : groups.Warnings.length > 0
          ? 'Approve with comments'
          : decision.findings.length > 0
            ? 'Approve'
            : 'Approve (clean)'
  return { admissible: verdict !== null, groups, verdict, findings: findingInspections, diagnostics }
}

function reviewOperations(history: DecodedHistory) {
  const operations: typeof history.operations = []
  const identities = new Set<string>()
  for (const operation of history.operations) {
    if (operation.kind !== 'review' && operation.record?.kind !== 'review') continue
    const identity =
      operation.operationId ?? operation.recordId ?? operation.parts.map((part) => part.locator).join('|')
    if (!identities.has(identity)) {
      identities.add(identity)
      operations.push(operation)
    }
  }
  return operations
}
function latestUnfinishedPullRequestRoot(
  records: ReadonlyMap<string, CanonicalRecord>,
): Extract<CanonicalRecord, { kind: 'review-attempt' }> | null {
  let latest: Extract<CanonicalRecord, { kind: 'review-attempt' }> | null = null
  for (const record of records.values()) {
    if (
      record.kind === 'review-attempt' &&
      record.payload.stage === 'initial' &&
      record.payload.purpose === 'review' &&
      record.payload.subject.kind === 'pull-request'
    ) {
      latest = record
      continue
    }
    if (record.kind === 'review' && latest !== null && record.payload.inventoryIds.includes(latest.recordId))
      latest = null
  }
  return latest
}
type ReviewIdentity = {
  reviews: DecodedHistory['operations']
  knownReviews: number
  latest: Extract<CanonicalRecord, { kind: 'review' }> | null
  latestOperation: DecodedHistory['operations'][number] | null
  transportDiagnostics: Diagnostic[]
  incompleteFinal: boolean
  pendingRoot: Extract<CanonicalRecord, { kind: 'review-attempt' }> | null
}
function analyzeReviewIdentity(history: DecodedHistory, records: ReadonlyMap<string, CanonicalRecord>): ReviewIdentity {
  const reviews = reviewOperations(history)
  const incompleteFinal = reviews.some((review) => review.status !== 'complete' || review.record?.kind !== 'review')
  const latestOperation = incompleteFinal || reviews.length === 0 ? null : reviews[reviews.length - 1]
  const latest = latestOperation?.record?.kind === 'review' ? latestOperation.record : null
  const transportDiagnostics = [...history.diagnostics, ...history.source.diagnostics]
  if (!history.source.complete) transportDiagnostics.push(diagnostic('incomplete', 'Review history is incomplete'))
  return {
    reviews,
    knownReviews: reviews.length,
    latest,
    latestOperation,
    transportDiagnostics,
    incompleteFinal,
    pendingRoot: latestUnfinishedPullRequestRoot(records),
  }
}
function spentBeforeCurrentPullRequestAttempt(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
): boolean | null {
  const root = latestUnfinishedPullRequestRoot(recordMap(history))
  if (root === null) return null
  const rootIndex = history.operations.findIndex(
    (operation) => operation.status === 'complete' && operation.record?.recordId === root.recordId,
  )
  if (rootIndex === -1) return null
  const prefix: DecodedHistory = {
    ...history,
    source: { ...history.source, complete: true, diagnostics: [] },
    operations: history.operations.slice(0, rootIndex),
    diagnostics: [],
  }
  return spentInCompleteHistory(prefix, taxonomy, acceptedPolicyRef)
}
function spentInCompleteHistory(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
): boolean | null {
  const completedHistory: DecodedHistory = {
    ...history,
    source: { ...history.source, complete: true, diagnostics: [] },
    operations: history.operations.filter((operation) => operation.status === 'complete' && operation.record !== null),
    diagnostics: [],
  }
  const graph = validateRecordGraph(completedHistory)
  if (!graph.ok) return null
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  if ([...records.values()].some((record) => record.kind === 'stop')) return true
  const reviews = reviewOperations(completedHistory)
  for (const [index, operation] of reviews.entries()) {
    if (index < 2 || operation.record?.kind !== 'review') continue
    const decision = records.get(operation.record.payload.decisionId)
    if (decision?.kind !== 'decision') return null
    const assessment = validateDecision(decision, completedHistory, taxonomy, acceptedPolicyRef)
    if (!assessment.admissible) return null
    if (assessment.verdict === 'Request changes') return true
  }
  return false
}

export function summarizeReviews(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
): Result<ReviewSummary> {
  return summarizeAuthorityReviews(classifyHistory(history).authorityHistory, taxonomy, acceptedPolicyRef)
}

function summarizeAuthorityReviews(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
): Result<ReviewSummary> {
  const identity = analyzeReviewIdentity(history, recordMap(history))
  const reviews = identity.reviews
  const knownReviews = identity.knownReviews
  const preservedSpent =
    spentInCompleteHistory(history, taxonomy, acceptedPolicyRef) ??
    spentBeforeCurrentPullRequestAttempt(history, taxonomy, acceptedPolicyRef)
  const uncertainSpent: boolean | null = preservedSpent === true ? true : reviews.length >= 3 ? null : false
  if (identity.transportDiagnostics.length > 0 || identity.incompleteFinal)
    return fail(
      identity.transportDiagnostics.length > 0
        ? identity.transportDiagnostics
        : [diagnostic('incomplete', 'A final review operation is not complete')],
      { knownReviews, countExact: history.source.complete, spent: uncertainSpent },
    )
  const graph = validateRecordGraph(history)
  if (!graph.ok)
    return fail(graph.diagnostics, { knownReviews, countExact: history.source.complete, spent: uncertainSpent })
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  let spent = preservedSpent === true
  for (const [index, review] of reviews.entries()) {
    const record = review.record
    if (record?.kind !== 'review') continue
    const decision = records.get(record.payload.decisionId)
    if (decision?.kind !== 'decision')
      return fail([diagnostic('unknown-reference', `Review ${record.recordId} lacks its decision`)], {
        knownReviews,
        countExact: true,
        spent,
      })
    const assessment = validateDecision(decision, history, taxonomy, acceptedPolicyRef)
    if (!assessment.admissible) return fail(assessment.diagnostics, { knownReviews, countExact: true, spent })
    if (index >= 2 && assessment.verdict === 'Request changes') spent = true
  }
  if (identity.pendingRoot !== null)
    return fail(
      [
        diagnostic(
          'incomplete',
          `Pull-request review inventory ${identity.pendingRoot.recordId} is pending completion by its own final review`,
          { rootId: identity.pendingRoot.recordId, pendingRoot: true },
        ),
      ],
      { knownReviews, countExact: true, spent },
    )
  const latest = identity.latest
  if (latest === null)
    return {
      ok: true,
      value: { reviews: 0, reviewId: null, verdict: null, head: null, input: null, at: null, spent: false },
    }
  const at =
    identity.latestOperation?.parts.map((part) => part.updatedAt ?? part.createdAt).find((value) => value !== null) ??
    null
  const decision = records.get(latest.payload.decisionId)
  if (decision?.kind !== 'decision')
    return fail([diagnostic('unknown-reference', `Review ${latest.recordId} lacks its decision`)], {
      knownReviews,
      countExact: true,
      spent,
    })
  const assessment = validateDecision(decision, history, taxonomy, acceptedPolicyRef)
  return assessment.verdict === null
    ? fail(assessment.diagnostics, { knownReviews, countExact: true, spent })
    : {
        ok: true,
        value: {
          reviews: knownReviews,
          reviewId: latest.recordId,
          verdict: assessment.verdict,
          head: latest.payload.candidateGitSHA,
          input: latest.payload.input,
          at,
          spent,
        },
      }
}

export function deriveReviewState(
  history: DecodedHistory,
  facts: ReviewFacts,
  taxonomy: readonly string[],
): ReviewState {
  if (!equalScope(history.source.scope, facts))
    return {
      ok: false,
      next: 'stop',
      knownReviews: 0,
      countExact: false,
      spent: null,
      diagnostics: [diagnostic('unbound', 'Fresh facts have another review scope')],
    }
  const authorityHistory = classifyHistory(history).authorityHistory
  const summary = summarizeAuthorityReviews(authorityHistory, taxonomy, facts.acceptedEvidencePolicyRef)
  if (!summary.ok)
    return {
      ok: false,
      next: 'stop',
      knownReviews: summary.knownReviews ?? 0,
      countExact: summary.countExact ?? false,
      spent: summary.spent ?? null,
      diagnostics: summary.diagnostics,
    }
  const orderedReviews = reviewOperations(authorityHistory).flatMap((operation) =>
    operation.record?.kind === 'review' ? [operation.record] : [],
  )
  const records = recordMap(authorityHistory)
  const persistedStop = [...records.values()].find(
    (record): record is Extract<CanonicalRecord, { kind: 'stop' }> => record.kind === 'stop',
  )
  if (persistedStop !== undefined)
    return { ok: true, summary: { ...summary.value, spent: true }, next: 'stop', requiredStop: persistedStop.payload }
  const latestReview = orderedReviews.length === 0 ? undefined : orderedReviews[orderedReviews.length - 1]
  let spentReview: Extract<CanonicalRecord, { kind: 'review' }> | null = null
  for (const [index, review] of orderedReviews.entries()) {
    const decision = records.get(review.payload.decisionId)
    if (decision?.kind !== 'decision')
      return {
        ok: false,
        next: 'stop',
        knownReviews: summary.value.reviews,
        countExact: true,
        spent: null,
        diagnostics: [diagnostic('unknown-reference', `Review ${review.recordId} lacks its decision`)],
      }
    const assessment = validateDecision(decision, authorityHistory, taxonomy, facts.acceptedEvidencePolicyRef)
    if (!assessment.admissible)
      return {
        ok: false,
        next: 'stop',
        knownReviews: summary.value.reviews,
        countExact: true,
        spent: null,
        diagnostics: assessment.diagnostics,
      }
    if (index >= 2 && assessment.verdict === 'Request changes' && spentReview === null) spentReview = review
  }
  const latestApprovingReview =
    latestReview !== undefined && summary.value.verdict !== null && summary.value.verdict !== 'Request changes'
      ? latestReview
      : null
  const redCiStop =
    orderedReviews.length > 2 &&
    latestApprovingReview !== null &&
    latestApprovingReview.payload.candidateGitSHA === facts.candidateGitSHA &&
    facts.ci === 'red'
  const requiredStop: Stop | null =
    spentReview !== null
      ? {
          reason: 'review-bound',
          reviewId: spentReview.recordId,
          detail: { reviews: summary.value.reviews, verdict: 'Request changes' },
        }
      : latestApprovingReview !== null && redCiStop
        ? {
            reason: 'ci-failed',
            reviewId: latestApprovingReview.recordId,
            detail: { reviews: summary.value.reviews, ci: facts.ci },
          }
        : null
  if (requiredStop !== null) return { ok: true, summary: { ...summary.value, spent: true }, next: 'stop', requiredStop }
  if (facts.ci === 'unknown')
    return {
      ok: false,
      next: 'stop',
      knownReviews: summary.value.reviews,
      countExact: true,
      spent: summary.value.spent,
      diagnostics: [diagnostic('unreadable', 'CI state is unknown and cannot retain an arm')],
    }
  if (!facts.proofAdmission.ok) return { ok: true, summary: summary.value, next: 'wait', requiredStop: null }
  if (summary.value.head !== null && summary.value.head !== facts.candidateGitSHA)
    return { ok: true, summary: summary.value, next: 'review', requiredStop: null }
  if (summary.value.input !== facts.input)
    return { ok: true, summary: summary.value, next: 'review', requiredStop: null }
  if (facts.ci === 'pending' || facts.ci === 'red')
    return { ok: true, summary: summary.value, next: 'wait', requiredStop: null }
  if (summary.value.verdict === 'Request changes')
    return { ok: true, summary: summary.value, next: 'fix', requiredStop: null }
  return {
    ok: true,
    summary: summary.value,
    next: summary.value.verdict === null ? 'review' : 'admit',
    requiredStop: null,
  }
}

function stringified(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null'
}

const trustedReviewOrStop = (operation: DecodedHistory['operations'][number]): boolean => claimsReviewOrStop(operation)

function trustedCollisionIndexes(history: DecodedHistory, classification: HistoryClassification): Set<number> {
  const collisions = new Set<number>()
  const authorities = new Map(classification.classes.map((entry) => [entry.index, entry.authority]))
  const trusted = (index: number): boolean =>
    authorities.get(index) === 'authority' && trustedReviewOrStop(history.operations[index])
  const byOperationId = new Map<string, number[]>()
  const byRecordId = new Map<string, number[]>()
  for (const [index, operation] of history.operations.entries()) {
    if (operation.operationId !== null) {
      const indexes = byOperationId.get(operation.operationId) ?? []
      indexes.push(index)
      byOperationId.set(operation.operationId, indexes)
    }
    if (operation.recordId !== null) {
      const indexes = byRecordId.get(operation.recordId) ?? []
      indexes.push(index)
      byRecordId.set(operation.recordId, indexes)
    }
    if ((operation.status === 'conflict' || operation.status === 'invalid') && trusted(index)) collisions.add(index)
  }
  for (const indexes of [...byOperationId.values(), ...byRecordId.values()]) {
    if (indexes.length < 2 || !indexes.some(trusted)) continue
    for (const index of indexes) collisions.add(index)
  }
  return collisions
}

function projectionClosure(
  record: CanonicalRecord,
  history: DecodedHistory,
  classification: HistoryClassification,
): Result<DecodedHistory> {
  const authorities = new Map(classification.classes.map((entry) => [entry.index, entry.authority]))
  const selected = new Set<number>()
  for (const index of trustedCollisionIndexes(history, classification)) selected.add(index)
  const resolving = new Set<string>()

  const include = (recordId: string): Diagnostic[] | null => {
    if (resolving.has(recordId)) return null
    resolving.add(recordId)
    const candidates = history.operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => operation.recordId === recordId || operation.record?.recordId === recordId)
    if (candidates.length === 0)
      return [
        diagnostic('unknown-reference', `Projection record ${record.recordId} requires absent record ${recordId}`),
      ]
    if (candidates.some(({ index }) => authorities.get(index) === 'foreign'))
      return [diagnostic('unbound', `Projection record ${record.recordId} requires foreign record ${recordId}`)]
    const complete = candidates.filter(
      ({ operation }) =>
        operation.status === 'complete' && operation.record !== null && operation.record.recordId === recordId,
    )
    if (complete.length !== candidates.length)
      return [diagnostic('unbound', `Projection record ${record.recordId} has an ambiguous record ${recordId}`)]
    const canonical = complete[0].operation.record
    if (canonical === null)
      return [
        diagnostic('unknown-reference', `Projection record ${record.recordId} requires incomplete record ${recordId}`),
      ]
    if (complete.some(({ operation }) => operation.record === null || !sameJson(operation.record, canonical)))
      return [diagnostic('unbound', `Projection record ${record.recordId} has conflicting records for ${recordId}`)]
    for (const { index } of complete) selected.add(index)
    for (const input of canonical.inputs) {
      const diagnostics = include(input)
      if (diagnostics !== null) return diagnostics
    }
    return null
  }

  const rootCandidates = history.operations
    .map((operation, index) => ({ operation, index }))
    .filter(({ operation }) => operation.recordId === record.recordId || operation.record?.recordId === record.recordId)
  if (rootCandidates.some(({ index }) => authorities.get(index) !== 'authority'))
    return fail([diagnostic('unbound', `Record ${record.recordId} collides with a non-authority operation`)])
  const rootComplete = rootCandidates.filter(
    ({ operation }) =>
      operation.status === 'complete' && operation.record !== null && operation.record.recordId === record.recordId,
  )
  if (rootCandidates.length !== rootComplete.length)
    return fail([diagnostic('unbound', `Record ${record.recordId} has an ambiguous observed operation`)])
  if (rootComplete.some(({ operation }) => operation.record === null || !sameJson(operation.record, record)))
    return fail([diagnostic('unbound', `Record ${record.recordId} conflicts with its observed immutable record`)])
  for (const { index } of rootComplete) selected.add(index)
  for (const input of record.inputs) {
    const diagnostics = include(input)
    if (diagnostics !== null) return fail(diagnostics)
  }

  const operations = [...selected].sort((left, right) => left - right).map((index) => history.operations[index])
  const operationIds = new Set(
    operations.flatMap((operation) => (operation.operationId === null ? [] : [operation.operationId])),
  )
  return {
    ok: true,
    value: {
      ...history,
      source: history.source,
      operations:
        rootComplete.length === 0
          ? [
              ...operations,
              {
                operationId: record.operationId,
                recordId: record.recordId,
                kind: record.kind,
                claimedKinds: [record.kind],
                status: 'complete',
                parts: [],
                record,
                authority: 'authority',
              },
            ]
          : operations,
      diagnostics: [
        ...history.diagnostics.filter(
          (diagnostic) => diagnostic.operationId === undefined || operationIds.has(diagnostic.operationId),
        ),
        ...classification.authorityHistory.diagnostics.filter((diagnostic) => diagnostic.code === 'unclassified'),
      ],
    },
  }
}

function projectWorkflowRecord(
  record: CanonicalRecord,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
): Result<string> {
  const meaning = workflowInputMeaning(record)
  if (meaning !== null) return fail([meaning])
  if (!history.source.complete || !equalScope(record, history.source.scope))
    return fail([
      diagnostic('unbound', `Record ${record.recordId} cannot be projected outside a complete bound history`),
    ])
  const records = recordMap(history)
  const home = records.get(record.recordId)
  if (home !== undefined && JSON.stringify(home) !== JSON.stringify(record))
    return fail([
      diagnostic('conflict', `Record ${record.recordId} conflicts with the complete record already in this history`),
    ])
  if (
    history.operations.some(
      (operation) => operation.record?.recordId === record.recordId && operation.authority === 'foreign',
    )
  )
    return fail([diagnostic('foreign', `Record ${record.recordId} is not from the expected author`)])
  for (const ref of scopedRefsOf(record)) {
    if (equalScope(ref.scope, { repository: record.repository, target: record.target })) {
      const found = records.get(ref.recordId)
      if (found === undefined)
        return fail([
          diagnostic('unknown-reference', `Record ${record.recordId} lacks same-scope input ${ref.recordId}`),
        ])
      if (found.kind !== ref.kind)
        return fail([diagnostic('kind-mismatch', `Record ${ref.recordId} is ${found.kind}, not ${ref.kind}`)])
      continue
    }
    const foreign = externalHistories.find((item) => equalScope(item.source.scope, ref.scope))
    if (foreign === undefined)
      return fail([
        diagnostic('missing-history', `No history was supplied for ${ref.scope.repository} ${ref.scope.target}`),
      ])
    if (!foreign.source.complete) return fail([diagnostic('incomplete', 'External history pagination is incomplete')])
    const matches = foreign.operations.filter(
      (operation) => operation.record?.recordId === ref.recordId || operation.recordId === ref.recordId,
    )
    if (matches.length === 0)
      return fail([diagnostic('unknown', `Record ${ref.recordId} is not in the foreign history`)])
    if (matches.some((operation) => operation.status === 'conflict'))
      return fail([diagnostic('conflict', `Record ${ref.recordId} has conflicting parts`)])
    if (
      matches.some(
        (operation) =>
          operation.status !== 'complete' || operation.record === null || operation.authority === 'foreign',
      )
    )
      return fail([diagnostic('unconfirmed', `Record ${ref.recordId} is not a complete authenticated record`)])
    const bodies = new Set(matches.map((operation) => JSON.stringify(operation.record)))
    if (bodies.size !== 1) return fail([diagnostic('ambiguous', `Record ${ref.recordId} has incompatible duplicates`)])
    if (matches[0]?.record?.kind !== ref.kind)
      return fail([diagnostic('kind-mismatch', `Record ${ref.recordId} kind does not match the reference`)])
  }
  return {
    ok: true,
    value: `# OMP build record\n\n- Kind: ${record.kind}\n- Record: ${record.recordId}\n- Operation: ${record.operationId}\n\n\`\`\`json\n${stringified(record.payload)}\n\`\`\``,
  }
}

export function projectRecord(
  record: CanonicalRecord,
  history: DecodedHistory,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
): Result<string> {
  if (isWorkflowKind(record.kind)) return projectWorkflowRecord(record, history, externalHistories)
  const closure = projectionClosure(record, history, classifyHistory(history))
  if (!closure.ok) return fail(closure.diagnostics)
  const projectionHistory = closure.value
  const graph = validateRecordGraph(projectionHistory)
  if (!graph.ok) return fail(graph.diagnostics)
  if (!projectionHistory.source.complete || !equalScope(record, projectionHistory.source.scope))
    return fail([
      diagnostic('unbound', `Record ${record.recordId} cannot be projected outside a complete bound history`),
    ])
  const records = new Map(graph.value.map((entry) => [entry.recordId, entry]))
  if (record.kind === 'review') {
    const decision = records.get(record.payload.decisionId)
    if (decision?.kind !== 'decision')
      return fail([diagnostic('unknown-reference', `Review ${record.recordId} lacks its decision`)])
    if (
      config === null ||
      typeof config !== 'object' ||
      !Array.isArray(Reflect.get(config, 'taxonomy')) ||
      Reflect.get(config, 'taxonomy').some((classId: unknown) => typeof classId !== 'string') ||
      (Reflect.get(config, 'acceptedPolicy') !== null && typeof Reflect.get(config, 'acceptedPolicy') !== 'string')
    )
      return fail([diagnostic('unbound', `Review ${record.recordId} has no valid projection policy context`)])
    const assessment = validateDecision(decision, projectionHistory, config.taxonomy, config.acceptedPolicy)
    if (!assessment.admissible || assessment.verdict === null)
      return fail(
        assessment.diagnostics.length > 0
          ? assessment.diagnostics
          : [diagnostic('unusable-finding', 'Review decision is not admissible')],
      )
    const provenance = decision.payload.judgment.sourceContributionIds.map((sourceId) => {
      const source = records.get(sourceId)
      return source?.kind === 'contribution'
        ? { contributionId: sourceId, host: source.payload.host, originals: source.payload.findings }
        : { contributionId: sourceId }
    })
    const standards = decision.payload.judgment.purpose === 'review' ? decision.payload.judgment.standards : null
    const standardsDisplay =
      standards === null
        ? 'smells: unavailable'
        : standards.state === 'ras'
          ? 'smells: RAS'
          : standards.rows.map((row) => `- possible ${row.smell}: ${row.assessment}`).join('\n')
    return {
      ok: true,
      value: `# OMP build review\n\n**Verdict: ${assessment.verdict}**\n\n- Record: ${record.recordId}\n- Decision: ${record.payload.decisionId}\n- Candidate: ${record.payload.candidateGitSHA}\n- Input: ${record.payload.input ?? 'none'}\n\n## Findings\n\n${stringified(decision.payload.judgment.findings)}\n\n## Standards\n\n${standardsDisplay}\n\n## Source provenance\n\n${stringified(provenance)}`,
    }
  }
  if (record.kind === 'contribution' && record.payload.host.origin === 'operator') {
    const native =
      record.payload.native === null
        ? null
        : {
            completion: record.payload.native.completion,
            strict: record.payload.native.strict,
          }
    return {
      ok: true,
      value: `# OMP build contribution\n\n- Canonical frame record: ${record.recordId}\n- Canonical frame operation: ${record.operationId}\n\n\`\`\`json\n${stringified({ ...record.payload, native })}\n\`\`\``,
    }
  }
  return {
    ok: true,
    value: `# OMP build record\n\n- Kind: ${record.kind}\n- Record: ${record.recordId}\n- Operation: ${record.operationId}\n\n\`\`\`json\n${stringified(record.payload)}\n\`\`\``,
  }
}
