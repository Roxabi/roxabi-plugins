import { z } from 'zod'
import { buildRecord, type Result } from './core.ts'
import {
  type AssessSpecResultPayload,
  type CanonicalRecord,
  ciAttributionSchema,
  type DecodedHistory,
  type Diagnostic,
  type ExternalRecordRef,
  failedCheckEvidenceDigest,
  type implementationCommandSchema,
  implementationOutputSchema,
  isWorkflowKind,
  type Json,
  PLAN_REVIEW_SPECIALISTS,
  type PlanBlockerRef,
  type PlanOutput,
  type ProofConfigPin,
  planDigest,
  planOutputSchema,
  planReviewSchema,
  type Scope,
  specAssessmentSchema,
  specDigest,
} from './schemas.ts'

export { type FailedCheckFailure, failedCheckEvidenceDigest, failedCheckFailureSchema } from './schemas.ts'

export type MandateRecord = Extract<CanonicalRecord, { kind: 'mandate' }>
type ControlRecord = Extract<CanonicalRecord, { kind: 'operator-control' }>
type ReceiptRecord = Extract<CanonicalRecord, { kind: 'action-receipt' }>
type WorkflowBindingRecord = Extract<CanonicalRecord, { kind: 'workflow-binding' }>

export type PauseBinding = {
  mandate: ExternalRecordRef
  confirmation: ExternalRecordRef
}
type AssessResultRecord = {
  repository: string
  target: string
  version: 1
  recordId: string
  runId: string
  operationId: string
  inputs: string[]
  kind: 'action-receipt'
  payload: AssessSpecResultPayload
}
function isAssessResult(record: CanonicalRecord): record is AssessResultRecord {
  return (
    record.kind === 'action-receipt' && record.payload.action === 'assess-spec' && record.payload.phase === 'result'
  )
}

const diagnostic = (code: string, message: string, detail?: Json): Diagnostic =>
  detail === undefined ? { code, message } : { code, message, detail }
const fail = <T>(diagnostics: Diagnostic[]): Result<T> => ({ ok: false, diagnostics })
const equalScope = (left: Scope, right: Scope): boolean =>
  left.repository === right.repository && left.target === right.target
const sameRef = (left: ExternalRecordRef, right: ExternalRecordRef): boolean =>
  left.recordId === right.recordId && left.kind === right.kind && equalScope(left.scope, right.scope)

export const workflowGraphActionSchema = z.enum([
  'frame',
  'assess-spec',
  'plan',
  'implement',
  'publish',
  'proof',
  'review',
  'fix',
  'attribute-ci',
  'land',
  'watch',
  'epic-next',
  'epic-final',
  'mark-fix',
  'hook',
  'report',
  'stop',
  'done',
])
export type WorkflowGraphAction = z.infer<typeof workflowGraphActionSchema>
export const workflowConditionSchema = z.enum([
  'always',
  'no-mandate',
  'mandate-ready',
  'spec-differs',
  'spec-settled',
  'plan-confirmed',
  'implement-confirmed',
  'pr-open',
  'proof-confirmed',
  'review-step-review',
  'review-step-fix',
  'review-step-land',
  'review-step-stop',
  'fix-confirmed',
  'ci-red',
  'ci-attributed-change',
  'ci-attribution-refused',
  'merged',
  'end-obligations-met',
  'epic-start',
  'epic-resume',
  'epic-stop',
  'epic-final-review',
  'epic-fix-ticket',
  'epic-post-merge',
  'epic-complete',
  'epic-drop',
])
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>
export const workflowGraphSchema = z.strictObject({
  version: z.literal(1),
  productVersion: z.string().min(1),
  configVersion: z.string().min(1),
  edgeOrder: z.literal('array'),
  nodes: z.array(z.strictObject({ id: z.string().min(1), action: workflowGraphActionSchema })).min(1),
  edges: z.array(
    z.strictObject({
      from: z.string().min(1),
      to: z.string().min(1),
      when: workflowConditionSchema,
    }),
  ),
  initial: z.string().min(1),
})
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>

export type WorkflowBlockReason =
  | 'mandate-absent'
  | 'pause-unconfirmed'
  | 'spec-decision-required'
  | 'config-drift'
  | 'proof-pin-drift'
  | 'unsupported-config'
  | 'action-uncertain'
  | 'unknown-outcome'
  | 'ambiguous-transition'
  | 'session-cwd'
  | 'fix-only'
  | 'ci-attribution-required'
  | 'successor-required'
  | 'unsafe-authority'
  | 'cycle'
  | 'unsupported-graph'
  | 'unconfirmed'
  | 'incomplete'
  | 'missing-history'
  | 'unknown-binding'
  | 'missing-contribution'
export type WorkflowDecision =
  | {
      status: 'action'
      action: WorkflowGraphAction
      nodeId: string | null
      mandateId: string | null
      evidence: Diagnostic[]
    }
  | {
      status: 'action'
      action: 'resume'
      nodeId: null
      mandateId: string
      evidence: Diagnostic[]
      pause: PauseBinding
    }
  | { status: 'blocked'; reason: WorkflowBlockReason; evidence: Diagnostic[] }
  | { status: 'paused'; mandateId: string; confirmed: true; evidence: Diagnostic[]; pause?: PauseBinding }
  | { status: 'abandoned'; mandateId: string; evidence: Diagnostic[] }
  | {
      status: 'terminal'
      reason: 'stop' | 'done' | 'spec-ambiguous' | 'ci-attribution-refused' | 'bound-stop' | 'abandoned'
      evidence: Diagnostic[]
    }

export type WorkflowFacts = {
  specDigest: string | null
  specBody: string | null
  branch: string | null
  base: string | null
  candidateGitSHA: string | null
  pullRequest: { scope: Scope; head: string; base: string; associatedIssue: Scope | null } | null
  merged: boolean
  sessionCwd: string | null
  preparedWorktree: string | null
  productVersion: string
  configVersion: string
  configDigest: string
  supportedConfigVersions: readonly string[]
  proofPins: readonly ProofConfigPin[]
  explicitSelection: boolean
  explicitResume: boolean
  successorAntecedent: ExternalRecordRef | null
  endObligationsMet: boolean
  localInhibit: 'pause' | 'abandon' | null
  /** Display names only. Omitted or empty is not current CI evidence. */
  failedChecks?: readonly string[] | null
  /** Digest from failedCheckEvidenceDigest of the current native failures. Omitted or null cannot authorize fix. */
  evidenceDigest?: string | null
}

export type NativeSelectorStatus = 'absent' | 'published' | 'uncertain' | 'failed' | 'not-applicable'
export type NativeSelector = { status: NativeSelectorStatus; evidence: Diagnostic[] }
export type ProofSelector = {
  admission: { ok: true; candidateGitSHA: string; input: string; recordIds: readonly string[] } | null
  candidateGitSHA: string | null
  input: string | null
  applicability: 'required' | 'not-applicable'
  evidence: Diagnostic[]
}
export type SpecializedDecisions = {
  reviewStep: 'review' | 'fix' | 'land' | 'stop' | null
  epicStep: 'start' | 'resume' | 'stop' | 'final-review' | 'fix-ticket' | 'post-merge' | 'complete' | 'drop' | null
  epicLand: boolean | null
  ciWatchStatus: 'green' | 'red' | 'pending' | 'timeout' | 'behind' | 'unknown' | null
  publish: NativeSelector
  landing: NativeSelector
  watch: NativeSelector
  proof: ProofSelector
}

export type MandateRefusal =
  | 'missing'
  | 'paused'
  | 'abandoned'
  | 'revoked'
  | 'unsupported'
  | 'config-invalid'
  | 'ambiguous'
  | 'incomplete'
  | 'unconfirmed'
  | 'unknown-binding'
  | 'incompatible'
  | 'unsafe'
  | 'materially-changed'
  | 'missing-history'

export type MandateSelection =
  | { status: 'applicable'; mandate: MandateRecord }
  | { status: 'refused'; reason: 'paused'; evidence: Diagnostic[]; pause: PauseBinding }
  | { status: 'refused'; reason: Exclude<MandateRefusal, 'paused'>; evidence: Diagnostic[] }

export type FixMandateAssessment =
  | { status: 'applicable'; mandate: MandateRecord; execution: { correct: true; landing: false } }
  | { status: 'refused'; reason: MandateRefusal; evidence: Diagnostic[] }

export type LandingRefusal =
  | 'missing'
  | 'fix-only'
  | 'paused'
  | 'abandoned'
  | 'stale'
  | 'unsupported'
  | 'unconfirmed'
  | 'foreign'
  | 'ambiguous'
  | 'revoked'
  | 'material-spec'
  | 'config-drift'
  | 'proof-pin-drift'
  | 'unbound'
  | 'conflict'
  | 'incomplete'
  | 'unknown-binding'
  | 'incompatible'
  | 'unsafe'
  | 'materially-changed'
  | 'missing-history'

export type LandingMandateDecision =
  | { ok: true; recordId: string; scope: Scope; proofPins: ProofConfigPin[]; mandate: MandateRecord }
  | { ok: false; reason: LandingRefusal; evidence: Diagnostic[] }

const WORKTREE_ACTIONS = new Set<string>([
  'frame',
  'assess-spec',
  'plan',
  'implement',
  'publish',
  'proof',
  'review',
  'fix',
  'attribute-ci',
  'epic-next',
  'epic-final',
  'mark-fix',
  'hook',
  'report',
])

function refused<T extends MandateRefusal>(
  reason: T,
  evidence: Diagnostic[],
): { status: 'refused'; reason: T; evidence: Diagnostic[] } {
  return { status: 'refused', reason, evidence }
}

function recordsOf(history: DecodedHistory): CanonicalRecord[] {
  const records: CanonicalRecord[] = []
  const seen = new Set<string>()
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || operation.record === null || operation.authority === 'foreign') continue
    if (seen.has(operation.record.recordId)) continue
    seen.add(operation.record.recordId)
    records.push(operation.record)
  }
  return records
}

function workflowOperationProblem(history: DecodedHistory): 'ambiguous' | 'incomplete' | 'unconfirmed' | null {
  if (!history.source.complete) return 'incomplete'
  for (const operation of history.operations) {
    const kind = operation.record?.kind ?? operation.kind
    if (!isWorkflowKind(kind ?? '') && !operation.claimedKinds.some((claim) => isWorkflowKind(claim))) continue
    if (operation.status === 'conflict') return 'ambiguous'
    if (operation.status === 'incomplete' || operation.status === 'invalid' || operation.status === 'legacy')
      return 'unconfirmed'
    if (operation.authority === 'foreign') return 'unconfirmed'
  }
  return null
}

export function bindExternalRef(ref: ExternalRecordRef, foreignHistory: DecodedHistory): Result<CanonicalRecord> {
  if (!equalScope(ref.scope, foreignHistory.source.scope))
    return fail([
      diagnostic('missing-history', `No history was supplied for ${ref.scope.repository} ${ref.scope.target}`),
    ])
  if (!foreignHistory.source.complete)
    return fail([diagnostic('incomplete', 'External history pagination is incomplete')])
  const matches = foreignHistory.operations.filter(
    (operation) => operation.recordId === ref.recordId || operation.record?.recordId === ref.recordId,
  )
  if (matches.length === 0) return fail([diagnostic('unknown', `Record ${ref.recordId} is not in the foreign history`)])
  if (matches.some((operation) => operation.status === 'conflict'))
    return fail([diagnostic('conflict', `Record ${ref.recordId} has conflicting parts`)])
  if (matches.some((operation) => operation.status !== 'complete' || operation.record === null))
    return fail([diagnostic('unconfirmed', `Record ${ref.recordId} is not a complete authenticated record`)])
  if (matches.some((operation) => operation.authority === 'foreign'))
    return fail([diagnostic('foreign', `Record ${ref.recordId} is not from the expected author`)])
  const bodies = matches.map((operation) => JSON.stringify(operation.record))
  if (new Set(bodies).size !== 1)
    return fail([diagnostic('ambiguous', `Record ${ref.recordId} has incompatible duplicates`)])
  const record = matches[0]?.record
  if (record === null || record === undefined)
    return fail([diagnostic('unconfirmed', `Record ${ref.recordId} has no body`)])
  if (record.kind !== ref.kind)
    return fail([diagnostic('kind-mismatch', `Record ${ref.recordId} is ${record.kind}, not ${ref.kind}`)])
  return { ok: true, value: record }
}

function historyFor(scope: Scope, histories: readonly DecodedHistory[]): DecodedHistory | null {
  return histories.find((history) => equalScope(history.source.scope, scope)) ?? null
}

function controlsOf(history: DecodedHistory): ControlRecord[] {
  return recordsOf(history).filter((record): record is ControlRecord => record.kind === 'operator-control')
}

function mandatesOf(history: DecodedHistory): MandateRecord[] {
  return recordsOf(history).filter((record): record is MandateRecord => record.kind === 'mandate')
}

function pauseRequestFor(mandate: MandateRecord, record: ControlRecord): boolean {
  return (
    record.payload.control === 'pause-requested' &&
    sameRef(record.payload.mandate, { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' })
  )
}

function pauseConfirmationFor(
  history: DecodedHistory,
  mandate: MandateRecord,
  request: ControlRecord,
): ControlRecord | null {
  const requestRef: ExternalRecordRef = {
    scope: { repository: request.repository, target: request.target },
    recordId: request.recordId,
    kind: 'operator-control',
  }
  return (
    controlsOf(history).find(
      (record) =>
        record.payload.control === 'pause-confirmed' &&
        record.payload.controlId === request.payload.controlId &&
        sameRef(record.payload.mandate, {
          scope: mandateScope(mandate),
          recordId: mandate.recordId,
          kind: 'mandate',
        }) &&
        record.payload.predecessor !== null &&
        sameRef(record.payload.predecessor, requestRef) &&
        record.payload.disarm.observed === true,
    ) ?? null
  )
}

function confirmedPause(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request)) continue
    const confirmation = pauseConfirmationFor(history, mandate, request)
    if (confirmation !== null) return confirmation
  }
  return null
}

function unliftedPause(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request)) continue
    const confirmation = pauseConfirmationFor(history, mandate, request)
    if (confirmation !== null && !pauseLifted(history, confirmation)) return confirmation
  }
  return null
}

function outstandingPauseRequest(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  return (
    controlsOf(history).find(
      (record) => pauseRequestFor(mandate, record) && pauseConfirmationFor(history, mandate, record) === null,
    ) ?? null
  )
}

function outstandingPauseInAuthority(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  seen: ReadonlySet<string> = new Set(),
): Diagnostic | null {
  const scope = mandateScope(mandate)
  const key = `${scope.repository}\0${scope.target}\0${mandate.recordId}`
  if (seen.has(key)) return null
  const home = historyFor(scope, histories)
  if (home === null) return null
  if (outstandingPauseRequest(home, mandate) !== null)
    return diagnostic('pause-unconfirmed', `Mandate ${mandate.recordId} has an unconfirmed pause request`)
  if (mandate.payload.parent === null) return null
  const parentHistory = historyFor(mandate.payload.parent.scope, histories)
  if (parentHistory === null) return null
  const parent = bindExternalRef(mandate.payload.parent, parentHistory)
  if (!parent.ok || parent.value.kind !== 'mandate') return null
  const nextSeen = new Set(seen)
  nextSeen.add(key)
  return outstandingPauseInAuthority(parent.value, histories, nextSeen)
}

function pauseLifted(history: DecodedHistory, confirmation: ControlRecord): boolean {
  if (confirmation.payload.control !== 'pause-confirmed') return false
  return controlsOf(history).some(
    (record) =>
      record.payload.control === 'resume' &&
      record.payload.controlId === confirmation.payload.controlId &&
      sameRef(record.payload.mandate, confirmation.payload.mandate) &&
      sameRef(record.payload.predecessor, {
        scope: { repository: confirmation.repository, target: confirmation.target },
        recordId: confirmation.recordId,
        kind: 'operator-control',
      }),
  )
}

function mandateScope(record: MandateRecord): Scope {
  return { repository: record.repository, target: record.target }
}

function abandoned(history: DecodedHistory, mandate: MandateRecord): boolean {
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' as const }
  return controlsOf(history).some(
    (record) => record.payload.control === 'abandon' && sameRef(record.payload.mandate, mandateRef),
  )
}

function successorOf(history: DecodedHistory, mandate: MandateRecord): ExternalRecordRef | null {
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' as const }
  const control = controlsOf(history).find(
    (record) => record.payload.control === 'select-successor' && sameRef(record.payload.predecessor, mandateRef),
  )
  return control?.payload.control === 'select-successor' ? control.payload.successor : null
}

function epicFixScopes(histories: readonly DecodedHistory[], run: string): Scope[] {
  const scopes: Scope[] = []
  for (const history of histories) {
    for (const record of recordsOf(history)) {
      if (record.kind !== 'epic-event' || record.runId !== run) continue
      if (typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) continue
      if (Reflect.get(record.payload, 'event') !== 'epic-fix') continue
      scopes.push({ repository: record.repository, target: record.target })
    }
  }
  return scopes
}

function childPermitted(parent: MandateRecord, childScope: Scope, histories: readonly DecodedHistory[]): boolean {
  if (parent.payload.role !== 'epic') return false
  if (parent.payload.children.some((child) => equalScope(child.scope, childScope))) return true
  return epicFixScopes(histories, parent.payload.run).some((scope) => equalScope(scope, childScope))
}

export type AcceptedSpecRef =
  | { kind: 'mandate'; recordId: string; scope: Scope; specDigest: string }
  | { kind: 'editorial'; recordId: string; scope: Scope; acceptedDigest: string; currentDigest: string }
  | { kind: 'accept-material'; recordId: string; scope: Scope; specDigest: string; assessment: ExternalRecordRef }

export type AcceptedSpec = {
  reference: string
  body: string
  digest: string
  lastEditedAt: string
  chain: readonly AcceptedSpecRef[]
  sourceRefs: readonly ExternalRecordRef[]
}

export type AcceptedSpecResult =
  | { ok: true; spec: AcceptedSpec }
  | { ok: false; reason: 'incomplete' | 'ambiguous' | 'material-spec' | 'missing-history'; evidence: Diagnostic[] }

export type ConfigIdentity = {
  productVersion: string
  version: string
  digest: string
  additionalRequirements: readonly string[]
  serialized: string
}

export type MandateUse = 'review' | 'correction' | 'landing'

export type BoundWork =
  | {
      status: 'applicable'
      binding: 'bound'
      mandate: MandateRecord
      scope: Scope
      permissions: { landing: boolean; correct: boolean }
      acceptedSpec: AcceptedSpec
      configIdentity: ConfigIdentity
      drift: 'settled' | 'differs' | null
    }
  | { status: 'standalone'; binding: 'absent' }
  | { status: 'refused'; reason: MandateRefusal | LandingRefusal; evidence: Diagnostic[] }

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
function specChainFailure(reason: SpecChainFailure['reason'], message: string, code?: string): SpecChainFailure {
  return { ok: false, reason, evidence: [diagnostic(code ?? reason, message)] }
}

function receiptRef(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}

function sameAssessInputs(
  left: { acceptedDigest: string; currentDigest: string; acceptedBody: string; currentBody: string },
  right: { acceptedDigest: string; currentDigest: string; acceptedBody: string; currentBody: string },
): boolean {
  return (
    left.acceptedDigest === right.acceptedDigest &&
    left.currentDigest === right.currentDigest &&
    left.acceptedBody === right.acceptedBody &&
    left.currentBody === right.currentBody
  )
}

function assessResultRecord(record: CanonicalRecord): AssessResultRecord | null {
  return isAssessResult(record) ? record : null
}
function authenticatedAssessResult(
  record: CanonicalRecord,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): SpecChainFailure | { ok: true; record: AssessResultRecord } {
  const assessed = assessResultRecord(record)
  if (assessed === null) return specChainFailure('incomplete', 'Spec assessment is not a result')
  if (!sameRef(assessed.payload.mandate, mandateRef))
    return specChainFailure('ambiguous', 'Spec assessment names a different mandate')
  const home = historyFor({ repository: assessed.repository, target: assessed.target }, histories)
  if (home === null) return specChainFailure('missing-history', 'Spec assessment history is missing')
  const bound = bindExternalRef(receiptRef(assessed), home)
  if (!bound.ok) {
    const code = bound.diagnostics[0]?.code
    const reason =
      code === 'conflict' || code === 'ambiguous'
        ? 'ambiguous'
        : code === 'missing-history'
          ? 'missing-history'
          : 'incomplete'
    return { ok: false, reason, evidence: bound.diagnostics }
  }
  const confirmed = assessResultRecord(bound.value)
  if (confirmed === null) return specChainFailure('incomplete', 'Spec assessment is not a result')
  if (confirmed.payload.native.completion !== 'completed' || confirmed.payload.native.strict !== 'valid')
    return specChainFailure('incomplete', 'Spec assessment is not a confirmed native result', 'unconfirmed')
  const startHistory = historyFor(confirmed.payload.start.scope, histories)
  if (startHistory === null) return specChainFailure('incomplete', 'Spec assessment start is unresolved', 'unconfirmed')
  const start = bindExternalRef(confirmed.payload.start, startHistory)
  if (!start.ok) return specChainFailure('incomplete', 'Spec assessment start is unresolved', 'unconfirmed')
  if (start.value.kind !== 'action-receipt')
    return specChainFailure('incomplete', 'Spec assessment start does not match its result', 'unconfirmed')
  const startPayload = start.value.payload
  if (startPayload.action !== 'assess-spec' || startPayload.phase !== 'start')
    return specChainFailure('incomplete', 'Spec assessment start does not match its result', 'unconfirmed')
  if (
    startPayload.actionId !== confirmed.payload.actionId ||
    !sameRef(startPayload.mandate, mandateRef) ||
    !sameAssessInputs(startPayload.exactInputs, confirmed.payload.exactInputs)
  ) {
    return specChainFailure('incomplete', 'Spec assessment start does not match its result', 'unconfirmed')
  }
  return { ok: true, record: confirmed }
}
function confirmedAssessPairs(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): AcceptedSpecResult | { ok: true } {
  for (const record of recordsOf(home)) {
    if (record.kind !== 'action-receipt' || record.payload.action !== 'assess-spec' || record.payload.phase !== 'start')
      continue
    if (!sameRef(record.payload.mandate, mandateRef)) continue
    const startRef = receiptRef(record)
    const results = recordsOf(home).filter(
      (candidate) =>
        candidate.kind === 'action-receipt' &&
        candidate.payload.action === 'assess-spec' &&
        candidate.payload.phase === 'result' &&
        candidate.payload.actionId === record.payload.actionId &&
        sameRef(candidate.payload.start, startRef) &&
        sameRef(candidate.payload.mandate, mandateRef),
    )
    if (results.length === 0)
      return specChainFailure('incomplete', 'Spec assessment start has no confirmed result', 'action-uncertain')
    if (results.length > 1) return specChainFailure('ambiguous', 'Spec assessment start has competing results')
    const authenticated = authenticatedAssessResult(results[0] ?? record, histories, mandateRef)
    if (!authenticated.ok) return authenticated
  }
  return { ok: true }
}

export function resolveAcceptedSpec(mandate: MandateRecord, histories: readonly DecodedHistory[]): AcceptedSpecResult {
  const scope = mandateScope(mandate)
  const home = historyFor(scope, histories)
  if (home === null || !home.source.complete) return specChainFailure('missing-history', 'Mandate history is missing')
  const problem = workflowOperationProblem(home)
  if (problem === 'ambiguous') return specChainFailure('ambiguous', 'Workflow history conflicts')
  if (problem === 'unconfirmed' || problem === 'incomplete')
    return specChainFailure('incomplete', 'Workflow history is not confirmed', problem)
  const mandateRef: ExternalRecordRef = { scope, recordId: mandate.recordId, kind: 'mandate' }
  const confirmed = confirmedAccountedMandate(home, mandateRef)
  if (confirmed === null)
    return specChainFailure('incomplete', 'Mandate is not a confirmed accounted record', 'unconfirmed')
  if (JSON.stringify(confirmed) !== JSON.stringify(mandate))
    return specChainFailure('ambiguous', 'Mandate does not match the authenticated history')
  if (specDigest(confirmed.payload.spec.body) !== confirmed.payload.spec.bodySha256)
    return specChainFailure('material-spec', 'Mandate spec digest does not match its body')
  const applied = new Set<string>([confirmed.recordId])
  const pairs = confirmedAssessPairs(home, histories, mandateRef)
  if (!pairs.ok) return pairs
  let body = confirmed.payload.spec.body
  let digest = confirmed.payload.spec.bodySha256
  let head = confirmed.recordId
  const chain: AcceptedSpecRef[] = [{ kind: 'mandate', recordId: confirmed.recordId, scope, specDigest: digest }]
  const sourceRefs: ExternalRecordRef[] = [mandateRef]
  for (let guard = 0; guard < recordsOf(home).length + 1; guard += 1) {
    const editorials: AssessResultRecord[] = []
    let materialClaims = 0
    for (const record of recordsOf(home)) {
      if (
        record.kind !== 'action-receipt' ||
        record.payload.action !== 'assess-spec' ||
        record.payload.phase !== 'result'
      )
        continue
      if (!sameRef(record.payload.mandate, mandateRef) || applied.has(record.recordId)) continue
      if (record.payload.exactInputs.acceptedDigest !== digest) continue
      const parsed = specAssessmentSchema.safeParse(record.payload.structured)
      if (!parsed.success) return specChainFailure('incomplete', 'Applicable spec assessment is malformed')
      if (parsed.data.classification === 'unknown')
        return specChainFailure('ambiguous', 'Applicable spec assessment is unknown')
      if (parsed.data.classification !== 'editorial') {
        materialClaims += 1
        continue
      }
      const authenticated = authenticatedAssessResult(record, histories, mandateRef)
      if (!authenticated.ok) return authenticated
      const inputs = authenticated.record.payload.exactInputs
      if (
        inputs.acceptedBody !== body ||
        inputs.acceptedDigest !== digest ||
        specDigest(inputs.acceptedBody) !== inputs.acceptedDigest ||
        specDigest(inputs.currentBody) !== inputs.currentDigest
      )
        return specChainFailure('material-spec', 'Editorial assessment does not continue the accepted spec')
      editorials.push(authenticated.record)
    }
    if (editorials.length > 1)
      return specChainFailure('ambiguous', 'Competing editorial successors continue the same accepted spec')
    if (editorials.length > 0 && materialClaims > 0)
      return specChainFailure('ambiguous', 'Editorial and material assessments both continue the accepted spec')
    const materials = recordsOf(home).filter(
      (record): record is ControlRecord =>
        record.kind === 'operator-control' &&
        record.payload.control === 'accept-material' &&
        sameRef(record.payload.mandate, mandateRef) &&
        !applied.has(record.recordId) &&
        record.payload.predecessor.recordId === head &&
        equalScope(record.payload.predecessor.scope, scope),
    )
    if (materials.length > 1)
      return specChainFailure('ambiguous', 'Competing material acceptances continue the same accepted spec')
    if (editorials.length === 1 && materials.length === 1)
      return specChainFailure('ambiguous', 'Editorial and material successors both continue the accepted spec')
    const editorial = editorials[0]
    if (editorial !== undefined) {
      const inputs = editorial.payload.exactInputs
      body = inputs.currentBody
      digest = inputs.currentDigest
      head = editorial.recordId
      applied.add(editorial.recordId)
      chain.push({
        kind: 'editorial',
        recordId: editorial.recordId,
        scope,
        acceptedDigest: inputs.acceptedDigest,
        currentDigest: digest,
      })
      sourceRefs.push(receiptRef(editorial))
      continue
    }
    const material = materials[0]
    if (material === undefined || material.payload.control !== 'accept-material') break
    const assessmentHistory = historyFor(material.payload.assessment.scope, histories)
    if (assessmentHistory === null) return specChainFailure('missing-history', 'Spec assessment history is missing')
    const assessmentProblem = workflowOperationProblem(assessmentHistory)
    if (assessmentProblem === 'ambiguous') return specChainFailure('ambiguous', 'Spec assessment history conflicts')
    if (assessmentProblem === 'unconfirmed' || assessmentProblem === 'incomplete')
      return specChainFailure('incomplete', 'Spec assessment history is not confirmed', assessmentProblem)
    const bound = bindExternalRef(material.payload.assessment, assessmentHistory)
    if (!bound.ok) {
      const code = bound.diagnostics[0]?.code
      const reason =
        code === 'conflict' || code === 'ambiguous'
          ? 'ambiguous'
          : code === 'missing-history'
            ? 'missing-history'
            : 'incomplete'
      return { ok: false, reason, evidence: bound.diagnostics }
    }
    const authenticated = authenticatedAssessResult(bound.value, histories, mandateRef)
    if (!authenticated.ok) return authenticated
    const parsed = specAssessmentSchema.safeParse(authenticated.record.payload.structured)
    if (!parsed.success) return specChainFailure('incomplete', 'Applicable spec assessment is malformed')
    if (parsed.data.classification === 'unknown')
      return specChainFailure('ambiguous', 'Applicable spec assessment is unknown')
    const assessed = authenticated.record.payload.exactInputs
    if (assessed.acceptedBody !== body || assessed.acceptedDigest !== digest)
      return specChainFailure('material-spec', 'Material assessment does not continue the accepted spec')
    if (
      assessed.currentDigest !== material.payload.specDigest ||
      specDigest(assessed.currentBody) !== material.payload.specDigest
    )
      return specChainFailure('material-spec', 'Accepted material spec does not match its assessment')
    body = assessed.currentBody
    digest = assessed.currentDigest
    head = material.recordId
    applied.add(material.recordId)
    chain.push({
      kind: 'accept-material',
      recordId: material.recordId,
      scope,
      specDigest: digest,
      assessment: material.payload.assessment,
    })
    sourceRefs.push(receiptRef(material), material.payload.assessment)
  }
  return {
    ok: true,
    spec: {
      reference: confirmed.payload.spec.reference,
      body,
      digest,
      lastEditedAt: confirmed.payload.spec.lastEditedAt,
      chain,
      sourceRefs,
    },
  }
}

function configIdentityOf(
  mandate: MandateRecord,
): { ok: true; identity: ConfigIdentity } | { ok: false; evidence: Diagnostic[] } {
  const effective = mandate.payload.config.effective
  const raw =
    effective !== null && typeof effective === 'object' && !Array.isArray(effective)
      ? Reflect.get(effective, 'additionalRequirements')
      : undefined
  const additionalRequirements: string[] = []
  if (raw !== undefined) {
    if (!Array.isArray(raw))
      return { ok: false, evidence: [diagnostic('malformed', 'Mandate additional requirements are malformed')] }
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0)
        return { ok: false, evidence: [diagnostic('malformed', 'Mandate additional requirements are malformed')] }
      additionalRequirements.push(item)
    }
  }
  return {
    ok: true,
    identity: {
      productVersion: mandate.payload.config.productVersion,
      version: mandate.payload.config.version,
      digest: mandate.payload.config.digest,
      additionalRequirements,
      serialized: JSON.stringify({
        productVersion: mandate.payload.config.productVersion,
        version: mandate.payload.config.version,
        digest: mandate.payload.config.digest,
        additionalRequirements,
      }),
    },
  }
}

export function resolveBoundWork(input: {
  use: MandateUse
  explicitSelection: boolean
  pullRequest: Scope
  histories: readonly DecodedHistory[]
  native: { branch: string; base: string }
  currentSpec?: { body: string; digest: string } | null
}): BoundWork {
  const binding = selectWorkflowBinding(input)
  if (binding.status === 'absent') {
    if (input.use === 'landing' || !input.explicitSelection)
      return {
        status: 'refused',
        reason: 'missing',
        evidence: [diagnostic('mandate-absent', 'No workflow binding exists and selection was not explicit')],
      }
    return { status: 'standalone', binding: 'absent' }
  }
  if (binding.status !== 'bound')
    return {
      status: 'refused',
      reason: binding.status === 'incomplete' ? 'incomplete' : 'ambiguous',
      evidence: binding.diagnostics,
    }
  const mandateHistory = historyFor(mandateScope(binding.mandateRecord), input.histories)
  if (mandateHistory === null)
    return {
      status: 'refused',
      reason: 'missing-history',
      evidence: [diagnostic('missing-history', 'Bound mandate history is missing')],
    }
  const selected = selectApplicableMandate(mandateHistory, input.histories)
  if (selected.status === 'refused') return { status: 'refused', reason: selected.reason, evidence: selected.evidence }
  if (selected.mandate.recordId !== binding.mandateRecord.recordId)
    return {
      status: 'refused',
      reason: 'ambiguous',
      evidence: [diagnostic('ambiguous', 'Bound mandate is not the active mandate')],
    }
  const outstandingPause = outstandingPauseInAuthority(selected.mandate, input.histories)
  if (outstandingPause !== null) return { status: 'refused', reason: 'unconfirmed', evidence: [outstandingPause] }
  const permissions = {
    landing: selected.mandate.payload.permissions.landing && selected.mandate.payload.role !== 'fix-only',
    correct: selected.mandate.payload.permissions.correct,
  }
  if (input.use === 'landing' && !permissions.landing)
    return { status: 'refused', reason: 'fix-only', evidence: [diagnostic('fix-only', 'Fix-only mandate cannot land')] }
  if (input.use === 'correction' && !permissions.correct)
    return {
      status: 'refused',
      reason: 'incompatible',
      evidence: [diagnostic('incompatible', 'Mandate does not permit correction')],
    }
  const accepted = resolveAcceptedSpec(selected.mandate, input.histories)
  if (!accepted.ok) return { status: 'refused', reason: accepted.reason, evidence: accepted.evidence }
  const identity = configIdentityOf(selected.mandate)
  if (!identity.ok) return { status: 'refused', reason: 'incomplete', evidence: identity.evidence }
  const scope = mandateScope(selected.mandate)
  if (input.currentSpec == null) {
    return {
      status: 'applicable',
      binding: 'bound',
      mandate: selected.mandate,
      scope,
      permissions,
      acceptedSpec: accepted.spec,
      configIdentity: identity.identity,
      drift: null,
    }
  }
  if (specDigest(input.currentSpec.body) !== input.currentSpec.digest)
    return {
      status: 'refused',
      reason: 'material-spec',
      evidence: [diagnostic('material-spec', 'Current spec digest does not match its body')],
    }
  return {
    status: 'applicable',
    binding: 'bound',
    mandate: selected.mandate,
    scope,
    permissions,
    acceptedSpec: accepted.spec,
    configIdentity: identity.identity,
    drift: input.currentSpec.digest === accepted.spec.digest ? 'settled' : 'differs',
  }
}

export function validateWorkflowGraph(graph: unknown): Result<WorkflowGraph> {
  const parsed = workflowGraphSchema.safeParse(graph)
  if (!parsed.success)
    return fail([
      diagnostic(
        'unsupported-graph',
        'Workflow graph is not in the closed schema',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      ),
    ])
  const ids = parsed.data.nodes.map((node) => node.id)
  if (new Set(ids).size !== ids.length)
    return fail([diagnostic('unsupported-graph', 'Workflow graph repeats a node id')])
  if (!ids.includes(parsed.data.initial))
    return fail([diagnostic('unsupported-graph', 'Workflow graph initial node is missing')])
  const seenEdges = new Set<string>()
  for (const edge of parsed.data.edges) {
    if (!ids.includes(edge.from) || !ids.includes(edge.to))
      return fail([diagnostic('unsupported-graph', 'Workflow graph edge names a missing node')])
    if (edge.from === edge.to) return fail([diagnostic('unsupported-graph', 'Workflow graph edge loops on one node')])
    const key = `${edge.from}\0${edge.to}\0${edge.when}`
    if (seenEdges.has(key)) return fail([diagnostic('unsupported-graph', 'Workflow graph repeats an edge')])
    seenEdges.add(key)
  }
  return { ok: true, value: parsed.data }
}

function executableGraph(mandate: MandateRecord): Result<WorkflowGraph> {
  const effective = mandate.payload.config.effective
  if (typeof effective !== 'object' || effective === null || Array.isArray(effective))
    return fail([diagnostic('unsupported-graph', 'Mandate effective config has no graph')])
  const parsed = validateWorkflowGraph(Reflect.get(effective, 'graph'))
  if (!parsed.ok) return parsed
  if (parsed.value.productVersion !== mandate.payload.config.productVersion)
    return fail([diagnostic('config-drift', 'Mandate graph product version differs from the mandate')])
  if (parsed.value.configVersion !== mandate.payload.config.version)
    return fail([diagnostic('config-drift', 'Mandate graph config version differs from the mandate')])
  return parsed
}

export function selectApplicableMandate(
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[] = [],
  seen: ReadonlySet<string> = new Set(),
): MandateSelection {
  const scopeKey = `${history.source.scope.repository}\0${history.source.scope.target}`
  if (seen.has(scopeKey)) return refused('ambiguous', [diagnostic('ambiguous', 'Mandate parent chain cycles')])
  const nextSeen = new Set(seen)
  nextSeen.add(scopeKey)
  const problem = workflowOperationProblem(history)
  if (problem !== null && mandatesOf(history).length === 0 && problem === 'incomplete')
    return refused('incomplete', [diagnostic('incomplete', 'History pagination is incomplete')])
  if (problem === 'ambiguous') return refused('ambiguous', [diagnostic('ambiguous', 'Workflow history conflicts')])
  if (problem === 'unconfirmed')
    return refused('unconfirmed', [diagnostic('unconfirmed', 'Workflow history has an incomplete operation')])
  if (problem === 'incomplete')
    return refused('incomplete', [diagnostic('incomplete', 'History pagination is incomplete')])
  const mandates = mandatesOf(history)
  if (mandates.length === 0) {
    const claimed = history.operations.some(
      (operation) => operation.kind === 'mandate' || operation.claimedKinds.includes('mandate'),
    )
    return claimed
      ? refused('unconfirmed', [diagnostic('unconfirmed', 'A mandate was claimed but not confirmed')])
      : refused('missing', [diagnostic('missing', 'No mandate record exists')])
  }
  const active = mandates.filter((mandate) => !abandoned(history, mandate) && successorOf(history, mandate) === null)
  if (active.length === 0) {
    const last = mandates[mandates.length - 1]
    if (last !== undefined && abandoned(history, last))
      return refused('abandoned', [diagnostic('abandoned', `Mandate ${last.recordId} is abandoned`)])
    return refused('revoked', [diagnostic('revoked', 'The mandate was superseded')])
  }
  if (active.length > 1) return refused('ambiguous', [diagnostic('ambiguous', 'More than one mandate is active')])
  const mandate = active[0]
  if (mandate === undefined) return refused('missing', [diagnostic('missing', 'No mandate record exists')])
  if (abandoned(history, mandate))
    return refused('abandoned', [diagnostic('abandoned', `Mandate ${mandate.recordId} is abandoned`)])
  const pause = unliftedPause(history, mandate)
  if (pause !== null)
    return {
      status: 'refused',
      reason: 'paused',
      evidence: [diagnostic('paused', `Mandate ${mandate.recordId} is paused`)],
      pause: {
        mandate: { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' },
        confirmation: {
          scope: { repository: pause.repository, target: pause.target },
          recordId: pause.recordId,
          kind: 'operator-control',
        },
      },
    }
  const graph = executableGraph(mandate)
  if (!graph.ok) return refused('unsupported', graph.diagnostics)
  const omission = epicParentProblem(mandate, [history, ...externalHistories])
  if (omission !== null) return refused(omission.reason, omission.evidence)
  if (mandate.payload.parent !== null) {
    const parentHistory = historyFor(mandate.payload.parent.scope, externalHistories)
    if (parentHistory === null)
      return refused('incomplete', [diagnostic('missing-history', 'Parent mandate history is missing')])
    const parent = bindExternalRef(mandate.payload.parent, parentHistory)
    if (!parent.ok) return refused('incomplete', parent.diagnostics)
    if (parent.value.kind !== 'mandate')
      return refused('unknown-binding', [diagnostic('kind-mismatch', 'Parent reference is not a mandate')])
    const parentSelection = selectApplicableMandate(parentHistory, externalHistories, nextSeen)
    if (parentSelection.status === 'refused') return parentSelection
    if (
      !sameRef(
        { scope: mandateScope(parentSelection.mandate), recordId: parentSelection.mandate.recordId, kind: 'mandate' },
        mandate.payload.parent,
      )
    )
      return refused('revoked', [
        diagnostic('revoked', 'Child parent reference does not name the active parent mandate'),
      ])
    if (
      parent.value.payload.role === 'epic' &&
      !childPermitted(parent.value, mandateScope(mandate), [parentHistory, history, ...externalHistories])
    )
      return refused('unknown-binding', [diagnostic('unknown-binding', 'Child scope is not approved')])
    if (mandate.payload.permissions.landing && !parent.value.payload.permissions.landing)
      return refused('incompatible', [diagnostic('incompatible', 'Child landing exceeds the parent')])
    if (mandate.payload.permissions.correct && !parent.value.payload.permissions.correct)
      return refused('incompatible', [diagnostic('incompatible', 'Child correction exceeds the parent')])
    if (parent.value.payload.role === 'epic') {
      const approved = parent.value.payload.children.find((child) => equalScope(child.scope, mandateScope(mandate)))
      if (approved !== undefined && mandate.payload.spec.bodySha256 !== approved.specDigest)
        return refused('materially-changed', [
          diagnostic('materially-changed', 'Child spec digest differs from the approved snapshot'),
        ])
    }
  }
  return { status: 'applicable', mandate }
}

export function assessFixMandate(input: {
  target: { scope: Scope; kind: 'issue' | 'pull-request'; branch: string | null; base: string | null }
  linkedIssueScopes: readonly Scope[]
  history: DecodedHistory
  linkedIssueHistory: DecodedHistory | null
  externalHistories?: readonly DecodedHistory[]
  /** When set, only a non-change bound to this digest is unsafe. Omitted keeps any historical non-change unsafe. */
  evidenceDigest?: string | null
}): FixMandateAssessment {
  const extra = input.externalHistories ?? []
  if (input.target.kind === 'pull-request') {
    if (input.target.branch === null || input.target.base === null) {
      return refused('unknown-binding', [diagnostic('unknown-binding', 'Pull request branch or base was not supplied')])
    }
    const histories = [
      input.history,
      ...(input.linkedIssueHistory === null ? [] : [input.linkedIssueHistory]),
      ...extra,
    ]
    const selected = selectWorkflowBinding({
      pullRequest: input.target.scope,
      histories,
      native: { branch: input.target.branch, base: input.target.base },
    })
    if (selected.status === 'bound') {
      const home = historyFor(selected.mandate.scope, histories)
      if (home === null)
        return refused('incomplete', [diagnostic('missing-history', 'Bound mandate history is missing')])
      const applicable = selectApplicableMandate(
        home,
        histories.filter((item) => item !== home),
      )
      if (applicable.status === 'refused') return applicable
      if (!applicable.mandate.payload.permissions.correct)
        return refused('incompatible', [diagnostic('incompatible', 'Mandate does not permit correction')])
      const outstandingPause = outstandingPauseInAuthority(applicable.mandate, histories)
      if (outstandingPause !== null) return refused('unconfirmed', [outstandingPause])
      if (ciAttributionUnsafe(input.history, input.evidenceDigest))
        return refused('unsafe', [diagnostic('unsafe', 'CI attribution is not the change')])
      return { status: 'applicable', mandate: applicable.mandate, execution: { correct: true, landing: false } }
    }
    if (selected.status === 'absent') {
      const local = selectApplicableMandate(input.history, extra)
      if (local.status === 'refused') return local
      if (local.mandate.payload.role !== 'fix-only' || !equalScope(mandateScope(local.mandate), input.target.scope)) {
        return refused('unknown-binding', [
          diagnostic(
            'unknown-binding',
            'A pull request without a binding can only correct an explicit fix-only mandate',
          ),
        ])
      }
      const outstandingPause = outstandingPauseInAuthority(local.mandate, [input.history, ...extra])
      if (outstandingPause !== null) return refused('unconfirmed', [outstandingPause])
      if (ciAttributionUnsafe(input.history, input.evidenceDigest))
        return refused('unsafe', [diagnostic('unsafe', 'CI attribution is not the change')])
      return { status: 'applicable', mandate: local.mandate, execution: { correct: true, landing: false } }
    }
    return refused(selected.status === 'conflicting' ? 'ambiguous' : 'incomplete', selected.diagnostics)
  }
  const histories = input.linkedIssueHistory === null ? extra : [input.linkedIssueHistory, ...extra]
  const selected = selectApplicableMandate(input.history, histories)
  if (selected.status === 'refused') return selected
  const mandate = selected.mandate
  const outstandingPause = outstandingPauseInAuthority(mandate, [input.history, ...histories])
  if (outstandingPause !== null) return refused('unconfirmed', [outstandingPause])
  if (
    !equalScope(mandateScope(mandate), input.target.scope) &&
    !input.linkedIssueScopes.some((scope) => equalScope(scope, mandateScope(mandate)))
  )
    return refused('unknown-binding', [diagnostic('unknown-binding', 'Mandate scope is not the fix target')])
  if (!mandate.payload.permissions.correct)
    return refused('incompatible', [diagnostic('incompatible', 'Mandate does not permit correction')])
  if (ciAttributionUnsafe(input.history, input.evidenceDigest))
    return refused('unsafe', [diagnostic('unsafe', 'CI attribution is not the change')])
  return { status: 'applicable', mandate, execution: { correct: true, landing: false } }
}

function ciAttributionUnsafe(history: DecodedHistory, evidenceDigest?: string | null): boolean {
  return recordsOf(history).some((record) => {
    if (
      record.kind !== 'action-receipt' ||
      record.payload.action !== 'attribute-ci' ||
      record.payload.phase !== 'result'
    )
      return false
    if (evidenceDigest != null && record.payload.exactInputs.evidenceDigest !== evidenceDigest) return false
    const parsed = ciAttributionSchema.safeParse(record.payload.structured)
    return parsed.success && parsed.data.attribution !== 'change'
  })
}

export function buildFixOnlyMandate(draft: {
  scope: Scope
  recordId: string
  runId: string
  operationId: string
  branch: string | null
  base: string
  lineageHead: string | null
  productVersion: string
  work: { reference: string; body: string; lastEditedAt: string }
  config: { version: string; digest: string; effective: Json }
  proofPins: ProofConfigPin[]
  parent: ExternalRecordRef | null
  antecedent: ExternalRecordRef | null
}): Result<MandateRecord> {
  return buildRecord({
    kind: 'mandate',
    version: 1,
    repository: draft.scope.repository,
    target: draft.scope.target,
    recordId: draft.recordId,
    runId: draft.runId,
    operationId: draft.operationId,
    payload: {
      role: 'fix-only',
      branch: draft.branch,
      base: draft.base,
      lineageHead: draft.lineageHead,
      run: null,
      children: null,
      permissions: { landing: false, correct: true },
      config: {
        productVersion: draft.productVersion,
        version: draft.config.version,
        digest: draft.config.digest,
        effective: draft.config.effective,
      },
      proofPins: draft.proofPins,
      parent: draft.parent,
      antecedent: draft.antecedent,
      spec: {
        reference: draft.work.reference,
        body: draft.work.body,
        bodySha256: specDigest(draft.work.body),
        lastEditedAt: draft.work.lastEditedAt,
      },
    },
  })
}

function bindingRefusal(status: 'incomplete' | 'conflicting', diagnostics: Diagnostic[]): WorkflowBindingSelection {
  return { status, diagnostics }
}

function refKey(ref: ExternalRecordRef): string {
  return `${ref.kind}\0${ref.scope.repository}\0${ref.scope.target}\0${ref.recordId}`
}

function claimsBinding(operation: DecodedHistory['operations'][number]): boolean {
  return (
    operation.kind === 'workflow-binding' ||
    operation.claimedKinds.includes('workflow-binding') ||
    operation.record?.kind === 'workflow-binding'
  )
}

function confirmedAccountedMandate(history: DecodedHistory, ref: ExternalRecordRef): MandateRecord | null {
  const matches = history.operations.filter(
    (operation) =>
      operation.status === 'complete' &&
      operation.authority === 'accounted' &&
      operation.record?.kind === 'mandate' &&
      operation.record.recordId === ref.recordId &&
      equalScope({ repository: operation.record.repository, target: operation.record.target }, ref.scope),
  )
  const bodies = matches.map((operation) => JSON.stringify(operation.record))
  if (matches.length === 0 || new Set(bodies).size !== 1) return null
  const record = matches[0]?.record
  return record?.kind === 'mandate' ? record : null
}

function successorClaim(
  history: DecodedHistory,
  mandate: ExternalRecordRef,
):
  | { status: 'none' }
  | { status: 'incomplete' | 'conflicting'; diagnostics: Diagnostic[] }
  | { status: 'next'; ref: ExternalRecordRef } {
  const controls = history.operations.filter(
    (operation) =>
      operation.record?.kind === 'operator-control' &&
      operation.record.payload.control === 'select-successor' &&
      sameRef(operation.record.payload.predecessor, mandate),
  )
  if (controls.length === 0) return { status: 'none' }
  if (
    controls.some(
      (operation) =>
        operation.status !== 'complete' || operation.authority !== 'accounted' || operation.record === null,
    )
  ) {
    return {
      status: 'incomplete',
      diagnostics: [diagnostic('unconfirmed', 'A select-successor claim does not confirm an authorized binding chain')],
    }
  }
  const refs = controls.flatMap((operation) =>
    operation.record?.kind === 'operator-control' && operation.record.payload.control === 'select-successor'
      ? [operation.record.payload.successor]
      : [],
  )
  const first = refs[0]
  if (first === undefined || first.kind !== 'mandate' || refs.some((ref) => !sameRef(ref, first))) {
    return {
      status: 'conflicting',
      diagnostics: [diagnostic('conflicting', 'Select-successor controls do not name one mandate')],
    }
  }
  return { status: 'next', ref: first }
}

function resolveBindingChain(
  bindings: WorkflowBindingRecord[],
  histories: readonly DecodedHistory[],
): WorkflowBindingSelection | { status: 'bound'; binding: WorkflowBindingRecord } {
  const byMandate = new Map<string, WorkflowBindingRecord>()
  for (const binding of bindings) {
    const key = refKey(binding.payload.mandate)
    const prior = byMandate.get(key)
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(binding)) {
      return bindingRefusal('conflicting', [
        diagnostic('conflicting', 'Multiple workflow bindings name the same mandate'),
      ])
    }
    byMandate.set(key, binding)
  }
  const unique = [...byMandate.values()]
  const next = new Map<string, string>()
  for (const binding of unique) {
    const home = historyFor(binding.payload.mandate.scope, histories)
    if (home === null || !home.source.complete) {
      return bindingRefusal('incomplete', [
        diagnostic('incomplete', 'Binding mandate history is missing or incomplete'),
      ])
    }
    const successor = successorClaim(home, binding.payload.mandate)
    if (successor.status === 'incomplete' || successor.status === 'conflicting') return successor
    if (successor.status === 'next') {
      const key = refKey(successor.ref)
      if (!byMandate.has(key)) {
        return bindingRefusal('incomplete', [
          diagnostic('unconfirmed', 'Authorized successor has no workflow-binding on this PR'),
        ])
      }
      next.set(refKey(binding.payload.mandate), key)
    }
  }
  const heads = unique.filter((binding) => !next.has(refKey(binding.payload.mandate)))
  if (heads.length !== 1) {
    return bindingRefusal('conflicting', [
      diagnostic('conflicting', 'Workflow bindings do not form one authorized chain'),
    ])
  }
  const head = heads[0]
  if (head === undefined) {
    return bindingRefusal('conflicting', [
      diagnostic('conflicting', 'Workflow bindings do not form one authorized chain'),
    ])
  }
  const headKey = refKey(head.payload.mandate)
  for (const binding of unique) {
    let cursor = refKey(binding.payload.mandate)
    const seen = new Set<string>()
    while (cursor !== headKey) {
      if (seen.has(cursor)) {
        return bindingRefusal('conflicting', [diagnostic('conflicting', 'Workflow binding successor chain cycles')])
      }
      seen.add(cursor)
      const step = next.get(cursor)
      if (step === undefined) {
        return bindingRefusal('conflicting', [
          diagnostic('conflicting', 'Workflow binding is outside the authorized chain'),
        ])
      }
      cursor = step
    }
  }
  return { status: 'bound', binding: head }
}

export type WorkflowBindingSelection =
  | {
      status: 'bound'
      binding: WorkflowBindingRecord
      mandate: ExternalRecordRef
      mandateRecord: MandateRecord
    }
  | { status: 'absent' }
  | { status: 'incomplete' | 'conflicting'; diagnostics: Diagnostic[] }

export function selectWorkflowBinding(input: {
  pullRequest: Scope
  histories: readonly DecodedHistory[]
  native: { branch: string; base: string }
}): WorkflowBindingSelection {
  const history = historyFor(input.pullRequest, input.histories)
  if (history === null) {
    return bindingRefusal('incomplete', [diagnostic('missing-history', 'Pull request history is missing')])
  }
  if (!history.source.complete) {
    return bindingRefusal('incomplete', [diagnostic('incomplete', 'Pull request history is incomplete')])
  }
  const claims = history.operations.filter(claimsBinding)
  if (claims.length === 0) return { status: 'absent' }
  if (claims.some((operation) => operation.authority === 'foreign')) {
    return bindingRefusal('conflicting', [diagnostic('foreign', 'A foreign workflow-binding is not an absent mandate')])
  }
  if (claims.some((operation) => operation.status === 'conflict')) {
    return bindingRefusal('conflicting', [diagnostic('conflicting', 'Workflow-binding parts conflict')])
  }
  if (
    claims.some(
      (operation) =>
        operation.status !== 'complete' || operation.authority !== 'accounted' || operation.record === null,
    )
  ) {
    return bindingRefusal('incomplete', [
      diagnostic('incomplete', 'A workflow-binding claim is not a complete accounted record'),
    ])
  }
  const records: WorkflowBindingRecord[] = []
  for (const operation of claims) {
    const record = operation.record
    if (record === null || record.kind !== 'workflow-binding') {
      return bindingRefusal('conflicting', [diagnostic('malformed', 'Workflow-binding claim has no binding record')])
    }
    if (!equalScope({ repository: record.repository, target: record.target }, input.pullRequest)) {
      return bindingRefusal('conflicting', [
        diagnostic('unknown-binding', 'Workflow-binding scope is not the pull request'),
      ])
    }
    if (record.payload.mandate.kind !== 'mandate') {
      return bindingRefusal('conflicting', [diagnostic('kind-mismatch', 'Workflow binding must name a mandate')])
    }
    if (record.payload.branch !== input.native.branch || record.payload.base !== input.native.base) {
      return bindingRefusal('conflicting', [
        diagnostic('native-mismatch', 'Workflow-binding branch or base does not match the PR'),
      ])
    }
    const prior = records.find((item) => item.recordId === record.recordId)
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(record)) {
      return bindingRefusal('conflicting', [diagnostic('conflicting', 'Workflow binding has incompatible duplicates')])
    }
    if (prior === undefined) records.push(record)
  }
  const chained = resolveBindingChain(records, input.histories)
  if (chained.status !== 'bound') return chained
  const home = historyFor(chained.binding.payload.mandate.scope, input.histories)
  if (home === null || !home.source.complete) {
    return bindingRefusal('incomplete', [diagnostic('incomplete', 'Binding mandate history is missing or incomplete')])
  }
  const mandateRecord = confirmedAccountedMandate(home, chained.binding.payload.mandate)
  if (mandateRecord === null) {
    return bindingRefusal('incomplete', [diagnostic('incomplete', 'Binding mandate record is not confirmed')])
  }
  return {
    status: 'bound',
    binding: chained.binding,
    mandate: chained.binding.payload.mandate,
    mandateRecord,
  }
}

function epicListings(mandate: MandateRecord, histories: readonly DecodedHistory[]): ExternalRecordRef[] {
  const scope = mandateScope(mandate)
  const refs: ExternalRecordRef[] = []
  for (const history of histories) {
    for (const record of mandatesOf(history)) {
      if (record.payload.role !== 'epic') continue
      if (!record.payload.children.some((child) => equalScope(child.scope, scope))) continue
      refs.push({ scope: mandateScope(record), recordId: record.recordId, kind: 'mandate' })
    }
  }
  return refs
}

function epicParentProblem(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
): { reason: 'ambiguous' | 'missing' | 'incompatible'; evidence: Diagnostic[] } | null {
  const listings = epicListings(mandate, histories)
  if (listings.length > 1) {
    return { reason: 'ambiguous', evidence: [diagnostic('ambiguous', 'More than one epic lists this child')] }
  }
  const listing = listings[0]
  if (listing === undefined) return null
  if (mandate.payload.parent === null) {
    return { reason: 'missing', evidence: [diagnostic('missing', 'Epic-created child omitted its parent')] }
  }
  if (!sameRef(mandate.payload.parent, listing)) {
    return {
      reason: 'incompatible',
      evidence: [diagnostic('incompatible', 'Epic child parent ref does not name the listing epic')],
    }
  }
  return null
}

function incompleteListedParent(
  scopes: readonly Scope[],
  histories: readonly DecodedHistory[],
): LandingMandateDecision | null {
  for (const scope of scopes) {
    const history = historyFor(scope, histories)
    if (history === null) continue
    if (!history.source.complete) {
      return landingRefusal('incomplete', [diagnostic('incomplete', 'A listed parent history is incomplete')])
    }
  }
  return null
}

function landingBindingReason(
  selection: Exclude<WorkflowBindingSelection, { status: 'bound' | 'absent' }>,
): LandingRefusal {
  if (selection.status === 'conflicting') return 'conflict'
  if (selection.status === 'incomplete') return 'incomplete'
  return 'unknown-binding'
}
function landingRefusal(reason: LandingRefusal, evidence: Diagnostic[]): LandingMandateDecision {
  return { ok: false, reason, evidence }
}
function landingReason(reason: MandateRefusal): LandingRefusal {
  switch (reason) {
    case 'config-invalid':
      return 'unsupported'
    case 'missing':
    case 'paused':
    case 'abandoned':
    case 'revoked':
    case 'unsupported':
    case 'ambiguous':
    case 'incomplete':
    case 'unconfirmed':
    case 'unknown-binding':
    case 'incompatible':
    case 'unsafe':
    case 'materially-changed':
    case 'missing-history':
      return reason
  }
}
function landingBindingRefusal(
  selection: Exclude<WorkflowBindingSelection, { status: 'bound' | 'absent' }>,
): LandingMandateDecision {
  return landingRefusal(landingBindingReason(selection), selection.diagnostics)
}
function pinIdentity(pin: ProofConfigPin): string {
  return `${pin.path}\0${pin.blob ?? 'absent'}`
}

/** sourceCommit is recoverability provenance. Identity is path plus approved blob or absence, independent of order. */
function samePins(approved: readonly ProofConfigPin[], current: readonly ProofConfigPin[]): boolean {
  const identity = (pins: readonly ProofConfigPin[]): string[] => [...new Set(pins.map(pinIdentity))].sort()
  const left = identity(approved)
  const right = identity(current)
  return left.length === right.length && left.every((key, index) => key === right[index])
}

export function requireLandingMandate(input: {
  histories: readonly DecodedHistory[]
  native: { branch: string; base: string; pullRequest: Scope; linkedIssueScopes: readonly Scope[] }
  parentScopes: readonly Scope[]
  current: {
    productVersion: string
    configVersion: string
    configDigest: string
    supportedConfigVersions: readonly string[]
    proofPins: readonly ProofConfigPin[]
    specDigest: string | null
    specBody: string | null
  }
  localInhibit: 'pause' | 'abandon' | null
}): LandingMandateDecision {
  void input.native.linkedIssueScopes
  const listed = incompleteListedParent(input.parentScopes, input.histories)
  if (listed !== null) return listed
  const selected = selectWorkflowBinding({
    pullRequest: input.native.pullRequest,
    histories: input.histories,
    native: { branch: input.native.branch, base: input.native.base },
  })
  if (selected.status === 'absent') {
    return landingRefusal('missing', [diagnostic('missing', 'No workflow binding exists on the pull request')])
  }
  if (selected.status !== 'bound') return landingBindingRefusal(selected)
  const mandate = selected.mandateRecord
  const home = historyFor(mandateScope(mandate), input.histories)
  if (home === null)
    return landingRefusal('missing-history', [diagnostic('missing-history', 'Mandate history is missing')])
  const omission = epicParentProblem(mandate, input.histories)
  if (omission !== null) return landingRefusal(landingReason(omission.reason), omission.evidence)
  if (input.localInhibit !== null && confirmedPause(home, mandate) === null && !abandoned(home, mandate))
    return landingRefusal('unconfirmed', [diagnostic('unconfirmed', 'Local inhibit has no confirmed control record')])
  if (mandate.payload.role === 'fix-only' || mandate.payload.permissions.landing === false)
    return landingRefusal('fix-only', [diagnostic('fix-only', 'Fix-only mandate cannot land')])
  if (abandoned(home, mandate))
    return landingRefusal('abandoned', [diagnostic('abandoned', `Mandate ${mandate.recordId} is abandoned`)])
  if (successorOf(home, mandate) !== null)
    return landingRefusal('revoked', [diagnostic('revoked', `Mandate ${mandate.recordId} was superseded`)])
  if (unliftedPause(home, mandate) !== null)
    return landingRefusal('paused', [diagnostic('paused', `Mandate ${mandate.recordId} is paused`)])
  if (mandate.payload.branch === null || mandate.payload.branch !== input.native.branch)
    return landingRefusal('unknown-binding', [diagnostic('unknown-binding', 'Mandate branch does not match')])
  if (mandate.payload.base !== input.native.base)
    return landingRefusal('unknown-binding', [diagnostic('unknown-binding', 'Mandate base does not match')])
  if (mandate.payload.parent !== null) {
    const parentHistory = historyFor(mandate.payload.parent.scope, input.histories)
    if (parentHistory === null)
      return landingRefusal('missing-history', [diagnostic('missing-history', 'Parent mandate history is missing')])
    const parent = bindExternalRef(mandate.payload.parent, parentHistory)
    if (!parent.ok) return landingRefusal('incomplete', parent.diagnostics)
    if (parent.value.kind !== 'mandate')
      return landingRefusal('unknown-binding', [diagnostic('kind-mismatch', 'Parent reference is not a mandate')])
    const parentSelection = selectApplicableMandate(parentHistory, input.histories)
    if (parentSelection.status === 'refused') {
      return landingRefusal(landingReason(parentSelection.reason), parentSelection.evidence)
    }
    if (
      !sameRef(
        { scope: mandateScope(parentSelection.mandate), recordId: parentSelection.mandate.recordId, kind: 'mandate' },
        mandate.payload.parent,
      )
    )
      return landingRefusal('revoked', [
        diagnostic('revoked', 'Child parent reference does not name the active parent mandate'),
      ])
    if (mandate.payload.permissions.landing && !parent.value.payload.permissions.landing)
      return landingRefusal('incompatible', [diagnostic('incompatible', 'Child landing exceeds the parent')])
  }
  const outstandingPause = outstandingPauseInAuthority(mandate, input.histories)
  if (outstandingPause !== null) return landingRefusal('unconfirmed', [outstandingPause])
  if (
    input.current.supportedConfigVersions.length === 0 ||
    !input.current.supportedConfigVersions.includes(mandate.payload.config.version)
  )
    return landingRefusal('unsupported', [diagnostic('unsupported', 'Mandate config version is not supported')])
  if (mandate.payload.config.productVersion !== input.current.productVersion)
    return landingRefusal('config-drift', [
      diagnostic('config-drift', 'Mandate product version differs from the installed package'),
    ])
  if (
    mandate.payload.config.version !== input.current.configVersion ||
    mandate.payload.config.digest !== input.current.configDigest
  )
    return landingRefusal('config-drift', [
      diagnostic('config-drift', 'Mandate config digest differs from current config'),
    ])
  if (!samePins(mandate.payload.proofPins, input.current.proofPins))
    return landingRefusal('proof-pin-drift', [diagnostic('proof-pin-drift', 'Proof pins differ from the mandate')])
  if (input.current.specDigest === null || input.current.specBody === null)
    return landingRefusal('material-spec', [diagnostic('material-spec', 'Current spec body was not supplied')])
  if (specDigest(input.current.specBody) !== input.current.specDigest)
    return landingRefusal('material-spec', [diagnostic('material-spec', 'Current spec digest does not match its body')])
  const accepted = resolveAcceptedSpec(mandate, input.histories)
  if (!accepted.ok)
    return landingRefusal(
      accepted.reason === 'material-spec'
        ? 'material-spec'
        : accepted.reason === 'ambiguous'
          ? 'ambiguous'
          : accepted.reason === 'missing-history'
            ? 'missing-history'
            : 'incomplete',
      accepted.evidence,
    )
  if (input.current.specDigest !== accepted.spec.digest)
    return landingRefusal('materially-changed', [
      diagnostic('materially-changed', 'Live spec differs from the effective approved snapshot'),
    ])
  return {
    ok: true,
    recordId: mandate.recordId,
    scope: mandateScope(mandate),
    proofPins: mandate.payload.proofPins,
    mandate,
  }
}

function sessionEvidence(facts: WorkflowFacts): Diagnostic[] {
  const path = facts.preparedWorktree ?? ''
  return [
    diagnostic('session-cwd', 'Session cwd is not the prepared worktree', {
      path,
      instruction: `/move ${path}`,
    }),
  ]
}

function sessionReady(facts: WorkflowFacts): boolean {
  return facts.sessionCwd !== null && facts.preparedWorktree !== null && facts.sessionCwd === facts.preparedWorktree
}

function actionOf(record: ReceiptRecord): string {
  return record.payload.action
}

function receiptProgress(history: DecodedHistory, action: string): 'not-started' | 'confirmed' | 'uncertain' {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord => record.kind === 'action-receipt' && actionOf(record) === action,
  )
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record) => record.payload.phase === 'result')
  if (starts.length === 0 && results.length === 0) return 'not-started'
  if (starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId)))
    return 'uncertain'
  return results.length > 0 ? 'confirmed' : 'uncertain'
}

export type WorkflowEvidence = {
  issue: DecodedHistory
  pullRequest: DecodedHistory | null
  parents: readonly DecodedHistory[]
}
export type ActionCompletion = { status: 'not-started' | 'confirmed' | 'uncertain' | 'blocked'; evidence: Diagnostic[] }
export type PlanMacroPhase = 'needs-draft' | 'needs-review' | 'needs-amendment' | 'eligible' | 'blocked' | 'uncertain'
export type PlanMacro = {
  phase: PlanMacroPhase
  mandateId: string | null
  specDigest: string | null
  draftActionId: string | null
  reviewActionId: string | null
  amendmentActionId: string | null
  blockers: PlanBlockerRef[]
  evidence: Diagnostic[]
}

export function bindImplementationCommand(
  captures: readonly {
    toolCallId: string
    command: string
    exitCode: number
    cwd: string
    stdout?: string
    stderr?: string
  }[],
  claim: { toolCallId: string; command: string; exitCode: number; cwd: string },
): Result<z.infer<typeof implementationCommandSchema>> {
  const matches = captures.filter((capture) => capture.toolCallId === claim.toolCallId)
  const selected = matches[0]
  if (matches.length === 0 || selected === undefined)
    return fail([diagnostic('missing', 'implementation command was not captured')])
  if (matches.length > 1) return fail([diagnostic('ambiguous', 'implementation command id is repeated')])
  if (selected.command !== claim.command || selected.exitCode !== claim.exitCode || selected.cwd !== claim.cwd) {
    return fail([diagnostic('mismatch', 'implementation command text, exit, or cwd does not match the capture')])
  }
  return {
    ok: true,
    value: {
      toolCallId: selected.toolCallId,
      command: selected.command,
      exitCode: selected.exitCode,
    },
  }
}

function planResults(history: DecodedHistory): ReceiptRecord[] {
  return recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === 'plan' && record.payload.phase === 'result',
  )
}

function planReviews(history: DecodedHistory): ReceiptRecord[] {
  return recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === 'plan-review' && record.payload.phase === 'result',
  )
}

export function planMacro(evidence: WorkflowEvidence, mandate: MandateRecord | null): PlanMacro {
  let acceptedDigest: string | null = null
  const empty = (phase: PlanMacroPhase, evidenceItems: Diagnostic[], extra: Partial<PlanMacro> = {}): PlanMacro => ({
    phase,
    mandateId: mandate?.recordId ?? null,
    specDigest: acceptedDigest,
    draftActionId: null,
    reviewActionId: null,
    amendmentActionId: null,
    blockers: [],
    evidence: evidenceItems,
    ...extra,
  })
  if (mandate === null) return empty('blocked', [diagnostic('mandate-absent', 'plan macro has no mandate')])
  const history = evidence.issue
  const labelled = [
    evidence.issue,
    ...(evidence.pullRequest !== null ? [evidence.pullRequest] : []),
    ...evidence.parents,
  ]
  const accepted = resolveAcceptedSpec(mandate, labelled)
  if (!accepted.ok) return empty('blocked', accepted.evidence)
  acceptedDigest = accepted.spec.digest
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const starts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === 'plan' && record.payload.phase === 'start',
  )
  const results = planResults(history).filter(
    (record) =>
      record.payload.action === 'plan' &&
      sameRef(record.payload.mandate, mandateRef) &&
      record.payload.exactInputs.specDigest === acceptedDigest,
  )
  const open = starts.filter(
    (start) => !planResults(history).some((result) => result.payload.actionId === start.payload.actionId),
  )
  if (open.length > 0) return empty('uncertain', [diagnostic('action-uncertain', 'plan start has no result')])
  const reviewStarts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === 'plan-review' && record.payload.phase === 'start',
  )
  if (
    reviewStarts.some(
      (start) => !planReviews(history).some((result) => result.payload.actionId === start.payload.actionId),
    )
  ) {
    return empty('uncertain', [diagnostic('action-uncertain', 'plan review start has no result')])
  }
  const latest = results
    .filter((record) => record.payload.action === 'plan' && record.payload.exactInputs.amendsReviewActionId === null)
    .at(-1)
  if (latest === undefined || latest.payload.action !== 'plan' || latest.payload.phase !== 'result') {
    return empty('needs-draft', [diagnostic('needs-draft', 'no plan result is bound to the mandate spec')])
  }
  const parsedPlan = planOutputSchema.safeParse(latest.payload.structured)
  if (!parsedSuccess(parsedPlan)) return empty('blocked', [diagnostic('malformed', 'plan result is not a plan')])
  const draftDigest = planDigest(parsedPlan.data)
  const review = planReviews(history)
    .filter(
      (record) =>
        record.payload.action === 'plan-review' &&
        record.payload.phase === 'result' &&
        record.payload.exactInputs.planDigest === draftDigest &&
        record.payload.exactInputs.mandateId === mandate.recordId &&
        record.payload.exactInputs.draftActionId === latest.payload.actionId,
    )
    .at(-1)
  if (review === undefined || review.payload.action !== 'plan-review' || review.payload.phase !== 'result') {
    return empty('needs-review', [diagnostic('needs-review', 'plan has no matching review')], {
      draftActionId: latest.payload.actionId,
    })
  }
  const specialists = new Set(review.payload.slots.map((slot) => slot.specialist))
  if (PLAN_REVIEW_SPECIALISTS.some((name) => !specialists.has(name))) {
    return empty('blocked', [diagnostic('missing-contribution', 'plan review does not declare both specialists')])
  }
  const declaredSlots = new Set(review.payload.slots.map((slot) => slot.slotId))
  const coveredSlots = new Set<string>()
  for (const contribution of review.payload.contributions) {
    const parsed = planReviewSchema.safeParse(contribution.structured)
    if (!parsed.success || contribution.host.slotId === null || !declaredSlots.has(contribution.host.slotId)) {
      return empty('blocked', [diagnostic('missing-contribution', 'plan review contribution is not a review')], {
        draftActionId: latest.payload.actionId,
        reviewActionId: review.payload.actionId,
      })
    }
    coveredSlots.add(contribution.host.slotId)
  }
  if ([...declaredSlots].some((slotId) => !coveredSlots.has(slotId))) {
    return empty('blocked', [diagnostic('missing-contribution', 'plan review slot has no review')], {
      draftActionId: latest.payload.actionId,
      reviewActionId: review.payload.actionId,
    })
  }
  const refs: PlanBlockerRef[] = []
  for (const contribution of review.payload.contributions) {
    const parsed = planReviewSchema.safeParse(contribution.structured)
    if (!parsed.success || parsed.data.outcome !== 'blocking' || contribution.host.slotId === null) continue
    for (const blocker of parsed.data.blockers) {
      refs.push({
        sourceId: contribution.host.childId ?? contribution.host.slotId,
        slotId: contribution.host.slotId,
        blockerId: blocker.id,
      })
    }
  }
  const clear =
    review.payload.contributions.length > 0 &&
    review.payload.contributions.every((contribution) => {
      const parsed = planReviewSchema.safeParse(contribution.structured)
      return parsed.success && parsed.data.outcome === 'clear'
    })
  if (clear) {
    return empty('eligible', [], { draftActionId: latest.payload.actionId, reviewActionId: review.payload.actionId })
  }
  const amendment = results
    .filter(
      (record) =>
        record.payload.action === 'plan' &&
        record.payload.phase === 'result' &&
        record.payload.exactInputs.amendsReviewActionId === review.payload.actionId,
    )
    .at(-1)
  if (amendment === undefined || amendment.payload.action !== 'plan' || amendment.payload.phase !== 'result') {
    return empty('needs-amendment', [diagnostic('needs-amendment', 'blocking review has no amendment')], {
      draftActionId: latest.payload.actionId,
      reviewActionId: review.payload.actionId,
      blockers: refs,
    })
  }
  const declared = reviewBlockerRefs(review)
  if (!declared.ok) {
    return empty('blocked', declared.evidence, {
      draftActionId: latest.payload.actionId,
      reviewActionId: review.payload.actionId,
      amendmentActionId: amendment.payload.actionId,
    })
  }
  const parsedAmendment = planOutputSchema.safeParse(amendment.payload.structured)
  if (!parsedSuccess(parsedAmendment)) {
    return empty('blocked', [diagnostic('malformed', 'amendment is not a plan')], {
      amendmentActionId: amendment.payload.actionId,
      blockers: declared.refs,
    })
  }
  const required = amendment.payload.exactInputs.requiredBlockers
  const authored = parsedAmendment.data.resolutions.map((resolution) => resolution.blocker)
  if (!sameBlockerSet(required, declared.refs) || !sameBlockerSet(authored, declared.refs)) {
    return empty(
      'blocked',
      [diagnostic('missing-contribution', 'amendment resolutions do not cover the review refs')],
      {
        amendmentActionId: amendment.payload.actionId,
        blockers: declared.refs,
      },
    )
  }
  return empty('eligible', [], {
    draftActionId: latest.payload.actionId,
    reviewActionId: review.payload.actionId,
    amendmentActionId: amendment.payload.actionId,
    blockers: declared.refs,
  })
}

function parsedSuccess(
  parsed: { success: true; data: PlanOutput } | { success: false },
): parsed is { success: true; data: PlanOutput } {
  return parsed.success
}

export function actionCompletion(
  action: WorkflowGraphAction,
  evidence: WorkflowEvidence,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null = null,
): ActionCompletion {
  if (action === 'plan') {
    const macro = planMacro(evidence, mandate)
    if (macro.phase === 'eligible') return { status: 'confirmed', evidence: macro.evidence }
    if (macro.phase === 'blocked') return { status: 'blocked', evidence: macro.evidence }
    if (macro.phase === 'uncertain') return { status: 'uncertain', evidence: macro.evidence }
    return { status: 'not-started', evidence: macro.evidence }
  }
  if (action === 'implement') return implementationCompletion(evidence, mandate)
  if (action === 'assess-spec') return assessSpecCompletion(evidence, facts, mandate)
  if (action === 'attribute-ci') return ciAttributionCompletion(evidence, facts, mandate)
  if (action === 'proof') {
    if (decisions.proof.applicability === 'not-applicable' || decisions.proof.admission?.ok === true) {
      return { status: 'confirmed', evidence: decisions.proof.evidence }
    }
    return { status: 'not-started', evidence: decisions.proof.evidence }
  }
  const selector =
    action === 'publish'
      ? decisions.publish
      : action === 'land'
        ? decisions.landing
        : action === 'watch'
          ? decisions.watch
          : null
  if (selector !== null) {
    if (selector.status === 'published' || selector.status === 'not-applicable')
      return { status: 'confirmed', evidence: selector.evidence }
    if (selector.status === 'uncertain') return { status: 'uncertain', evidence: selector.evidence }
    if (selector.status === 'failed') return { status: 'blocked', evidence: selector.evidence }
    return { status: 'not-started', evidence: selector.evidence }
  }
  const progress = receiptProgress(evidence.issue, action)
  if (progress === 'uncertain')
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', `${action} started without a result`)] }
  if (progress === 'confirmed') return { status: 'confirmed', evidence: [] }
  return { status: 'not-started', evidence: [] }
}

function assessSpecCompletion(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts | null,
  mandate: MandateRecord | null,
): ActionCompletion {
  if (facts === null || mandate === null || facts.specBody === null || facts.specDigest === null)
    return { status: 'not-started', evidence: [] }
  if (specDigest(facts.specBody) !== facts.specDigest)
    return { status: 'blocked', evidence: [diagnostic('material-spec', 'Live spec digest does not match its body')] }
  const histories = [
    evidence.issue,
    ...(evidence.pullRequest === null ? [] : [evidence.pullRequest]),
    ...evidence.parents,
  ]
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) return { status: 'uncertain', evidence: accepted.evidence }
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const exactInputs = {
    acceptedBody: accepted.spec.body,
    acceptedDigest: accepted.spec.digest,
    currentBody: facts.specBody,
    currentDigest: facts.specDigest,
  }
  const exact = (record: CanonicalRecord) => {
    if (record.kind !== 'action-receipt' || record.payload.action !== 'assess-spec') return false
    return sameRef(record.payload.mandate, mandateRef) && sameAssessInputs(record.payload.exactInputs, exactInputs)
  }
  const receipts = recordsOf(evidence.issue).filter((record): record is ReceiptRecord => exact(record))
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record): record is AssessResultRecord => isAssessResult(record))
  if (starts.length === 0 && results.length === 0) return { status: 'not-started', evidence: [] }
  if (starts.length !== 1 || results.length !== 1)
    return {
      status: 'uncertain',
      evidence: [diagnostic('unconfirmed', 'Current spec assessment is not uniquely paired')],
    }
  const result = results[0]
  if (result === undefined)
    return { status: 'uncertain', evidence: [diagnostic('unconfirmed', 'Current spec assessment is missing')] }
  const authenticated = authenticatedAssessResult(result, histories, mandateRef)
  if (!authenticated.ok) return { status: 'uncertain', evidence: authenticated.evidence }
  return { status: 'confirmed', evidence: [] }
}

function ciAttributionCompletion(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts | null,
  mandate: MandateRecord | null,
): ActionCompletion {
  const histories = [evidence.issue, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest])]
  const receipts = histories.flatMap((history) =>
    recordsOf(history).filter(
      (record): record is ReceiptRecord => record.kind === 'action-receipt' && record.payload.action === 'attribute-ci',
    ),
  )
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record) => record.payload.phase === 'result')
  if (starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId)))
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', 'CI attribution start has no result')] }
  if (
    facts === null ||
    mandate === null ||
    facts.pullRequest === null ||
    facts.candidateGitSHA === null ||
    facts.evidenceDigest === null
  )
    return { status: 'not-started', evidence: [] }
  const bound = boundCiAttribution(histories, facts, mandate)
  return bound.change || bound.refused ? { status: 'confirmed', evidence: [] } : { status: 'not-started', evidence: [] }
}

function implementationCompletion(evidence: WorkflowEvidence, mandate: MandateRecord | null): ActionCompletion {
  const allReceipts = recordsOf(evidence.issue).filter(
    (record): record is ReceiptRecord => record.kind === 'action-receipt' && record.payload.action === 'implement',
  )
  const allStarts = allReceipts.filter((record) => record.payload.phase === 'start')
  const allResults = allReceipts.filter((record) => record.payload.phase === 'result')
  if (allStarts.some((start) => !allResults.some((result) => result.payload.actionId === start.payload.actionId))) {
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', 'implement start has no result')] }
  }
  if (
    allResults.some((result) => {
      if (result.payload.phase !== 'result' || result.payload.admission?.admitted !== true) return true
      const parsed = implementationOutputSchema.safeParse(result.payload.structured)
      return !parsed.success || parsed.data.outcome !== 'implemented'
    })
  ) {
    return { status: 'blocked', evidence: [diagnostic('unconfirmed', 'implement result was not admitted')] }
  }
  const macro = planMacro(evidence, mandate)
  if (macro.phase === 'blocked') return { status: 'blocked', evidence: macro.evidence }
  if (macro.phase === 'uncertain') return { status: 'uncertain', evidence: macro.evidence }
  if (macro.phase !== 'eligible' || mandate === null) return { status: 'not-started', evidence: [] }
  const planActionId = macro.amendmentActionId ?? macro.draftActionId
  if (planActionId === null) return { status: 'not-started', evidence: [] }
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const receipts = allReceipts.filter(
    (record) =>
      record.payload.action === 'implement' &&
      sameRef(record.payload.mandate, mandateRef) &&
      record.payload.exactInputs.mandateId === mandate.recordId &&
      record.payload.exactInputs.planActionId === planActionId,
  )
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record) => record.payload.phase === 'result')
  if (starts.length === 0 && results.length === 0) return { status: 'not-started', evidence: [] }
  if (results.length > 0) return { status: 'confirmed', evidence: [] }
  return { status: 'blocked', evidence: [diagnostic('unconfirmed', 'implement result was not admitted')] }
}
function planConfirmed(history: DecodedHistory, mandate: MandateRecord | null): boolean {
  return planMacro({ issue: history, pullRequest: null, parents: [] }, mandate).phase === 'eligible'
}
function implementConfirmed(history: DecodedHistory, mandate: MandateRecord | null): boolean {
  return implementationCompletion({ issue: history, pullRequest: null, parents: [] }, mandate).status === 'confirmed'
}
function prePrStartsAbsent(history: DecodedHistory): boolean {
  return !recordsOf(history).some(
    (record) =>
      record.kind === 'action-receipt' &&
      (record.payload.action === 'plan' ||
        record.payload.action === 'plan-review' ||
        record.payload.action === 'implement'),
  )
}
function adoptedOrConfirmed(history: DecodedHistory, mandate: MandateRecord | null): boolean {
  return prePrStartsAbsent(history) || implementConfirmed(history, mandate)
}
function sameBlocker(left: PlanBlockerRef, right: PlanBlockerRef): boolean {
  return left.sourceId === right.sourceId && left.slotId === right.slotId && left.blockerId === right.blockerId
}
function sameBlockerSet(left: readonly PlanBlockerRef[], right: readonly PlanBlockerRef[]): boolean {
  return left.length === right.length && left.every((item) => right.some((other) => sameBlocker(item, other)))
}
function reviewBlockerRefs(
  review: ReceiptRecord,
): { ok: true; refs: PlanBlockerRef[] } | { ok: false; evidence: Diagnostic[] } {
  if (review.payload.action !== 'plan-review' || review.payload.phase !== 'result') {
    return { ok: false, evidence: [diagnostic('malformed', 'plan review is not a result')] }
  }
  const refs: PlanBlockerRef[] = []
  for (const contribution of review.payload.contributions) {
    const parsed = planReviewSchema.safeParse(contribution.structured)
    if (!parsed.success) {
      return { ok: false, evidence: [diagnostic('ambiguous', 'specialist plan review is not a unique review')] }
    }
    if (parsed.data.outcome !== 'blocking') continue
    if (contribution.host.slotId === null) {
      return { ok: false, evidence: [diagnostic('malformed', 'blocking review has no slot')] }
    }
    for (const blocker of parsed.data.blockers) {
      refs.push({
        sourceId: contribution.host.childId ?? contribution.host.slotId,
        slotId: contribution.host.slotId,
        blockerId: blocker.id,
      })
    }
  }
  return { ok: true, refs }
}
function boundCiAttribution(
  histories: readonly DecodedHistory[],
  facts: WorkflowFacts,
  mandate: MandateRecord | null,
): { change: boolean; refused: boolean } {
  const digest = facts.evidenceDigest
  if (
    mandate === null ||
    facts.pullRequest === null ||
    facts.candidateGitSHA === null ||
    digest == null ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    return { change: false, refused: false }
  }
  let change = false
  let refused = false
  for (const history of histories) {
    for (const record of recordsOf(history)) {
      if (
        record.kind !== 'action-receipt' ||
        record.payload.action !== 'attribute-ci' ||
        record.payload.phase !== 'result'
      )
        continue
      if (record.payload.mandate.recordId !== mandate.recordId || record.payload.mandate.kind !== 'mandate') continue
      if (!equalScope(record.payload.mandate.scope, mandateScope(mandate))) continue
      const inputs = record.payload.exactInputs
      if (inputs.candidateGitSHA !== facts.candidateGitSHA) continue
      if (!equalScope(inputs.scope, facts.pullRequest.scope)) continue
      if (inputs.evidenceDigest !== digest) continue
      if (failedCheckEvidenceDigest(inputs) !== digest) continue
      const parsed = ciAttributionSchema.safeParse(record.payload.structured)
      if (!parsed.success) continue
      if (parsed.data.attribution === 'change') change = true
      else refused = true
    }
  }
  return { change, refused }
}
function workflowBound(
  mandate: MandateRecord | null,
  history: DecodedHistory,
  pullRequest: DecodedHistory | null,
  facts: WorkflowFacts,
): boolean {
  if (mandate === null || facts.pullRequest === null || facts.branch === null || pullRequest === null) return false
  const selected = selectWorkflowBinding({
    pullRequest: facts.pullRequest.scope,
    histories: [history, pullRequest],
    native: { branch: facts.branch, base: facts.pullRequest.base },
  })
  return selected.status === 'bound' && selected.mandateRecord.recordId === mandate.recordId
}
function completionBlockReason(completion: ActionCompletion): WorkflowBlockReason {
  const code = completion.evidence[0]?.code
  if (
    code === 'missing-contribution' ||
    code === 'missing-history' ||
    code === 'unconfirmed' ||
    code === 'action-uncertain'
  )
    return code
  return 'unconfirmed'
}
function unresolvedWork(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): ActionCompletion | null {
  for (const action of ['plan', 'implement', 'assess-spec', 'attribute-ci', 'fix', 'review'] as const) {
    const completion = actionCompletion(action, evidence, decisions, mandate, facts)
    if (completion.status === 'uncertain' || completion.status === 'blocked') return completion
  }
  return null
}
function conditionHolds(
  when: WorkflowCondition,
  history: DecodedHistory,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  pullRequest: DecodedHistory | null,
): boolean | null {
  if (when === 'always') return true
  if (when === 'no-mandate') return mandate === null
  if (when === 'mandate-ready') return mandate !== null
  if (when === 'spec-differs' || when === 'spec-settled') {
    if (mandate === null || facts.specDigest === null) return false
    const accepted = resolveAcceptedSpec(mandate, [history])
    if (!accepted.ok) return false
    return when === 'spec-settled'
      ? facts.specDigest === accepted.spec.digest
      : facts.specDigest !== accepted.spec.digest
  }
  if (when === 'plan-confirmed') return planConfirmed(history, mandate)
  if (when === 'implement-confirmed') return implementConfirmed(history, mandate)
  if (when === 'pr-open') {
    return (
      facts.pullRequest !== null &&
      workflowBound(mandate, history, pullRequest, facts) &&
      adoptedOrConfirmed(history, mandate)
    )
  }
  if (when === 'proof-confirmed')
    return decisions.proof.applicability === 'not-applicable' || decisions.proof.admission?.ok === true
  if (when === 'review-step-review') return decisions.reviewStep === 'review'
  if (when === 'review-step-fix') return decisions.reviewStep === 'fix' && decisions.ciWatchStatus !== 'red'
  if (when === 'review-step-land')
    return decisions.reviewStep === 'land' && workflowBound(mandate, history, pullRequest, facts)
  if (when === 'review-step-stop') return decisions.reviewStep === 'stop'
  if (when === 'fix-confirmed') return recordsOf(history).some((record) => record.kind === 'fix-result')
  if (when === 'ci-red' || when === 'ci-attributed-change' || when === 'ci-attribution-refused') {
    const eligibleFix = decisions.ciWatchStatus === 'red' && decisions.reviewStep === 'fix'
    if (!eligibleFix) return false
    const bound = boundCiAttribution([history, ...(pullRequest === null ? [] : [pullRequest])], facts, mandate)
    if (when === 'ci-red') return !bound.change && !bound.refused
    if (when === 'ci-attributed-change') return bound.change
    return bound.refused
  }
  if (when === 'merged') return facts.merged
  if (when === 'end-obligations-met') return facts.endObligationsMet
  if (when === 'epic-start') return decisions.epicStep === 'start'
  if (when === 'epic-resume') return decisions.epicStep === 'resume'
  if (when === 'epic-stop') return decisions.epicStep === 'stop'
  if (when === 'epic-final-review') return decisions.epicStep === 'final-review'
  if (when === 'epic-fix-ticket') return decisions.epicStep === 'fix-ticket'
  if (when === 'epic-post-merge') return decisions.epicStep === 'post-merge'
  if (when === 'epic-complete') return decisions.epicStep === 'complete'
  if (when === 'epic-drop') return decisions.epicStep === 'drop'
  return null
}

function blocked(reason: WorkflowBlockReason, evidence: Diagnostic[]): WorkflowDecision {
  return { status: 'blocked', reason, evidence }
}

function walk(
  graph: WorkflowGraph,
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): WorkflowDecision {
  const unresolved = unresolvedWork(evidence, facts, decisions, mandate)
  if (unresolved !== null) return blocked(completionBlockReason(unresolved), unresolved.evidence)
  const history = evidence.issue
  const pullRequest = evidence.pullRequest
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  let current = graph.initial
  const visited = new Set<string>()
  for (let guard = 0; guard < graph.nodes.length + 1; guard += 1) {
    if (visited.has(current)) return blocked('cycle', [diagnostic('cycle', 'Workflow traversal repeated a node')])
    visited.add(current)
    const node = nodes.get(current)
    if (node === undefined)
      return blocked('unsupported-graph', [diagnostic('unsupported-graph', 'Workflow node is missing')])
    const completion = actionCompletion(node.action, evidence, decisions, mandate, facts)
    if (completion.status === 'uncertain') return blocked('action-uncertain', completion.evidence)
    if (completion.status === 'blocked') return blocked(completionBlockReason(completion), completion.evidence)
    if (completion.status === 'not-started' && node.action !== 'stop' && node.action !== 'done') {
      if (node.action === 'proof' && pullRequest === null) {
        return blocked('missing-history', [diagnostic('missing-history', 'proof requires pull request history')])
      }
      if (WORKTREE_ACTIONS.has(node.action) && !sessionReady(facts))
        return blocked('session-cwd', sessionEvidence(facts))
      return {
        status: 'action',
        action: node.action,
        nodeId: node.id,
        mandateId: mandate.recordId,
        evidence: completion.evidence,
      }
    }
    if (
      node.action === 'stop' &&
      conditionHolds('ci-attribution-refused', history, facts, decisions, mandate, pullRequest) === true
    ) {
      return {
        status: 'terminal',
        reason: 'ci-attribution-refused',
        evidence: [diagnostic('ci-attribution-refused', 'CI attribution refused correction')],
      }
    }
    if (node.action === 'stop' && decisions.reviewStep === 'stop') {
      return { status: 'terminal', reason: 'bound-stop', evidence: [diagnostic('bound-stop', 'Review bound is spent')] }
    }
    if (node.action === 'done') {
      return facts.endObligationsMet
        ? { status: 'terminal', reason: 'done', evidence: [] }
        : blocked('unknown-outcome', [diagnostic('unknown-outcome', 'Merged work still has end obligations')])
    }
    const edges = graph.edges.filter((edge) => edge.from === current)
    const matching = edges.filter(
      (edge) => conditionHolds(edge.when, history, facts, decisions, mandate, pullRequest) === true,
    )
    const exclusive = [
      ['spec-differs', 'spec-settled'],
      ['review-step-review', 'review-step-fix', 'review-step-land', 'review-step-stop'],
      ['ci-red', 'ci-attributed-change', 'ci-attribution-refused'],
      [
        'epic-start',
        'epic-resume',
        'epic-stop',
        'epic-final-review',
        'epic-fix-ticket',
        'epic-post-merge',
        'epic-complete',
        'epic-drop',
      ],
    ].some((group) => matching.filter((edge) => group.includes(edge.when)).length > 1)
    if (exclusive) {
      return blocked('ambiguous-transition', [
        diagnostic('ambiguous-transition', `Node ${current} has exclusive conditions both true`),
      ])
    }
    const next = matching[0]
    if (next === undefined) {
      if ((node.action === 'land' || node.action === 'watch') && mandate.payload.permissions.landing === false) {
        return blocked('fix-only', [diagnostic('fix-only', 'Fix-only mandate cannot land')])
      }
      return blocked('unknown-outcome', [diagnostic('unknown-outcome', `Node ${current} has no matching edge`)])
    }
    current = next.to
  }
  return blocked('cycle', [diagnostic('cycle', 'Workflow traversal did not finish')])
}

export function reconstructWorkflow(input: {
  evidence: WorkflowEvidence
  facts: WorkflowFacts
  decisions: SpecializedDecisions
}): WorkflowDecision {
  const history = input.evidence.issue
  const externalHistories = [input.evidence.pullRequest, ...input.evidence.parents].filter(
    (item): item is DecodedHistory => item !== null,
  )
  const problem = workflowOperationProblem(history)
  if (problem === 'ambiguous')
    return blocked('ambiguous-transition', [diagnostic('ambiguous', 'Workflow history conflicts')])
  if (problem === 'unconfirmed' || problem === 'incomplete')
    return blocked('incomplete', [diagnostic(problem, 'Workflow history is not complete')])
  const selected = selectApplicableMandate(history, externalHistories)
  if (selected.status === 'refused' && selected.reason === 'missing') {
    if (!input.facts.explicitSelection)
      return blocked('mandate-absent', [
        diagnostic('mandate-absent', 'No mandate exists and selection was not explicit'),
      ])
    if (!sessionReady(input.facts)) return blocked('session-cwd', sessionEvidence(input.facts))
    return { status: 'action', action: 'frame', nodeId: null, mandateId: null, evidence: [] }
  }
  if (selected.status === 'refused' && (selected.reason === 'abandoned' || selected.reason === 'revoked')) {
    if (input.facts.explicitSelection)
      return blocked('successor-required', [
        diagnostic('successor-required', 'Explicit selection cannot mint a mandate over a revoked one'),
      ])
    return selected.reason === 'abandoned'
      ? {
          status: 'abandoned',
          mandateId: mandatesOf(history).find((record) => abandoned(history, record))?.recordId ?? 'unknown',
          evidence: selected.evidence,
        }
      : blocked('successor-required', selected.evidence)
  }
  if (selected.status === 'refused' && selected.reason === 'paused') {
    const ownPause = equalScope(selected.pause.mandate.scope, history.source.scope)
    if (ownPause && (input.facts.explicitSelection || input.facts.explicitResume) && sessionReady(input.facts))
      return {
        status: 'action',
        action: 'resume',
        nodeId: null,
        mandateId: selected.pause.mandate.recordId,
        evidence: [],
        pause: selected.pause,
      }
    return {
      status: 'paused',
      mandateId: selected.pause.mandate.recordId,
      confirmed: true,
      evidence: selected.evidence,
      pause: selected.pause,
    }
  }
  if (selected.status === 'refused') {
    const code = selected.evidence[0]?.code
    if (code === 'config-drift') return blocked('config-drift', selected.evidence)
    if (code === 'unsupported-graph') return blocked('unsupported-graph', selected.evidence)
    if (code === 'missing-history' || code === 'incomplete') return blocked('missing-history', selected.evidence)
    if (selected.reason === 'incompatible' || selected.reason === 'unsafe' || selected.reason === 'materially-changed')
      return blocked('unsafe-authority', selected.evidence)
    return blocked(selected.reason === 'unsupported' ? 'unsupported-config' : 'unconfirmed', selected.evidence)
  }
  const mandate = selected.mandate
  if (input.facts.localInhibit === 'pause' && confirmedPause(history, mandate) === null)
    return blocked('pause-unconfirmed', [
      diagnostic('pause-unconfirmed', 'Pause was inhibited locally but not confirmed'),
    ])
  if (input.facts.localInhibit === 'abandon' && !abandoned(history, mandate))
    return blocked('unconfirmed', [diagnostic('unconfirmed', 'Abandon was inhibited locally but not confirmed')])
  if (outstandingPauseRequest(history, mandate) !== null)
    return blocked('pause-unconfirmed', [diagnostic('pause-unconfirmed', 'Pause was requested and not confirmed')])
  const outstandingPause = outstandingPauseInAuthority(mandate, [history, ...externalHistories])
  if (outstandingPause !== null) return blocked('pause-unconfirmed', [outstandingPause])
  if (input.facts.productVersion !== mandate.payload.config.productVersion)
    return blocked('config-drift', [diagnostic('config-drift', 'Host product version differs from the mandate')])
  if (!input.facts.supportedConfigVersions.includes(mandate.payload.config.version))
    return blocked('unsupported-config', [diagnostic('unsupported-config', 'Mandate config version is not supported')])
  if (input.facts.configDigest !== mandate.payload.config.digest)
    return blocked('config-drift', [diagnostic('config-drift', 'Host config digest differs from the mandate')])
  const matchingAssessments =
    input.facts.specDigest === null || input.facts.specBody === null
      ? []
      : recordsOf(history).filter(
          (record): record is AssessResultRecord =>
            isAssessResult(record) &&
            sameRef(record.payload.mandate, {
              scope: mandateScope(mandate),
              recordId: mandate.recordId,
              kind: 'mandate',
            }) &&
            record.payload.exactInputs.currentDigest === input.facts.specDigest &&
            record.payload.exactInputs.currentBody === input.facts.specBody,
        )
  if (matchingAssessments.length > 0) {
    const accepted = resolveAcceptedSpec(mandate, [history, ...externalHistories])
    if (!accepted.ok) {
      return {
        status: 'terminal',
        reason: 'spec-ambiguous',
        evidence: accepted.evidence,
      }
    }
    const qualifiedAssessments = matchingAssessments.filter(
      (assessment) =>
        assessment.payload.exactInputs.acceptedDigest === accepted.spec.digest &&
        assessment.payload.exactInputs.acceptedBody === accepted.spec.body,
    )
    if (qualifiedAssessments.length > 1) {
      return {
        status: 'terminal',
        reason: 'spec-ambiguous',
        evidence: [diagnostic('spec-ambiguous', 'Competing assessments match the active Spec pair')],
      }
    }
    const assessment = qualifiedAssessments[0]
    if (assessment !== undefined) {
      const authenticated = authenticatedAssessResult(assessment, [history, ...externalHistories], {
        scope: mandateScope(mandate),
        recordId: mandate.recordId,
        kind: 'mandate',
      })
      if (!authenticated.ok) {
        return {
          status: 'terminal',
          reason: 'spec-ambiguous',
          evidence: authenticated.evidence,
        }
      }
      const parsed = specAssessmentSchema.safeParse(authenticated.record.payload.structured)
      if (!parsed.success || parsed.data.classification === 'unknown')
        return {
          status: 'terminal',
          reason: 'spec-ambiguous',
          evidence: [diagnostic('spec-ambiguous', 'Spec classification is unknown')],
        }
      if (parsed.data.classification === 'material')
        return blocked('spec-decision-required', [
          diagnostic('spec-decision-required', 'Material spec change has no operator decision'),
        ])
    }
  }
  const graph = executableGraph(mandate)
  if (!graph.ok) return blocked('unsupported-graph', graph.diagnostics)
  const decision = walk(graph.value, input.evidence, input.facts, input.decisions, mandate)
  if (
    decision.status === 'action' &&
    (decision.action === 'land' || decision.action === 'review' || decision.action === 'watch') &&
    input.facts.pullRequest !== null
  ) {
    if (input.facts.branch === null) {
      return blocked('unknown-binding', [diagnostic('unknown-binding', 'Pull request branch was not supplied')])
    }
    const selected = selectWorkflowBinding({
      pullRequest: input.facts.pullRequest.scope,
      histories: [history, ...externalHistories],
      native: { branch: input.facts.branch, base: input.facts.pullRequest.base },
    })
    if (selected.status !== 'bound' || selected.mandateRecord.recordId !== mandate.recordId) {
      return blocked(
        'unknown-binding',
        selected.status === 'bound'
          ? [diagnostic('unknown-binding', 'Workflow binding does not name the active mandate')]
          : selected.status === 'absent'
            ? [diagnostic('missing', 'No workflow binding exists on the pull request')]
            : selected.diagnostics,
      )
    }
  }
  return decision
}

export function composeChantier(input: {
  issue: DecodedHistory
  pullRequest: DecodedHistory | null
  parents: readonly DecodedHistory[]
}): Result<WorkflowEvidence> {
  const histories = [input.issue, ...(input.pullRequest === null ? [] : [input.pullRequest]), ...input.parents]
  for (const history of histories) {
    const problem = workflowOperationProblem(history)
    if (problem !== null) return fail([diagnostic(problem, 'Workflow history cannot be composed')])
  }
  return { ok: true, value: { issue: input.issue, pullRequest: input.pullRequest, parents: [...input.parents] } }
}
