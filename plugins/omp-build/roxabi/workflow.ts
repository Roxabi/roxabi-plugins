import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readNativePullRequestFacts, readWorkflowBinding } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { PauseBinding } from '../engine/workflow-control.ts'
import type { MandateSelection } from '../engine/workflow-mandate.ts'
import type { WorkflowDecision } from '../engine/workflow-reconstruction-types.ts'
import type { NativeBatch, NativeBatchResult, NativeChildResult } from '../omp/review-runtime.ts'
import { baseFromStack, branchFor, hasScope } from '../skills/feature/epic.ts'
import {
  epicDisarmControl,
  epicFinalReviewRequest,
  epicMarkFix,
  epicNext,
  epicReport,
  epicStep,
} from '../skills/feature/epic-driver.ts'
import { readProofReadiness, refreshSelectedBase } from '../skills/feature/proof.ts'
import {
  applyCiWatchExit,
  disarmReviewedBeforePush,
  featureLandOutcome,
  landPr,
  nextReviewStep,
  openPr,
  readReviewRecords,
  reviewStep,
} from '../skills/feature/workflow.js'
import { triageCli, triageDirectory } from '../triage-runtime.ts'
import { type PreparedEpicReview, prepareEpicFinalReviewMaterials } from './epic-range-review.ts'
import { admitAttributedCiCorrection, classifyCiCorrectionStep } from './fix.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import {
  defaultGit,
  prepareFeatureCheckout,
  runWorktreeBootstrap,
  sessionWorktreeIdentity,
} from './workflow-checkout.ts'
import {
  acceptanceCriteria,
  additionalRequirementsOf,
  configPinDigest,
  effectiveWorkflowConfig,
  type GitRunner,
  installedProductVersion,
  parseWorkflowOverride,
  readProofConfigPins,
  SUPPORTED_CONFIG_VERSIONS,
  WORKFLOW_CONFIG_VERSION,
} from './workflow-config.ts'

const execFileAsync = promisify(execFile)

const inhibited = new Map<string, 'pause' | 'abandon'>()

export type FeatureControl = 'select' | 'resume' | 'continue' | 'pause' | 'abandon' | 'new' | 'material-decision'

export type Gh = (cwd: string, args: string[]) => Promise<string>

export type FeatureContinuation =
  | { kind: 'action'; followUp: NativeBatch; node: string; start: ScopedRecordRef }
  | { kind: 'watch'; command: string }
  | { kind: 'epic-final-review'; review: PreparedEpicReview }
  | { kind: 'review'; pr: number }
  | { kind: 'blocked'; reason: string; diagnostics?: readonly Diagnostic[] }
  | { kind: 'paused'; confirmed: boolean; reason: string }
  | { kind: 'fix'; reference: string }
  | { kind: 'admitted-ci-correction'; reference: string; attributionRecordId: string; scope: string }
  | { kind: 'abandoned'; confirmed: boolean }
  | { kind: 'terminal'; reason: string; diagnostics?: readonly Diagnostic[] }
  | { kind: 'session-cwd'; path: string; instruction: string }
  | { kind: 'operator-decision'; reason: string }
type PausedContinuation = Extract<FeatureContinuation, { kind: 'paused' }>

// A public pause can synchronously interrupt native work, whose abort then
// triggers the session-stop pause path. Scope-level coalescing ensures both
// sources share one durable pause control.
const pausesInFlight = new Map<string, Promise<PausedContinuation>>()

export type ContinueFeatureInput = {
  cwd: string
  reference: string
  control: FeatureControl
  decision?: 'accept' | 'reject'
  /** True when the session cwd is the principal checkout — never dispatch native work there. */
  principal: boolean
  native: { reviewPort?: unknown }
  git?: GitRunner
  gh?: Gh
  watchExit?: number
}

type Diagnostic = { code: string; message: string; detail?: unknown }
type Scope = { repository: string; target: string }
type History = {
  source: { scope: Scope; complete: boolean }
  operations: {
    status: string
    record: {
      kind: string
      recordId: string
      operationId: string
      repository: string
      target: string
      payload: Record<string, unknown>
    } | null
  }[]
  diagnostics: Diagnostic[]
}

type WorkflowEvidence = { issue: History; pullRequest: History | null; parents: History[] }

type NativeSelector = {
  status: 'absent' | 'published' | 'uncertain' | 'failed' | 'not-applicable'
  evidence: Diagnostic[]
}
type ProofSelector = {
  admission: { ok: true; candidateGitSHA: string; input: string; recordIds: readonly string[] } | null
  candidateGitSHA: string | null
  input: string | null
  applicability: 'required' | 'not-applicable'
  evidence: Diagnostic[]
}
type SpecializedDecisions = {
  reviewStep: 'review' | 'fix' | 'land' | 'stop' | null
  epicStep: 'start' | 'resume' | 'stop' | 'final-review' | 'fix-ticket' | 'post-merge' | 'complete' | 'drop' | null
  epicLand: boolean | null
  ciWatchStatus: 'green' | 'red' | 'pending' | 'timeout' | 'behind' | 'unknown' | null
  publish: NativeSelector
  landing: NativeSelector
  watch: NativeSelector
  proof: ProofSelector
}

type Contracts = {
  reconstructWorkflow: (input: {
    evidence: WorkflowEvidence
    facts: Record<string, unknown>
    decisions: SpecializedDecisions
  }) => WorkflowDecision
  selectApplicableMandate: (history: History, externalHistories?: readonly History[]) => MandateSelection
  bindExternalRef: (
    ref: ScopedRecordRef,
    history: DecodedHistory,
  ) => { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] }
  specDigest: (body: string) => string
  shippedProductVersion: () => string
  buildRecord: (draft: unknown) => { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] }
  publishConfirmedWorkflowRecord: (
    record: unknown,
    history: History,
    options: { cwd: string; gh?: Gh },
    config: null,
    externalHistories?: readonly History[],
  ) => Promise<{ status: 'confirmed' } | { status: 'uncertain' | 'refused'; diagnostics: Diagnostic[] }>
  readComposedWorkflowHistory: (
    scopes: readonly Scope[],
    options: { cwd: string; gh?: Gh },
  ) => Promise<
    { ok: true; histories: History[]; records: unknown[] } | { ok: false; reason: string; diagnostics: Diagnostic[] }
  >
  resolveNativeTarget: (
    reference: string,
    options: { cwd: string; gh?: Gh },
  ) => Promise<
    | { status: 'issue'; scope: Scope; issue: { number: number } }
    | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number; head: string; base: string; branch: string } }
    | { status: string; diagnostics: Diagnostic[] }
  >
  resolveNativeScope: (
    scope: Scope,
    options: { cwd: string; gh?: Gh },
  ) => Promise<
    | { status: 'issue'; scope: Scope; issue: { number: number } }
    | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number; head: string; base: string; branch: string } }
    | { status: string; diagnostics: Diagnostic[] }
  >
  readLinkedIssueAssociation: (
    repository: string,
    pr: number,
    options: { cwd: string; gh?: Gh },
  ) => Promise<
    | { status: 'linked'; scope: Scope; number: number }
    | { status: 'none' }
    | { status: string; diagnostics: Diagnostic[] }
  >
  readIssueParentAssociation: (
    repository: string,
    number: number,
    options: { cwd: string; gh?: Gh },
  ) => Promise<{ status: 'linked'; scope: Scope; number: number } | { status: 'none' } | { status: string }>
  githubScope: (repository: string, number: number) => Scope
  composeChantier: (input: {
    issue: History
    pullRequest: History | null
    parents: readonly History[]
  }) => { ok: true; value: WorkflowEvidence } | { ok: false; diagnostics: Diagnostic[] }
  planMacro: (
    evidence: WorkflowEvidence,
    mandate: History['operations'][number]['record'] | null,
  ) => {
    phase: string
    draftActionId: string | null
    reviewActionId: string | null
    amendmentActionId: string | null
    blockers: { sourceId: string; slotId: string; blockerId: string }[]
    evidence: Diagnostic[]
  }
  planDigest: (plan: { steps: unknown[]; resolutions: unknown[] }) => string
  failedCheckEvidenceDigest: (input: {
    candidateGitSHA: string
    scope: Scope
    failures: readonly {
      name: string
      source: string
      observationId: string
      conclusion: string
    }[]
  }) => string | null
  resolveAcceptedSpec: (
    mandate: History['operations'][number]['record'],
    histories: readonly History[],
  ) =>
    | {
        ok: true
        spec: {
          reference: string
          body: string
          digest: string
          lastEditedAt: string | null
          chain: readonly unknown[]
          sourceRefs: readonly unknown[]
        }
      }
    | { ok: false; reason: string; evidence?: readonly Diagnostic[] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fn(mod: Record<string, unknown>, name: string): unknown {
  const value = mod[name]
  return typeof value === 'function' ? value : null
}

async function loadContracts(): Promise<Contracts | { missing: string }> {
  const imported: unknown = await import('../dist/contracts.js')
  if (!isRecord(imported)) return { missing: 'dist/contracts.js' }
  const names = [
    'reconstructWorkflow',
    'selectApplicableMandate',
    'specDigest',
    'shippedProductVersion',
    'buildRecord',
    'publishConfirmedWorkflowRecord',
    'readComposedWorkflowHistory',
    'resolveNativeTarget',
    'resolveNativeScope',
    'readLinkedIssueAssociation',
    'readIssueParentAssociation',
    'githubScope',
    'composeChantier',
    'planMacro',
    'planDigest',
    'failedCheckEvidenceDigest',
    'resolveAcceptedSpec',
    'bindExternalRef',
  ] as const
  for (const name of names) {
    if (fn(imported, name) === null) return { missing: name }
  }
  return imported as Contracts
}

function defaultGh(): Gh {
  return async (cwd, args) => {
    const out = await execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return out.stdout
  }
}

function inhibitKey(scope: Scope): string {
  return `${scope.repository} ${scope.target}`
}

function pauseKey(mandate: ScopedRecordRef): string {
  return `${inhibitKey(mandate.scope)}\0${mandate.kind}\0${mandate.recordId}`
}

function batch(operationId: string, tasks: { name: string; agent: string; task: string }[]): NativeBatch {
  return {
    operationId,
    tasks: {
      context: 'omp-build workflow action',
      tasks: tasks.map((item) => ({
        name: item.name,
        agent: item.agent,
        task: item.task,
        solutionSpace: 'one named workflow action; no second review loop',
      })),
    },
  }
}

function payload(record: NonNullable<History['operations'][number]['record']>): Record<string, unknown> {
  return record.payload
}

function matchesRecordRef(value: unknown, scope: Scope, recordId: string, kind: string): boolean {
  return (
    isRecord(value) &&
    isRecord(value.scope) &&
    value.scope.repository === scope.repository &&
    value.scope.target === scope.target &&
    value.recordId === recordId &&
    value.kind === kind
  )
}

type MaterialAssessment = {
  acceptedDigest: string
  currentDigest: string
  acceptedBody: string
  currentBody: string
}

function exactSpecPair(value: unknown, digest: (body: string) => string): MaterialAssessment | null {
  if (!isRecord(value)) return null
  const acceptedDigest = value.acceptedDigest
  const currentDigest = value.currentDigest
  const acceptedBody = value.acceptedBody
  const currentBody = value.currentBody
  if (
    typeof acceptedDigest !== 'string' ||
    typeof currentDigest !== 'string' ||
    typeof acceptedBody !== 'string' ||
    typeof currentBody !== 'string' ||
    digest(acceptedBody) !== acceptedDigest ||
    digest(currentBody) !== currentDigest
  )
    return null
  return { acceptedDigest, currentDigest, acceptedBody, currentBody }
}

async function handleMaterialDecision(input: {
  decision: 'accept' | 'reject' | undefined
  loaded: Contracts
  history: History
  parents: readonly History[]
  mandate: NonNullable<History['operations'][number]['record']>
  issue: { body: string }
  gh: Gh
  cwd: string
}): Promise<FeatureContinuation | { kind: 'accepted' }> {
  if (input.decision !== 'accept' && input.decision !== 'reject')
    return { kind: 'blocked', reason: 'material-decision-invalid' }
  const mandateScope = { repository: input.mandate.repository, target: input.mandate.target }
  const mandateRef = { scope: mandateScope, recordId: input.mandate.recordId, kind: 'mandate' }
  const accepted = input.loaded.resolveAcceptedSpec(input.mandate, [input.history, ...input.parents])
  if (!accepted.ok) return { kind: 'blocked', reason: `material-decision-${accepted.reason}` }
  const receipts = input.history.operations
    .filter((operation) => operation.status === 'complete' && operation.record?.kind === 'action-receipt')
    .map((operation) => operation.record)
    .filter((record): record is NonNullable<History['operations'][number]['record']> => record !== null)
  const currentDigest = input.loaded.specDigest(input.issue.body)
  const candidate = receipts.filter((record) => {
    const body = payload(record)
    if (
      body.action !== 'assess-spec' ||
      body.phase !== 'result' ||
      !matchesRecordRef(body.mandate, mandateScope, input.mandate.recordId, 'mandate')
    )
      return false
    const exact = exactSpecPair(body.exactInputs, input.loaded.specDigest)
    if (
      exact === null ||
      exact.acceptedBody !== accepted.spec.body ||
      exact.acceptedDigest !== accepted.spec.digest ||
      exact.currentBody !== input.issue.body ||
      exact.currentDigest !== currentDigest
    )
      return false
    return receipts.some((start) => {
      const startBody = payload(start)
      const startExact = exactSpecPair(startBody.exactInputs, input.loaded.specDigest)
      return (
        startBody.action === 'assess-spec' &&
        startBody.phase === 'start' &&
        startBody.actionId === body.actionId &&
        matchesRecordRef(startBody.mandate, mandateScope, input.mandate.recordId, 'mandate') &&
        matchesRecordRef(body.start, mandateScope, start.recordId, 'action-receipt') &&
        startExact !== null &&
        startExact.acceptedDigest === exact.acceptedDigest &&
        startExact.currentDigest === exact.currentDigest &&
        startExact.acceptedBody === exact.acceptedBody &&
        startExact.currentBody === exact.currentBody
      )
    })
  })
  if (candidate.length === 0) return { kind: 'blocked', reason: 'material-decision-assessment-missing' }
  if (candidate.length > 1) return { kind: 'blocked', reason: 'material-decision-assessment-ambiguous' }
  const record = candidate[0]
  if (record === undefined) return { kind: 'blocked', reason: 'material-decision-assessment-missing' }
  const result = payload(record)
  const classification = isRecord(result.structured) ? result.structured.classification : null
  if (classification !== 'material') return { kind: 'blocked', reason: 'material-decision-not-pending' }
  const exact = exactSpecPair(result.exactInputs, input.loaded.specDigest)
  if (
    exact === null ||
    exact.acceptedBody !== accepted.spec.body ||
    exact.acceptedDigest !== accepted.spec.digest ||
    exact.currentBody !== input.issue.body ||
    exact.currentDigest !== currentDigest
  )
    return { kind: 'blocked', reason: 'material-decision-assessment-stale' }
  const assessmentRef = { scope: mandateScope, recordId: record.recordId, kind: 'action-receipt' }
  const controls = input.history.operations
    .filter((operation) => operation.status === 'complete' && operation.record?.kind === 'operator-control')
    .map((operation) => operation.record)
    .filter((record): record is NonNullable<History['operations'][number]['record']> => record !== null)
  if (
    controls.some((control) => {
      const body = payload(control)
      return (
        body.control === 'accept-material' &&
        matchesRecordRef(body.assessment, mandateScope, record.recordId, 'action-receipt')
      )
    })
  )
    return { kind: 'blocked', reason: 'material-decision-already-accepted' }
  if (input.decision === 'reject') return { kind: 'terminal', reason: 'material-spec-rejected' }
  const tail = accepted.spec.chain.at(-1)
  const predecessor = (() => {
    if (!isRecord(tail) || typeof tail.recordId !== 'string' || typeof tail.kind !== 'string')
      return { scope: mandateScope, recordId: input.mandate.recordId, kind: 'mandate' }
    if (tail.kind === 'mandate') return { scope: mandateScope, recordId: tail.recordId, kind: 'mandate' }
    if (tail.kind === 'editorial') return { scope: mandateScope, recordId: tail.recordId, kind: 'action-receipt' }
    if (tail.kind === 'accept-material')
      return { scope: mandateScope, recordId: tail.recordId, kind: 'operator-control' }
    return null
  })()
  if (predecessor === null) return { kind: 'blocked', reason: 'material-decision-chain-invalid' }
  const acceptanceId = `accept-material-${createHash('sha256')
    .update(
      JSON.stringify({
        scope: mandateScope,
        mandate: input.mandate.recordId,
        predecessor: { recordId: predecessor.recordId, kind: predecessor.kind },
        assessment: record.recordId,
        specDigest: exact.currentDigest,
      }),
    )
    .digest('hex')}`
  const published = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: mandateScope.repository,
      target: mandateScope.target,
      version: 1,
      recordId: acceptanceId,
      runId: acceptanceId,
      operationId: acceptanceId,
      kind: 'operator-control',
      payload: {
        control: 'accept-material',
        controlId: acceptanceId,
        mandate: mandateRef,
        predecessor,
        assessment: assessmentRef,
        specDigest: exact.currentDigest,
      },
    },
    input.gh,
    input.cwd,
    input.parents,
  )
  if (!published.ok)
    return { kind: 'blocked', reason: 'material-decision-unconfirmed', diagnostics: published.diagnostics }
  const reread = await input.loaded.readComposedWorkflowHistory([mandateScope], { cwd: input.cwd, gh: input.gh })
  const confirmed = reread.ok
    ? reread.histories[0]?.operations.some((operation) => {
        const control = operation.status === 'complete' ? operation.record : null
        if (control?.kind !== 'operator-control') return false
        const body = payload(control)
        return (
          body.control === 'accept-material' &&
          matchesRecordRef(body.mandate, mandateScope, input.mandate.recordId, 'mandate') &&
          matchesRecordRef(body.predecessor, mandateScope, predecessor.recordId, predecessor.kind) &&
          matchesRecordRef(body.assessment, mandateScope, record.recordId, 'action-receipt') &&
          body.specDigest === exact.currentDigest
        )
      }) === true
    : false
  return confirmed ? { kind: 'accepted' } : { kind: 'blocked', reason: 'material-decision-unconfirmed' }
}

async function readIssue(
  gh: Gh,
  cwd: string,
  repository: string,
  number: number,
): Promise<{ title: string; body: string; labels: string[]; updatedAt: string } | null> {
  const raw = await gh(cwd, [
    'issue',
    'view',
    String(number),
    '--repo',
    repository,
    '--json',
    'title,body,labels,updatedAt',
  ])
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || typeof parsed.title !== 'string' || typeof parsed.body !== 'string') return null
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.flatMap((label) => (isRecord(label) && typeof label.name === 'string' ? [label.name] : []))
    : []
  const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString()
  return { title: parsed.title, body: parsed.body, labels, updatedAt }
}

async function publishRecord(
  contracts: Contracts,
  history: History,
  draft: unknown,
  gh: Gh,
  cwd: string,
  externalHistories?: readonly History[],
): Promise<{ ok: true } | { ok: false; reason: string; diagnostics?: readonly Diagnostic[] }> {
  const built = contracts.buildRecord(draft)
  if (!built.ok) {
    // Keep machine reason = diagnostic codes; pass full diagnostics for host surfacing.
    return {
      ok: false,
      reason: built.diagnostics.map((item) => item.code).join(',') || 'record-invalid',
      diagnostics: built.diagnostics,
    }
  }
  const published = await contracts.publishConfirmedWorkflowRecord(
    built.value,
    history,
    { cwd, gh },
    null,
    externalHistories,
  )
  if (published.status !== 'confirmed') {
    return {
      ok: false,
      reason: published.status,
      diagnostics: Array.isArray(published.diagnostics) ? published.diagnostics : undefined,
    }
  }
  return { ok: true }
}

function sameDirectory(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function linkedMove(cwd: string, path: string): FeatureContinuation | null {
  if (sameDirectory(cwd, path)) return null
  return { kind: 'session-cwd', path, instruction: `/move ${path}` }
}

function moveFromEvidence(cwd: string, evidence: readonly Diagnostic[]): FeatureContinuation | null {
  for (const item of evidence) {
    const detail = item.detail
    if (!isRecord(detail) || typeof detail.path !== 'string' || typeof detail.instruction !== 'string') continue
    if (detail.instruction !== `/move ${detail.path}`) continue
    return linkedMove(cwd, detail.path)
  }
  return null
}

function mandateBranch(mandate: History['operations'][number]['record']): string | null {
  if (mandate === null || !isRecord(mandate.payload)) return null
  return typeof mandate.payload.branch === 'string' && mandate.payload.branch.length > 0 ? mandate.payload.branch : null
}

function actionRequiresFeatureCheckout(action: string): boolean {
  return (
    action === 'plan' ||
    action === 'implement' ||
    action === 'assess-spec' ||
    action === 'attribute-ci' ||
    action === 'publish' ||
    action === 'proof' ||
    action === 'review' ||
    action === 'fix' ||
    action === 'land'
  )
}

async function requireMandateCheckout(input: {
  cwd: string
  git: GitRunner
  scope: Scope
  mandate: NonNullable<History['operations'][number]['record']>
}): Promise<FeatureContinuation | null> {
  const branch = mandateBranch(input.mandate)
  const base = input.mandate.payload.base
  if (branch === null || typeof base !== 'string' || base.length === 0) {
    return { kind: 'blocked', reason: 'mandate-checkout-unreadable' }
  }
  const prepared = await prepareFeatureCheckout({
    git: input.git,
    sessionCwd: input.cwd,
    branch,
    base,
    repository: input.scope.repository,
    detached: false,
  })
  if (prepared.status === 'blocked') return { kind: 'blocked', reason: prepared.reason }
  if (prepared.status === 'move') {
    return linkedMove(input.cwd, prepared.path) ?? { kind: 'blocked', reason: 'session-not-intended-worktree' }
  }
  return null
}

function mandateRoleOf(mandate: History['operations'][number]['record']): 'feature' | 'epic' | 'fix-only' | null {
  if (mandate === null || !isRecord(mandate.payload)) return null
  return mandate.payload.role === 'feature' || mandate.payload.role === 'epic' || mandate.payload.role === 'fix-only'
    ? mandate.payload.role
    : null
}

function mandatesInHistory(history: History): NonNullable<History['operations'][number]['record']>[] {
  return history.operations.flatMap((operation) => {
    const record = operation.record
    return operation.status === 'complete' && record?.kind === 'mandate' ? [record] : []
  })
}

function selectSuccessorControl(
  history: History,
  predecessor: { scope: Scope; recordId: string; kind: 'mandate' },
): { successor: { scope: Scope; recordId: string; kind: string } } | null {
  for (const operation of history.operations) {
    const record = operation.record
    if (operation.status !== 'complete' || record?.kind !== 'operator-control') continue
    const body = payload(record)
    if (body.control !== 'select-successor') continue
    if (!isRecord(body.predecessor)) continue
    const pred = body.predecessor
    if (
      isRecord(pred.scope) &&
      pred.scope.repository === predecessor.scope.repository &&
      pred.scope.target === predecessor.scope.target &&
      pred.recordId === predecessor.recordId &&
      pred.kind === 'mandate' &&
      isRecord(body.successor) &&
      typeof body.successor.recordId === 'string' &&
      isRecord(body.successor.scope)
    ) {
      return {
        successor: {
          scope: {
            repository: String(body.successor.scope.repository),
            target: String(body.successor.scope.target),
          },
          recordId: body.successor.recordId,
          kind: typeof body.successor.kind === 'string' ? body.successor.kind : 'mandate',
        },
      }
    }
  }
  return null
}

/** Intact abandoned/revoked tip that `/feature new` must succeed. */
function successionAntecedent(history: History):
  | {
      mandate: NonNullable<History['operations'][number]['record']>
      ref: { scope: Scope; recordId: string; kind: 'mandate' }
    }
  | { reason: string } {
  const mandates = mandatesInHistory(history)
  if (mandates.length === 0) return { reason: 'mandate-missing' }
  const last = mandates[mandates.length - 1]
  if (last === undefined) return { reason: 'mandate-missing' }
  const ref = {
    scope: { repository: last.repository, target: last.target },
    recordId: last.recordId,
    kind: 'mandate' as const,
  }
  const existing = selectSuccessorControl(history, ref)
  if (existing === null) return { mandate: last, ref }
  const tip = mandates.find((mandate) => mandate.recordId === existing.successor.recordId)
  if (tip === undefined) return { reason: 'successor-unconfirmed' }
  return {
    mandate: tip,
    ref: { scope: { repository: tip.repository, target: tip.target }, recordId: tip.recordId, kind: 'mandate' },
  }
}

async function pauseConfirmedReadback(
  loaded: Contracts,
  scope: Scope,
  controlId: string,
  requestRecordId: string,
  options: { cwd: string; gh?: Gh },
): Promise<boolean> {
  const reread = await loaded.readComposedWorkflowHistory([scope], options)
  if (!reread.ok || !reread.histories[0]) return false
  return reread.histories[0].operations.some((operation) => {
    const record = operation.record
    if (operation.status !== 'complete' || record?.kind !== 'operator-control') return false
    const body = payload(record)
    if (body.control !== 'pause-confirmed' || body.controlId !== controlId) return false
    if (!isRecord(body.predecessor)) return false
    return body.predecessor.recordId === requestRecordId && body.predecessor.kind === 'operator-control'
  })
}
function bindsOwnPause(
  loaded: Contracts,
  selection: MandateSelection,
  history: History,
  scope: Scope,
  expected?: ScopedRecordRef,
): boolean {
  if (selection.status !== 'refused' || selection.reason !== 'paused') return false
  const { mandate, confirmation } = selection.pause
  if (
    mandate.scope.repository !== scope.repository ||
    mandate.scope.target !== scope.target ||
    confirmation.scope.repository !== scope.repository ||
    confirmation.scope.target !== scope.target ||
    (expected !== undefined &&
      (mandate.kind !== expected.kind ||
        mandate.recordId !== expected.recordId ||
        mandate.scope.repository !== expected.scope.repository ||
        mandate.scope.target !== expected.scope.target))
  ) {
    return false
  }
  const decodedHistory = history as unknown as DecodedHistory
  return loaded.bindExternalRef(mandate, decodedHistory).ok && loaded.bindExternalRef(confirmation, decodedHistory).ok
}

async function publishConfirmedPause(input: {
  loaded: Contracts
  history: History
  scope: Scope
  target: ControlTarget
  gh: Gh
  cwd: string
  parentHistories: readonly History[]
  mandate: ScopedRecordRef
  role: 'feature' | 'epic' | 'fix-only' | null
  branch: string | null
  options: { cwd: string; gh?: Gh }
}): Promise<PausedContinuation> {
  const key = pauseKey(input.mandate)
  const inFlight = pausesInFlight.get(key)
  if (inFlight !== undefined) return inFlight

  const publication = (async (): Promise<PausedContinuation> => {
    const fresh = await input.loaded.readComposedWorkflowHistory([input.scope], input.options)
    if (!fresh.ok || fresh.histories[0] === undefined) {
      return { kind: 'paused', confirmed: false, reason: 'pause-uncertain' }
    }
    const history = fresh.histories[0]
    const parents = await mandateParentHistories(input.loaded, history, input.options)
    if (!parents.ok || !input.loaded.bindExternalRef(input.mandate, history as unknown as DecodedHistory).ok) {
      return { kind: 'paused', confirmed: false, reason: 'pause-uncertain' }
    }
    const selection = input.loaded.selectApplicableMandate(history, parents.parents)
    if (bindsOwnPause(input.loaded, selection, history, input.scope, input.mandate)) {
      return { kind: 'paused', confirmed: true, reason: 'paused' }
    }
    if (
      selection.status !== 'applicable' ||
      selection.mandate.recordId !== input.mandate.recordId ||
      selection.mandate.repository !== input.mandate.scope.repository ||
      selection.mandate.target !== input.mandate.scope.target
    ) {
      return { kind: 'paused', confirmed: false, reason: 'pause-uncertain' }
    }
    // Durable controlId must match request → confirmed (engine confirmedPause).
    const controlId = randomUUID()
    const requestedId = randomUUID()
    const requested = await publishRecord(
      input.loaded,
      history,
      {
        repository: input.scope.repository,
        target: input.scope.target,
        version: 1,
        recordId: requestedId,
        runId: requestedId,
        operationId: requestedId,
        kind: 'operator-control',
        payload: {
          control: 'pause-requested',
          controlId,
          predecessor: null,
          mandate: input.mandate,
        },
      },
      input.gh,
      input.cwd,
      parents.parents,
    )
    const evidence = await disarmKnownTarget(input.gh, input.cwd, input.target, input.role, input.branch)
    if (!requested.ok || !evidence.clean) {
      return { kind: 'paused', confirmed: false, reason: requested.ok ? 'pause-unconfirmed' : 'pause-uncertain' }
    }
    const confirmed = await publishRecord(
      input.loaded,
      history,
      {
        repository: input.scope.repository,
        target: input.scope.target,
        version: 1,
        recordId: randomUUID(),
        runId: randomUUID(),
        operationId: randomUUID(),
        kind: 'operator-control',
        payload: {
          control: 'pause-confirmed',
          controlId,
          predecessor: { scope: input.scope, recordId: requestedId, kind: 'operator-control' },
          mandate: input.mandate,
          disarm: { observed: true, evidence: evidence.evidence },
        },
      },
      input.gh,
      input.cwd,
      parents.parents,
    )
    if (!confirmed.ok) return { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }
    const seen = await pauseConfirmedReadback(input.loaded, input.scope, controlId, requestedId, input.options)
    return seen
      ? { kind: 'paused', confirmed: true, reason: 'pause-confirmed' }
      : { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }
  })()

  pausesInFlight.set(key, publication)
  try {
    return await publication
  } finally {
    if (pausesInFlight.get(key) === publication) pausesInFlight.delete(key)
  }
}

async function openLinkedPullRequests(gh: Gh, cwd: string, repository: string, issue: number): Promise<number[]> {
  const raw = await gh(cwd, [
    'pr',
    'list',
    '--repo',
    repository,
    '--state',
    'open',
    '--search',
    `linked:issue:${issue}`,
    '--json',
    'number',
  ])
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item) => {
    if (item === null || typeof item !== 'object' || !('number' in item) || typeof item.number !== 'number') return []
    return [item.number]
  })
}

type ControlTarget =
  | { status: 'issue'; scope: Scope; issue: { number: number } }
  | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number } }

type ResolvedTarget =
  | { status: 'issue'; scope: Scope; issue: { number: number } }
  | {
      status: 'pull-request'
      scope: Scope
      pullRequest: { pr: number; head: string; base: string; branch: string }
    }

function isResolvedTarget(target: Awaited<ReturnType<Contracts['resolveNativeTarget']>>): target is ResolvedTarget {
  return (
    (target.status === 'issue' || target.status === 'pull-request') && 'scope' in target && !('diagnostics' in target)
  )
}

async function openBranchPullRequests(gh: Gh, cwd: string, repository: string, branch: string): Promise<number[]> {
  const raw = await gh(cwd, [
    'pr',
    'list',
    '--repo',
    repository,
    '--state',
    'open',
    '--head',
    branch,
    '--json',
    'number',
  ])
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item) => {
    if (item === null || typeof item !== 'object' || !('number' in item) || typeof item.number !== 'number') return []
    return [item.number]
  })
}

async function disarmKnownTarget(
  gh: Gh,
  cwd: string,
  target: ControlTarget,
  role: 'feature' | 'epic' | 'fix-only' | null = null,
  branch: string | null = null,
): Promise<{ clean: boolean; evidence: unknown }> {
  // Epic owns role-aware child/PR disarm. Ordinary Feature never calls epicDisarmControl.
  if (target.status === 'issue' && role === 'epic') {
    try {
      const evidence = await epicDisarmControl(cwd, target.issue.number)
      return { clean: evidence.failed.length === 0, evidence }
    } catch (error) {
      return {
        clean: false,
        evidence: { error: error instanceof Error ? error.message : 'epic-disarm-unavailable' },
      }
    }
  }
  const numbers = new Set<number>()
  let listFailed = false
  if (target.status === 'pull-request') numbers.add(target.pullRequest.pr)
  if (target.status === 'issue') {
    try {
      for (const pr of await openLinkedPullRequests(gh, cwd, target.scope.repository, target.issue.number)) {
        numbers.add(pr)
      }
    } catch {
      listFailed = true
    }
  }
  if (branch !== null && branch.length > 0) {
    try {
      for (const pr of await openBranchPullRequests(gh, cwd, target.scope.repository, branch)) {
        numbers.add(pr)
      }
    } catch {
      listFailed = true
    }
  }
  if (numbers.size === 0) {
    // Empty discovery is not observed disarm when listing failed or a branch
    // was expected. Issue-only with successful empty lists stays clean.
    return {
      clean: !listFailed && target.status === 'issue',
      evidence: {
        disarmed: [],
        role: role ?? 'unknown',
        note: listFailed ? 'pull-request-list-failed' : 'no-open-pull-requests',
        branch,
      },
    }
  }
  const disarmed: unknown[] = []
  let clean = true
  for (const pr of numbers) {
    try {
      const result = await disarmReviewedBeforePush(cwd, pr, { gh })
      const receipt = result as Record<string, unknown>
      const ok =
        Object.keys(receipt).length === 1 &&
        ['disarmed', 'unarmed', 'closed', 'merged'].some((state) => receipt[state] === true)
      disarmed.push({ pr, result })
      if (!ok) clean = false
    } catch (error) {
      clean = false
      disarmed.push({ pr, error: error instanceof Error ? error.message : 'disarm-failed' })
    }
  }
  return { clean, evidence: { disarmed, role: role ?? 'unknown', branch } }
}

async function disarmUnresolved(gh: Gh, cwd: string, reference: string): Promise<void> {
  const number = Number(reference.replace(/^.*?(\d+)$/, '$1'))
  if (!Number.isInteger(number) || number <= 0) return
  try {
    await gh(cwd, ['pr', 'view', String(number), '--json', 'number'])
    await disarmReviewedBeforePush(cwd, number, { gh })
    return
  } catch {
    // Not a pull request. Disarm open linked PRs only; do not assume Epic.
  }
  try {
    const repoRaw = await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
    const repo: unknown = JSON.parse(repoRaw)
    if (
      repo === null ||
      typeof repo !== 'object' ||
      !('nameWithOwner' in repo) ||
      typeof repo.nameWithOwner !== 'string'
    ) {
      return
    }
    await disarmKnownTarget(
      gh,
      cwd,
      {
        status: 'issue',
        scope: { repository: repo.nameWithOwner, target: `${repo.nameWithOwner}#${number}` },
        issue: { number },
      },
      null,
    )
  } catch {
    // Attempted. Do not claim pause-confirmed.
  }
}
/** A free /feature subject is not an issue. Do not gh-view it. */
function issueReference(reference: string): boolean {
  return /^(?:#\d+|\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)$/.test(reference.trim())
}

type Delivery = {
  number: number
  scope: Scope
  head: string
  branch: string
  base: string
  history: History
  issueScope: Scope
}

function reenterFeature(input: {
  cwd: string
  reference: string
  gh?: Gh
  git?: GitRunner
  exactMandateRef?: ScopedRecordRef
}): Promise<FeatureContinuation> {
  return continueFeatureAtTarget(
    {
      cwd: input.cwd,
      reference: input.reference,
      control: 'continue',
      principal: false,
      native: { reviewPort: null },
      gh: input.gh,
      git: input.git,
    },
    input.exactMandateRef,
  )
}

function scopeNumber(scope: Scope): number {
  const match = /#([1-9][0-9]*)$/.exec(scope.target)
  return match === null ? 0 : Number(match[1])
}

function asHistory(value: unknown): History | null {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.source.scope) || !Array.isArray(value.operations))
    return null
  if (typeof value.source.scope.repository !== 'string' || typeof value.source.scope.target !== 'string') return null
  return value as History
}

function historyForScope(histories: readonly unknown[], scope: Scope): History | null {
  for (const history of histories) {
    const parsed = asHistory(history)
    if (parsed?.source.scope.repository === scope.repository && parsed.source.scope.target === scope.target)
      return parsed
  }
  return null
}

function boundEnds(binding: { kind: string; payload: unknown }): { branch: string; base: string } | null {
  if (binding.kind !== 'workflow-binding' || !isRecord(binding.payload)) return null
  const branch = binding.payload.branch
  const base = binding.payload.base
  if (typeof branch !== 'string' || branch.length === 0 || typeof base !== 'string' || base.length === 0) return null
  return { branch, base }
}

async function discoverDeliveryPr(
  gh: Gh,
  cwd: string,
  head: string,
  base: string,
): Promise<{ ok: true; number: number | null } | { ok: false; reason: string }> {
  let raw: string
  try {
    raw = await gh(cwd, [
      'pr',
      'list',
      '--head',
      head,
      '--base',
      base,
      '--state',
      'all',
      '--limit',
      '30',
      '--json',
      'number,isCrossRepository,state',
    ])
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'pr-discovery-failed' }
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'pr-discovery-unreadable' }
  }
  if (!Array.isArray(data)) return { ok: false, reason: 'pr-discovery-unreadable' }
  if (data.length >= 30) return { ok: false, reason: 'pr-discovery-incomplete' }
  const same: { number: number; state: string }[] = []
  for (const entry of data) {
    if (
      !isRecord(entry) ||
      typeof entry.isCrossRepository !== 'boolean' ||
      typeof entry.number !== 'number' ||
      !Number.isInteger(entry.number) ||
      entry.number <= 0 ||
      (entry.state !== 'OPEN' && entry.state !== 'MERGED' && entry.state !== 'CLOSED')
    ) {
      return { ok: false, reason: 'pr-discovery-unreadable' }
    }
    if (!entry.isCrossRepository) same.push({ number: entry.number, state: entry.state })
  }
  if (same.length > 1) return { ok: false, reason: 'pr-discovery-ambiguous' }
  if (same[0]?.state === 'CLOSED') return { ok: false, reason: 'pr-discovery-closed' }
  return { ok: true, number: same[0]?.number ?? null }
}

async function explicitParentHistories(
  loaded: Contracts,
  mandate: History['operations'][number]['record'] | null,
  options: { cwd: string; gh?: Gh },
): Promise<{ ok: true; parents: History[] } | { ok: false; reason: string }> {
  const parents: History[] = []
  const seen = new Set<string>()
  let cursor: unknown = mandate === null ? null : payload(mandate).parent
  while (cursor !== null && cursor !== undefined) {
    if (
      !isRecord(cursor) ||
      !isRecord(cursor.scope) ||
      typeof cursor.scope.repository !== 'string' ||
      typeof cursor.scope.target !== 'string' ||
      typeof cursor.recordId !== 'string'
    ) {
      return { ok: false, reason: 'parent-grant-unreadable' }
    }
    const recordId = cursor.recordId
    const parentScope = { repository: cursor.scope.repository, target: cursor.scope.target }
    const key = `${parentScope.repository}\0${parentScope.target}\0${recordId}`
    if (seen.has(key)) return { ok: false, reason: 'parent-grant-cycle' }
    seen.add(key)
    const read = await loaded.readComposedWorkflowHistory([parentScope], options)
    if (!read.ok || !read.histories[0]) return { ok: false, reason: read.ok ? 'parent-grant-missing' : read.reason }
    parents.push(read.histories[0])
    const record = read.histories[0].operations.find(
      (operation) => operation.record?.recordId === recordId && operation.record.kind === 'mandate',
    )?.record
    cursor = record == null ? null : payload(record).parent
  }
  return { ok: true, parents }
}

async function mandateParentHistories(
  loaded: Contracts,
  history: History,
  options: { cwd: string; gh?: Gh },
): Promise<{ ok: true; parents: History[] } | { ok: false; reason: string }> {
  const parents: History[] = []
  for (const mandate of mandatesInHistory(history)) {
    const resolved = await explicitParentHistories(loaded, mandate, options)
    if (!resolved.ok) return resolved
    for (const parent of resolved.parents) {
      if (
        parents.some(
          (known) =>
            known.source.scope.repository === parent.source.scope.repository &&
            known.source.scope.target === parent.source.scope.target,
        )
      )
        continue
      parents.push(parent)
    }
  }
  return { ok: true, parents }
}

async function assembleChantier(
  loaded: Contracts,
  target: { status: 'issue' | 'pull-request'; scope: Scope },
  primary: History,
  mandate: History['operations'][number]['record'] | null,
  options: { cwd: string; gh: Gh },
): Promise<{ ok: true; evidence: WorkflowEvidence; delivery: Delivery | null } | { ok: false; reason: string }> {
  const policy = withRoxabiGitHubPolicy({ cwd: options.cwd, gh: options.gh })
  if (mandateRoleOf(mandate) === 'epic') {
    const granted = await explicitParentHistories(loaded, mandate, options)
    if (!granted.ok) return granted
    const composed = loaded.composeChantier({ issue: primary, pullRequest: null, parents: granted.parents })
    return composed.ok
      ? { ok: true, evidence: composed.value, delivery: null }
      : { ok: false, reason: composed.diagnostics[0]?.code ?? 'incomplete' }
  }
  if (target.status === 'pull-request') {
    const bound = await readWorkflowBinding(target.scope, policy)
    if (!bound.ok) return { ok: false, reason: bound.status === 'absent' ? 'binding-missing' : bound.status }
    const issue = asHistory(bound.value.history)
    const pullRequest = historyForScope(bound.value.histories, target.scope)
    if (issue === null || pullRequest === null) return { ok: false, reason: 'binding-incomplete' }
    const parents: History[] = []
    for (const parentScope of bound.value.parentScopes) {
      const parent = historyForScope(bound.value.histories, parentScope)
      if (parent === null) return { ok: false, reason: 'parent-grant-missing' }
      parents.push(parent)
    }
    const head = bound.value.observed.head
    const ends = boundEnds(bound.value.binding)
    if (!/^[0-9a-f]{40}$/.test(head) || ends === null) return { ok: false, reason: 'native-metadata-unreadable' }
    const delivery: Delivery = {
      number: scopeNumber(target.scope),
      scope: target.scope,
      head,
      branch: ends.branch,
      base: ends.base,
      history: pullRequest,
      issueScope: issue.source.scope,
    }
    if (delivery.number === 0) return { ok: false, reason: 'binding-incomplete' }
    const composed = loaded.composeChantier({ issue, pullRequest, parents })
    return composed.ok
      ? { ok: true, evidence: composed.value, delivery }
      : { ok: false, reason: composed.diagnostics[0]?.code ?? 'incomplete' }
  }
  const granted = await explicitParentHistories(loaded, mandate, options)
  if (!granted.ok) return granted
  let pullRequest: History | null = null
  let delivery: Delivery | null = null
  const branch = mandate === null ? null : payload(mandate).branch
  const base = mandate === null ? null : payload(mandate).base
  if (typeof branch === 'string' && branch.length > 0 && typeof base === 'string' && base.length > 0) {
    const discovered = await discoverDeliveryPr(options.gh, options.cwd, branch, base)
    if (!discovered.ok) return discovered
    if (discovered.number !== null) {
      const prScope = loaded.githubScope(target.scope.repository, discovered.number)
      const bound = await readWorkflowBinding(prScope, policy)
      if (bound.ok) {
        const labelled = historyForScope(bound.value.histories, prScope)
        if (labelled === null) return { ok: false, reason: 'binding-incomplete' }
        const head = bound.value.observed.head
        const ends = boundEnds(bound.value.binding)
        if (!/^[0-9a-f]{40}$/.test(head) || ends === null) return { ok: false, reason: 'native-metadata-unreadable' }
        pullRequest = labelled
        delivery = {
          number: discovered.number,
          scope: prScope,
          head,
          branch: ends.branch,
          base: ends.base,
          history: labelled,
          issueScope: primary.source.scope,
        }
        for (const parentScope of bound.value.parentScopes) {
          const parent = historyForScope(bound.value.histories, parentScope)
          if (parent === null) return { ok: false, reason: 'parent-grant-missing' }
          if (
            !granted.parents.some(
              (item) =>
                item.source.scope.repository === parent.source.scope.repository &&
                item.source.scope.target === parent.source.scope.target,
            )
          ) {
            granted.parents.push(parent)
          }
        }
      } else if (bound.status === 'absent') {
        const prHistory = await loaded.readComposedWorkflowHistory([prScope], options)
        if (!prHistory.ok || !prHistory.histories[0])
          return { ok: false, reason: prHistory.ok ? 'incomplete' : prHistory.reason }
        let native: Awaited<ReturnType<typeof readNativePullRequestFacts>>
        try {
          native = await readNativePullRequestFacts(prScope.repository, discovered.number, policy)
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : 'native-metadata-unreadable' }
        }
        pullRequest = prHistory.histories[0]
        delivery = {
          number: discovered.number,
          scope: prScope,
          head: native.head,
          branch: native.branch,
          base: native.base,
          history: prHistory.histories[0],
          issueScope: primary.source.scope,
        }
      } else {
        return { ok: false, reason: bound.status }
      }
    }
  }
  const composed = loaded.composeChantier({ issue: primary, pullRequest, parents: granted.parents })
  return composed.ok
    ? { ok: true, evidence: composed.value, delivery }
    : { ok: false, reason: composed.diagnostics[0]?.code ?? 'incomplete' }
}

async function readDecodedHistory(
  scope: Scope,
  cwd: string,
  gh: Gh,
): Promise<{ ok: true; history: DecodedHistory } | { ok: false; reason: string }> {
  const contracts = await import('../dist/contracts.js')
  const read = await contracts.readComposedWorkflowHistory([scope], withRoxabiGitHubPolicy({ cwd, gh }))
  if (!read.ok) return { ok: false, reason: read.reason }
  const history = read.histories[0]
  if (history === undefined) return { ok: false, reason: 'incomplete' }
  return { ok: true, history }
}

async function proofSelectorFor(input: {
  cwd: string
  repository: string
  delivery: Delivery | null
  git: GitRunner
  gh: Gh
}): Promise<{ ok: true; selector: ProofSelector } | { ok: false; reason: string }> {
  let baseTip: string | null = null
  if (input.delivery !== null) {
    const refreshed = await refreshSelectedBase(input.cwd, input.delivery.base, input.git, input.gh)
    if (!refreshed.ok) return { ok: false, reason: refreshed.error }
    baseTip = refreshed.tip
  }
  const decoded = input.delivery === null ? null : await readDecodedHistory(input.delivery.scope, input.cwd, input.gh)
  if (decoded !== null && !decoded.ok) return decoded
  const readiness = await readProofReadiness({
    cwd: input.cwd,
    repository: input.delivery?.scope.repository ?? input.repository,
    pr: input.delivery?.number ?? null,
    candidate: input.delivery?.head ?? null,
    base: input.delivery?.base ?? null,
    baseTip,
    history: decoded?.ok === true ? decoded.history : null,
    git: input.git,
    gh: input.gh,
  })
  if (readiness.status === 'unusable') return { ok: false, reason: readiness.reason }
  return { ok: true, selector: readiness.selector }
}

async function preserveSuccessorBinding(input: {
  loaded: Contracts
  gh: Gh
  cwd: string
  issueHistory: History
  successorId: string
  successorScope: Scope
  antecedentRecordId: string
  branch: string
  base: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const discovered = await discoverDeliveryPr(input.gh, input.cwd, input.branch, input.base)
  if (!discovered.ok) return discovered
  if (discovered.number === null) return { ok: true }
  const prScope = input.loaded.githubScope(input.successorScope.repository, discovered.number)
  const read = await input.loaded.readComposedWorkflowHistory([prScope], { cwd: input.cwd, gh: input.gh })
  if (!read.ok || !read.histories[0]) return { ok: false, reason: read.ok ? 'binding-incomplete' : read.reason }
  const prHistory = read.histories[0]
  const bindings = prHistory.operations.flatMap((operation) => {
    const record = operation.record
    const mandate = record?.payload.mandate
    if (
      operation.status !== 'complete' ||
      record?.kind !== 'workflow-binding' ||
      !isRecord(mandate) ||
      typeof mandate.recordId !== 'string'
    ) {
      return []
    }
    return [mandate.recordId]
  })
  if (bindings.includes(input.successorId)) return { ok: true }
  const namesAntecedent = bindings.includes(input.antecedentRecordId)
  if (bindings.some((id) => id !== input.antecedentRecordId && id !== input.successorId)) {
    return { ok: false, reason: 'binding-conflict' }
  }
  if (bindings.length > 0 && !namesAntecedent) return { ok: false, reason: 'binding-conflict' }
  const recordId = `workflow-binding:${prScope.target}:${input.successorId}`
  return publishRecord(
    input.loaded,
    prHistory,
    {
      repository: prScope.repository,
      target: prScope.target,
      version: 1,
      recordId,
      runId: recordId,
      operationId: recordId,
      kind: 'workflow-binding',
      payload: {
        mandate: { scope: input.successorScope, recordId: input.successorId, kind: 'mandate' },
        branch: input.branch,
        base: input.base,
      },
    },
    input.gh,
    input.cwd,
    [input.issueHistory],
  )
}

/**
 * Installed /feature continuation. The engine is the only authority for the
 * next action. Principal prepares a checkout and publishes nothing new.
 */
export async function continueFeature(input: ContinueFeatureInput): Promise<FeatureContinuation> {
  return continueFeatureAtTarget(input)
}

async function continueFeatureAtTarget(
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
): Promise<FeatureContinuation> {
  if (exactMandateRef === undefined && !issueReference(input.reference)) {
    if (input.control === 'pause' || input.control === 'abandon') {
      return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
    }
    return { kind: 'operator-decision', reason: 'needs-framing' }
  }
  const git = input.git ?? defaultGit()
  const gh = input.gh ?? defaultGh()
  const identity = await sessionWorktreeIdentity(git, input.cwd)
  // Real Git principal/worktree identity gates dispatch. Caller principal is advisory only.
  const onPrincipal = identity.ok ? identity.onPrincipal : input.principal === true
  const loaded = await loadContracts()
  if ('missing' in loaded) {
    if (input.control === 'pause' || input.control === 'abandon') {
      await disarmUnresolved(gh, input.cwd, input.reference)
      return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
    }
    return { kind: 'blocked', reason: `engine-unavailable:${loaded.missing}` }
  }
  const options = { cwd: input.cwd, gh }
  const target =
    exactMandateRef === undefined
      ? await loaded.resolveNativeTarget(input.reference, options)
      : await loaded.resolveNativeScope(exactMandateRef.scope, options)
  if (!isResolvedTarget(target)) {
    return { kind: 'blocked', reason: target.status }
  }
  if (
    exactMandateRef !== undefined &&
    (exactMandateRef.kind !== 'mandate' ||
      target.scope.repository !== exactMandateRef.scope.repository ||
      target.scope.target !== exactMandateRef.scope.target)
  ) {
    return { kind: 'blocked', reason: 'exact-mandate-scope' }
  }
  if (exactMandateRef !== undefined) {
    try {
      const raw = await gh(input.cwd, ['repo', 'view', '--json', 'nameWithOwner'])
      const current = JSON.parse(raw) as unknown
      if (
        !isRecord(current) ||
        typeof current.nameWithOwner !== 'string' ||
        current.nameWithOwner !== exactMandateRef.scope.repository
      ) {
        return { kind: 'blocked', reason: 'repository-mismatch' }
      }
    } catch {
      return { kind: 'blocked', reason: 'repository-unreadable' }
    }
  }
  let scope = target.scope
  if (target.status === 'pull-request') {
    const bound = await readWorkflowBinding(scope, withRoxabiGitHubPolicy({ cwd: input.cwd, gh }))
    if (!bound.ok) {
      if (input.control === 'pause' || input.control === 'abandon') {
        await disarmKnownTarget(gh, input.cwd, target, null)
        return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
      }
      return { kind: 'blocked', reason: bound.status === 'absent' ? 'binding-missing' : bound.status }
    }
    const issueHistory = asHistory(bound.value.history)
    if (issueHistory === null) return { kind: 'blocked', reason: 'binding-incomplete' }
    scope = issueHistory.source.scope
  }
  if (
    exactMandateRef !== undefined &&
    (scope.repository !== exactMandateRef.scope.repository || scope.target !== exactMandateRef.scope.target)
  ) {
    return { kind: 'blocked', reason: 'exact-mandate-scope' }
  }
  const key = inhibitKey(scope)
  if (input.control === 'pause' || input.control === 'abandon') {
    inhibited.set(key, input.control === 'pause' ? 'pause' : 'abandon')
  }
  const composed = await loaded.readComposedWorkflowHistory([scope], options)
  if ((input.control === 'pause' || input.control === 'abandon') && !composed.ok) {
    await disarmKnownTarget(gh, input.cwd, target, null)
    return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  if (!composed.ok) return { kind: 'blocked', reason: composed.reason }
  let history = composed.histories[0]
  if ((input.control === 'pause' || input.control === 'abandon') && !history) {
    await disarmKnownTarget(gh, input.cwd, target, null)
    return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  if (!history) return { kind: 'blocked', reason: 'incomplete' }
  // A child mandate's parent is authoritative workflow context, not tracker
  // ancestry. Load it before every applicability decision or publication.
  const explicitParents = await mandateParentHistories(loaded, history, options)
  if (!explicitParents.ok) {
    if (input.control === 'pause' || input.control === 'abandon') {
      // Parent provenance is unavailable, but every locally authored mandate
      // still supplies a conservative branch discovery path for disarming.
      for (const mandate of mandatesInHistory(history)) {
        await disarmKnownTarget(gh, input.cwd, target, mandateRoleOf(mandate), mandateBranch(mandate))
      }
      await disarmKnownTarget(gh, input.cwd, target, null)
      return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
    }
    return { kind: 'blocked', reason: explicitParents.reason }
  }
  let parentHistories = explicitParents.parents
  let selection = loaded.selectApplicableMandate(history, parentHistories)
  // A concurrent/session-end pause may already be durably confirmed for this
  // mandate. Canonical pause bindings prevent an ancestor acknowledgement.
  if (exactMandateRef === undefined && input.control === 'pause' && bindsOwnPause(loaded, selection, history, scope)) {
    return { kind: 'paused', confirmed: true, reason: 'paused' }
  }
  if (exactMandateRef !== undefined) {
    if (selection.status !== 'applicable') {
      return { kind: 'blocked', reason: `exact-mandate-${selection.reason}` }
    }
    if (selection.mandate === null || selection.mandate.recordId !== exactMandateRef.recordId) {
      return { kind: 'blocked', reason: 'exact-mandate-not-applicable' }
    }
  }
  if (input.control === 'abandon' || input.control === 'pause') {
    const pausedOwnMandateId =
      input.control === 'abandon' &&
      selection.status === 'refused' &&
      selection.reason === 'paused' &&
      bindsOwnPause(loaded, selection, history, scope)
        ? selection.pause.mandate.recordId
        : null
    const pausedOwnMandate =
      pausedOwnMandateId === null
        ? null
        : (mandatesInHistory(history).find((candidate) => candidate.recordId === pausedOwnMandateId) ?? null)
    const mandate = selection.status === 'applicable' ? selection.mandate : pausedOwnMandate
    if (mandate === null) {
      await disarmKnownTarget(gh, input.cwd, target, null)
      return { kind: 'blocked', reason: input.control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
    }
    const mandateRole = mandateRoleOf(mandate)
    const branch = mandateBranch(mandate)
    const mandateReference = { scope: history.source.scope, recordId: mandate.recordId, kind: 'mandate' as const }
    if (input.control === 'abandon') {
      const published = await publishRecord(
        loaded,
        history,
        {
          repository: scope.repository,
          target: scope.target,
          version: 1,
          recordId: randomUUID(),
          runId: randomUUID(),
          operationId: randomUUID(),
          kind: 'operator-control',
          payload: {
            control: 'abandon',
            controlId: randomUUID(),
            predecessor: null,
            mandate: mandateReference,
          },
        },
        gh,
        input.cwd,
        parentHistories,
      )
      await disarmKnownTarget(gh, input.cwd, target, mandateRole, branch)
      if (!published.ok) return { kind: 'abandoned', confirmed: false }
      const reread = await loaded.readComposedWorkflowHistory([scope], options)
      const seen = reread.ok
        ? reread.histories[0]?.operations.some((operation) => {
            const record = operation.record
            return (
              operation.status === 'complete' &&
              record?.kind === 'operator-control' &&
              payload(record).control === 'abandon'
            )
          }) === true
        : false
      return { kind: 'abandoned', confirmed: seen }
    }
    return publishConfirmedPause({
      loaded,
      history,
      scope,
      target,
      gh,
      cwd: input.cwd,
      parentHistories,
      mandate: mandateReference,
      role: mandateRole,
      branch,
      options,
    })
  }
  const number = scopeNumber(scope)
  if (number === 0) return { kind: 'blocked', reason: 'issue-unreadable' }
  const issue = await readIssue(gh, input.cwd, scope.repository, number)
  if (!issue) return { kind: 'blocked', reason: 'issue-unreadable' }
  const sessionCwd = identity.ok ? identity.sessionTop : null
  const intendedBranch = branchFor({ number, title: issue.title, labels: issue.labels })

  // `/feature new #N`: explicit successor over an intact abandoned/revoked mandate.
  if (
    input.control === 'new' &&
    selection.status === 'refused' &&
    (selection.reason === 'abandoned' || selection.reason === 'revoked')
  ) {
    if (onPrincipal || sessionCwd === null) {
      const resolvedBase = await resolveBase(git, identity.ok ? identity.principalTop : input.cwd)
      if ('reason' in resolvedBase) return { kind: 'blocked', reason: resolvedBase.reason }
      const base = resolvedBase.base
      const prepared = await prepareFeatureCheckout({
        git,
        sessionCwd: input.cwd,
        branch: intendedBranch,
        base,
        repository: scope.repository,
        detached: false,
      })
      if (prepared.status === 'blocked') return { kind: 'blocked', reason: prepared.reason }
      if (prepared.status === 'move') {
        const move = linkedMove(input.cwd, prepared.path)
        if (move) return move
      }
    }
    const boot = await runWorktreeBootstrap(input.cwd)
    if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
    const succession = await publishSuccessorMandate({
      loaded,
      history,
      scope,
      issue,
      number,
      git,
      gh,
      cwd: input.cwd,
      parents: parentHistories,
    })
    if (!succession.ok) return { kind: 'blocked', reason: succession.reason }
    const refreshed = await loaded.readComposedWorkflowHistory([scope], options)
    if (!refreshed.ok || !refreshed.histories[0]) return { kind: 'blocked', reason: 'successor-unconfirmed' }
    history = refreshed.histories[0]
    const refreshedParents = await mandateParentHistories(loaded, history, options)
    if (!refreshedParents.ok) return { kind: 'blocked', reason: refreshedParents.reason }
    parentHistories = refreshedParents.parents
    selection = loaded.selectApplicableMandate(history, parentHistories)
    if (selection.status !== 'applicable') {
      return {
        kind: 'blocked',
        reason: `successor-${selection.status === 'refused' ? selection.reason : 'unconfirmed'}`,
      }
    }
  }

  if (selection.status === 'refused' && selection.reason === 'missing' && input.control === 'select') {
    if (!hasScope({ labels: issue.labels, body: issue.body })) {
      return { kind: 'operator-decision', reason: 'needs-scope' }
    }
    // Always validate intended worktree before the first mandate/binding/start.
    {
      const resolvedBase = await resolveBase(git, identity.ok ? identity.principalTop : input.cwd)
      if ('reason' in resolvedBase) return { kind: 'blocked', reason: resolvedBase.reason }
      const base = resolvedBase.base
      const prepared = await prepareFeatureCheckout({
        git,
        sessionCwd: input.cwd,
        branch: intendedBranch,
        base,
        repository: scope.repository,
        detached: false,
      })
      if (prepared.status === 'blocked') return { kind: 'blocked', reason: prepared.reason }
      if (prepared.status === 'move') {
        const move = linkedMove(input.cwd, prepared.path)
        if (move) return move
      }
      if (prepared.status !== 'ready') return { kind: 'blocked', reason: 'session-not-intended-worktree' }
    }
    const boot = await runWorktreeBootstrap(input.cwd)
    if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
    const published = await publishFirstMandate(loaded, history, scope, issue, number, git, gh, input.cwd)
    if (!published.ok) return { kind: 'blocked', reason: published.reason, diagnostics: published.diagnostics }
    const refreshed = await loaded.readComposedWorkflowHistory([scope], options)
    if (refreshed.ok && refreshed.histories[0]) history = refreshed.histories[0]
  } else if (
    (input.control === 'select' || input.control === 'resume' || input.control === 'new') &&
    !onPrincipal &&
    sessionCwd !== null
  ) {
    // Declared worktree setup is a delivery prerequisite after /move.
    const boot = await runWorktreeBootstrap(input.cwd)
    if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
  } else if (onPrincipal && (input.control === 'select' || input.control === 'resume' || input.control === 'new')) {
    const resolvedBase = await resolveBase(git, identity.ok ? identity.principalTop : input.cwd)
    if ('reason' in resolvedBase) return { kind: 'blocked', reason: resolvedBase.reason }
    const base = resolvedBase.base
    const prepared = await prepareFeatureCheckout({
      git,
      sessionCwd: input.cwd,
      branch: intendedBranch,
      base,
      repository: scope.repository,
      detached: false,
    })
    if (prepared.status === 'blocked') return { kind: 'blocked', reason: prepared.reason }
    if (prepared.status === 'move') {
      const move = linkedMove(input.cwd, prepared.path)
      if (move) return move
    }
    if (prepared.status !== 'ready') return { kind: 'blocked', reason: 'session-not-intended-worktree' }
    const boot = await runWorktreeBootstrap(input.cwd)
    if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
  }
  const applicable =
    exactMandateRef === undefined ? loaded.selectApplicableMandate(history, parentHistories) : selection
  const mandate = applicable.status === 'applicable' ? applicable.mandate : null
  const mandateRef =
    exactMandateRef ?? (mandate === null ? null : { scope, recordId: mandate.recordId, kind: 'mandate' as const })
  const assembled = await assembleChantier(loaded, target, history, mandate, { cwd: input.cwd, gh })
  if (!assembled.ok) return { kind: 'blocked', reason: assembled.reason }
  const evidence = assembled.evidence
  const delivery = assembled.delivery
  const issueHistory = evidence.issue
  const head = delivery?.head ?? null
  let proofPins: Awaited<ReturnType<typeof readProofConfigPins>> = []
  if (head !== null) {
    try {
      proofPins = await readProofConfigPins(git, input.cwd, head)
    } catch (error) {
      return { kind: 'blocked', reason: error instanceof Error ? error.message : 'proof-pin-unreadable' }
    }
  }
  const effectiveRequirements =
    mandate !== null && isRecord(mandate.payload.config)
      ? additionalRequirementsOf(mandate.payload.config.effective)
      : []
  const effectiveConfig = effectiveWorkflowConfig(loaded.shippedProductVersion(), effectiveRequirements)
  const merged = delivery === null ? false : await pullRequestMerged(gh, input, delivery.number)
  const ordinaryMergedDelivery =
    merged && mandateRoleOf(mandate) === 'feature' && !isRecord(mandate === null ? null : payload(mandate).parent)
  const facts = {
    specDigest: loaded.specDigest(issue.body),
    specBody: issue.body,
    branch: delivery?.branch ?? null,
    base: delivery?.base ?? null,
    candidateGitSHA: head,
    lineageHead: head,
    pullRequest:
      delivery === null
        ? null
        : {
            scope: delivery.scope,
            head: delivery.head,
            base: delivery.base,
            associatedIssue: delivery.issueScope,
          },
    merged,
    sessionCwd: onPrincipal ? null : sessionCwd,
    preparedWorktree: onPrincipal ? null : sessionCwd,
    productVersion: loaded.shippedProductVersion(),
    configVersion: WORKFLOW_CONFIG_VERSION,
    configDigest: configPinDigest(effectiveConfig),
    supportedConfigVersions: SUPPORTED_CONFIG_VERSIONS,
    proofPins,
    explicitSelection: input.control === 'select' || input.control === 'new',
    explicitResume: input.control === 'resume',
    successorAntecedent: null,
    endObligationsMet: ordinaryMergedDelivery,
    localInhibit: inhibited.get(key) ?? null,
    failedChecks: null as string[] | null,
    evidenceDigest: null as string | null,
  }
  const ciWatchStatus = delivery === null ? null : await currentCiWatchStatus(gh, input.cwd, delivery.number)
  let liveCi: NativeCiEvidence | null = null
  if (!merged && delivery !== null && head !== null && ciWatchStatus === 'red') {
    liveCi = await readNativeCiFailureEvidence(input.cwd, delivery.scope.repository, head, delivery.scope, {
      gh,
      failedCheckEvidenceDigest: loaded.failedCheckEvidenceDigest,
    })
    if (!liveCi.ok) return { kind: 'blocked', reason: liveCi.reason }
    facts.failedChecks = liveCi.failedChecks
    facts.evidenceDigest = liveCi.evidenceDigest
  }
  const canonicalReview =
    delivery !== null && head !== null
      ? await currentReviewStep(input.cwd, delivery.number, head, gh, ciWatchStatus === 'red')
      : null
  const review = merged && canonicalReview !== 'stop' ? null : canonicalReview
  if (!merged && delivery !== null && ciWatchStatus === 'red') {
    const gated = await classifyRedCiBeforeDispatch(input.cwd, delivery.number, gh, git)
    if (gated !== null) return gated
  }
  let epicName: SpecializedDecisions['epicStep'] = null
  if (target.status === 'issue' && mandateRoleOf(mandate) === 'epic') {
    try {
      epicName = (await epicStep(input.cwd, number)).name
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'blocked', reason: 'epic-step-failed', diagnostics: [{ code: 'epic-step-failed', message }] }
    }
  }
  const proof = merged
    ? {
        ok: true as const,
        selector: {
          admission: null,
          candidateGitSHA: null,
          input: null,
          applicability: 'not-applicable' as const,
          evidence: [],
        },
      }
    : await proofSelectorFor({
        cwd: input.cwd,
        repository: scope.repository,
        delivery,
        git,
        gh,
      })
  if (!proof.ok) return { kind: 'blocked', reason: proof.reason }
  const decisions = buildSpecializedDecisions({
    reviewStep: review,
    epicStep: epicName,
    ciWatchStatus: merged ? null : ciWatchStatus,
    pullRequestOpen: delivery !== null,
    proof: proof.selector,
  })
  const decision = loaded.reconstructWorkflow({ evidence, facts, decisions })
  if (decision.status === 'blocked' && decision.reason === 'session-cwd') {
    const mapped = moveFromEvidence(input.cwd, decision.evidence)
    if (mapped) return mapped
    return { kind: 'blocked', reason: 'session-cwd' }
  }
  if (decision.status === 'blocked' && decision.reason === 'spec-decision-required') {
    if (input.control !== 'material-decision') return { kind: 'operator-decision', reason: 'material-spec' }
    if (mandate === null) return { kind: 'blocked', reason: 'material-decision-mandate-missing' }
    const material = await handleMaterialDecision({
      decision: input.decision,
      loaded,
      history: issueHistory,
      parents: evidence.parents,
      mandate,
      issue,
      gh,
      cwd: input.cwd,
    })
    if (material.kind !== 'accepted') return material
    return continueFeatureAtTarget({ ...input, control: 'resume', decision: undefined }, exactMandateRef)
  }
  if (decision.status === 'blocked') return { kind: 'blocked', reason: decision.reason, diagnostics: decision.evidence }
  if (decision.status === 'paused') return { kind: 'paused', confirmed: true, reason: 'paused' }
  if (decision.status === 'abandoned') {
    const seen = issueHistory.operations.some((operation) => {
      const record = operation.record
      return (
        operation.status === 'complete' && record?.kind === 'operator-control' && payload(record).control === 'abandon'
      )
    })
    return { kind: 'abandoned', confirmed: seen }
  }
  if (decision.status === 'terminal')
    return { kind: 'terminal', reason: decision.reason, diagnostics: decision.evidence }
  if (input.control === 'material-decision') return { kind: 'blocked', reason: 'material-decision-not-pending' }
  if (mandateRoleOf(mandate) === 'feature' && actionRequiresFeatureCheckout(decision.action)) {
    if (mandate === null) return { kind: 'blocked', reason: 'mandate-missing' }
    const checkout = await requireMandateCheckout({ cwd: input.cwd, git, scope, mandate })
    if (checkout !== null) return checkout
  }
  if (decision.action === 'plan') {
    if (mandate === null) return { kind: 'blocked', reason: 'mandate-missing' }
    return planAction(loaded, evidence, issueHistory, issue.body, gh, input.cwd, scope, mandate)
  }
  if (decision.action === 'implement') {
    if (mandate === null) return { kind: 'blocked', reason: 'mandate-missing' }
    return startImplement(loaded, evidence, issueHistory, scope, issue, git, gh, input.cwd, mandate)
  }
  if (decision.action === 'assess-spec') {
    if (mandate === null) return { kind: 'blocked', reason: 'mandate-missing' }
    return startModelReceiptAction({
      action: 'assess-spec',
      loaded,
      history: issueHistory,
      mandate,
      evidence,
      scope,
      issue,
      target,
      gh,
      cwd: input.cwd,
    })
  }
  if (decision.action === 'attribute-ci') {
    if (delivery === null || mandate === null)
      return { kind: 'blocked', reason: 'ci-attribution-requires-pull-request' }
    return startModelReceiptAction({
      action: 'attribute-ci',
      loaded,
      history: delivery.history,
      mandateHistory: issueHistory,
      mandate,
      evidence,
      scope: delivery.scope,
      issue,
      target: {
        status: 'pull-request',
        scope: delivery.scope,
        pullRequest: { pr: delivery.number, head: delivery.head, base: delivery.base, branch: delivery.branch },
      },
      gh,
      cwd: input.cwd,
    })
  }
  if (decision.action === 'frame') return { kind: 'operator-decision', reason: 'needs-scope' }
  if (decision.action === 'publish') {
    if (mandate === null) return { kind: 'blocked', reason: 'mandate-missing' }
    return openPullRequestAfterRemoteProof(
      issueHistory,
      input.reference,
      issue,
      number,
      git,
      gh,
      input.cwd,
      mandate,
      exactMandateRef,
    )
  }
  if (decision.action === 'review') {
    return reviewAfterBinding(loaded, issueHistory, delivery, evidence.parents)
  }
  if (decision.action === 'stop' || decision.action === 'done') return { kind: 'terminal', reason: decision.action }
  if (decision.action === 'fix') {
    if (delivery === null) return { kind: 'blocked', reason: 'ci-attribution-requires-pull-request' }
    const admitted = await tryAdmittedCiCorrectionContinuation({
      cwd: input.cwd,
      history: delivery.history,
      mandateHistory: issueHistory,
      parents: evidence.parents,
      scope: delivery.scope,
      head: delivery.head,
      branch: delivery.branch,
      base: delivery.base,
      pr: delivery.number,
      gh,
      ciFailed: facts.failedChecks !== null,
      resolveAcceptedSpec: loaded.resolveAcceptedSpec,
      selectApplicableMandate: loaded.selectApplicableMandate,
    })
    if (admitted !== null) return admitted
    if (facts.failedChecks !== null) return { kind: 'blocked', reason: 'ci-attribution-unconfirmed' }
    return { kind: 'fix', reference: input.reference }
  }
  return runGraphAction(decision.action, {
    loaded,
    history: issueHistory,
    evidence,
    scope,
    issue,
    number,
    git,
    gh,
    cwd: input.cwd,
    reference: input.reference,
    target,
    delivery,
    ciFailed: facts.failedChecks !== null,
    exactMandateRef,
    mandateRef,
    pause: decision.action === 'resume' ? decision.pause : undefined,
  })
}

async function resolveBase(git: GitRunner, principal: string): Promise<{ base: string } | { reason: string }> {
  const shown = await git(principal, ['show', 'HEAD:.dev/stack.yml'])
  if (shown.code !== 0) return { reason: 'base-unreadable' }
  const parsed: unknown = Bun.YAML.parse(shown.stdout)
  const remote = await git(principal, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const fallback = remote.stdout.trim().replace(/^origin\//, '')
  const resolved = baseFromStack(parsed, () => fallback)
  return 'error' in resolved ? { reason: resolved.error } : { base: resolved.base }
}

async function publishSuccessorMandate(input: {
  loaded: Contracts
  history: History
  scope: Scope
  issue: { title: string; body: string; labels: string[]; updatedAt: string }
  number: number
  git: GitRunner
  gh: Gh
  cwd: string
  parents: readonly History[]
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const antecedent = successionAntecedent(input.history)
  if ('reason' in antecedent) return { ok: false, reason: antecedent.reason }
  const productVersion = input.loaded.shippedProductVersion()
  if (productVersion !== installedProductVersion()) return { ok: false, reason: 'config-drift' }
  const prior = antecedent.mandate.payload
  if (!isRecord(prior)) return { ok: false, reason: 'antecedent-unreadable' }
  const priorBase = typeof prior.base === 'string' ? prior.base : null
  const priorBranch = typeof prior.branch === 'string' ? prior.branch : null
  const priorParent = prior.parent === null || isRecord(prior.parent) ? prior.parent : null
  const priorRole =
    prior.role === 'feature' || prior.role === 'epic' || prior.role === 'fix-only' ? prior.role : 'feature'
  const resolvedBase = priorBase !== null ? { base: priorBase } : await resolveBase(input.git, input.cwd)
  if ('reason' in resolvedBase) return { ok: false, reason: resolvedBase.reason }
  const base = resolvedBase.base
  const branch =
    priorBranch ?? branchFor({ number: input.number, title: input.issue.title, labels: input.issue.labels })
  const head = await input.git(input.cwd, ['rev-parse', 'HEAD'])
  const lineageHead = head.code === 0 ? head.stdout.trim() : null
  let pins: Awaited<ReturnType<typeof readProofConfigPins>>
  try {
    pins = await readProofConfigPins(input.git, input.cwd, `refs/remotes/origin/${base}`)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'proof-pin-unreadable' }
  }
  const override = await input.git(input.cwd, ['show', `refs/remotes/origin/${base}:.dev/stack.yml`])
  const parsed = parseWorkflowOverride(override.code === 0 ? override.stdout : null)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const effective = effectiveWorkflowConfig(productVersion, parsed.additionalRequirements)
  const shared = {
    branch,
    base,
    lineageHead,
    config: {
      productVersion,
      version: WORKFLOW_CONFIG_VERSION,
      digest: configPinDigest(effective),
      effective,
    },
    proofPins: pins,
    parent: priorParent,
    antecedent: antecedent.ref,
    spec: {
      reference: input.scope.target,
      body: input.issue.body,
      bodySha256: input.loaded.specDigest(input.issue.body),
      lastEditedAt: input.issue.updatedAt,
    },
  }
  const rolePayload =
    priorRole === 'epic'
      ? {
          role: 'epic' as const,
          ...shared,
          run: typeof prior.run === 'string' ? prior.run : null,
          children: Array.isArray(prior.children) ? prior.children : [],
          permissions: {
            landing: isRecord(prior.permissions) ? prior.permissions.landing === true : true,
            correct: isRecord(prior.permissions) ? prior.permissions.correct === true : true,
          },
        }
      : priorRole === 'fix-only'
        ? {
            role: 'fix-only' as const,
            ...shared,
            run: null,
            children: null,
            permissions: { landing: false as const, correct: true as const },
          }
        : {
            role: 'feature' as const,
            ...shared,
            run: null,
            children: null,
            permissions: { landing: true as const, correct: true as const },
          }
  if (priorRole === 'epic' && (rolePayload.run === null || !/^[a-z0-9]{8}$/.test(String(rolePayload.run)))) {
    return { ok: false, reason: 'epic-run-unreadable' }
  }
  const successorId = randomUUID()
  const controlId = randomUUID()
  const mandatePublished = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: successorId,
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'mandate',
      payload: rolePayload,
    },
    input.gh,
    input.cwd,
    input.parents,
  )
  if (!mandatePublished.ok) return { ok: false, reason: mandatePublished.reason }
  const refreshed = await input.loaded.readComposedWorkflowHistory([input.scope], { cwd: input.cwd, gh: input.gh })
  if (!refreshed.ok || !refreshed.histories[0]) return { ok: false, reason: 'successor-unconfirmed' }
  const controlPublished = await publishRecord(
    input.loaded,
    refreshed.histories[0],
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'operator-control',
      payload: {
        control: 'select-successor',
        controlId,
        predecessor: antecedent.ref,
        successor: { scope: input.scope, recordId: successorId, kind: 'mandate' },
        mandate: antecedent.ref,
      },
    },
    input.gh,
    input.cwd,
    refreshed.histories.slice(1),
  )
  const bound = await preserveSuccessorBinding({
    loaded: input.loaded,
    gh: input.gh,
    cwd: input.cwd,
    issueHistory: refreshed.histories[0],
    successorId,
    successorScope: input.scope,
    antecedentRecordId: antecedent.mandate.recordId,
    branch,
    base,
  })
  if (!bound.ok) return bound
  return controlPublished.ok ? { ok: true } : { ok: false, reason: controlPublished.reason }
}

async function publishFirstMandate(
  contracts: Contracts,
  history: History,
  scope: Scope,
  issue: { title: string; body: string; labels: string[]; updatedAt: string },
  number: number,
  git: GitRunner,
  gh: Gh,
  cwd: string,
): Promise<{ ok: true } | { ok: false; reason: string; diagnostics?: readonly Diagnostic[] }> {
  const productVersion = contracts.shippedProductVersion()
  if (productVersion !== installedProductVersion()) return { ok: false, reason: 'config-drift' }
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  const lineageHead = head.code === 0 ? head.stdout.trim() : null
  const resolvedBase = await resolveBase(git, cwd)
  if ('reason' in resolvedBase) return { ok: false, reason: resolvedBase.reason }
  const base = resolvedBase.base
  let pins: Awaited<ReturnType<typeof readProofConfigPins>>
  try {
    pins = await readProofConfigPins(git, cwd, `refs/remotes/origin/${base}`)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'proof-pin-unreadable' }
  }
  const override = await git(cwd, ['show', `refs/remotes/origin/${base}:.dev/stack.yml`])
  const parsed = parseWorkflowOverride(override.code === 0 ? override.stdout : null)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const requirements = parsed.additionalRequirements
  const effective = effectiveWorkflowConfig(productVersion, requirements)
  return publishRecord(
    contracts,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'mandate',
      payload: {
        role: 'feature',
        branch: branchFor({ number, title: issue.title, labels: issue.labels }),
        base,
        lineageHead,
        config: {
          productVersion,
          version: WORKFLOW_CONFIG_VERSION,
          digest: configPinDigest(effective),
          effective,
        },
        proofPins: pins,
        parent: null,
        antecedent: null,
        spec: {
          reference: scope.target,
          body: issue.body,
          bodySha256: contracts.specDigest(issue.body),
          lastEditedAt: issue.updatedAt,
        },
        permissions: { landing: true, correct: true },
        run: null,
        children: null,
      },
    },
    gh,
    cwd,
  )
}

type ApprovedMandateContext =
  | {
      status: 'ready'
      specBody: string
      specDigest: string
      specReference: string
      chain: readonly unknown[]
      sourceRefs: readonly unknown[]
      requirements: string[]
      requirementsBlock: string
      specBlock: string
    }
  | { status: 'absent' }
  | { status: 'invalid'; reason: string; diagnostics: readonly Diagnostic[] }

/** Approved Spec via resolveAcceptedSpec + effective requirements. Never local defaults or soft fallback. */
function approvedMandateContext(
  contracts: Contracts,
  mandate: History['operations'][number]['record'] | null | undefined,
  histories: readonly History[],
): ApprovedMandateContext {
  if (mandate === null || mandate === undefined || !isRecord(mandate.payload)) return { status: 'absent' }
  const accepted = contracts.resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) {
    return {
      status: 'invalid',
      reason: accepted.reason,
      diagnostics: accepted.evidence ?? [{ code: accepted.reason, message: accepted.reason }],
    }
  }
  const config = isRecord(mandate.payload.config) ? mandate.payload.config : null
  const requirements = additionalRequirementsOf(config !== null && 'effective' in config ? config.effective : null)
  const requirementsBlock =
    requirements.length === 0
      ? 'Approved additionalRequirements: (none).'
      : `Approved additionalRequirements (mandate effective):\n${requirements.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
  return {
    status: 'ready',
    specBody: accepted.spec.body,
    specDigest: accepted.spec.digest,
    specReference: accepted.spec.reference,
    chain: accepted.spec.chain,
    sourceRefs: accepted.spec.sourceRefs,
    requirements,
    requirementsBlock,
    specBlock: [
      `Accepted Spec reference=${accepted.spec.reference}`,
      `Accepted Spec digest=${accepted.spec.digest}`,
      `Accepted Spec sourceRefs=${JSON.stringify(accepted.spec.sourceRefs)}`,
      `Accepted Spec chain=${JSON.stringify(accepted.spec.chain)}`,
      'Accepted Spec body:',
      accepted.spec.body,
      requirementsBlock,
    ].join('\n'),
  }
}

function findHistoryRecord(
  histories: readonly History[],
  kind: string,
  recordId: string,
): History['operations'][number]['record'] | null {
  for (const history of histories) {
    for (const operation of history.operations) {
      if (operation.record?.kind === kind && operation.record.recordId === recordId) {
        return operation.record
      }
    }
  }
  return null
}

/** Authoritative final plan id from the same planMacro that declared planning complete. */
function finalEligiblePlanActionId(macro: {
  phase: string
  draftActionId: string | null
  amendmentActionId: string | null
}): string | null {
  if (macro.phase !== 'eligible') return null
  return macro.amendmentActionId ?? macro.draftActionId
}

function actionReceiptResult(
  history: History,
  action: string,
  actionId: string | null,
): History['operations'][number]['record'] | null {
  if (actionId === null) return null
  for (const operation of history.operations) {
    const record = operation.record
    if (
      record?.kind === 'action-receipt' &&
      record.payload.action === action &&
      record.payload.phase === 'result' &&
      record.payload.actionId === actionId
    ) {
      return record
    }
  }
  return null
}

function planStructuredBlock(history: History, planActionId: string | null, label: string): string | null {
  const record = actionReceiptResult(history, 'plan', planActionId)
  if (record === null || !isRecord(record.payload.structured)) return null
  return `${label} actionId=${planActionId}:\n${JSON.stringify(record.payload.structured)}`
}

function planReviewOriginalsBlock(history: History, reviewActionId: string | null): string | null {
  const record = actionReceiptResult(history, 'plan-review', reviewActionId)
  if (record === null) return null
  const contributions = Array.isArray(record.payload.contributions) ? record.payload.contributions : []
  return [
    `Original plan-review actionId=${reviewActionId}`,
    `slots=${JSON.stringify(record.payload.slots ?? [])}`,
    `contributions=${JSON.stringify(contributions)}`,
  ].join('\n')
}

/** planExactSchema refs only. Requirements stay on the mandate; prompts use approvedMandateContext. */
function planExactInputs(input: {
  mandateId: string
  specDigest: string
  amendsReviewActionId: string | null
  requiredBlockers: unknown[]
}): {
  mandateId: string
  specDigest: string
  amendsReviewActionId: string | null
  requiredBlockers: unknown[]
} {
  return {
    mandateId: input.mandateId,
    specDigest: input.specDigest,
    amendsReviewActionId: input.amendsReviewActionId,
    requiredBlockers: input.requiredBlockers,
  }
}

/** planReviewExactSchema refs only. Requirements stay on the mandate; prompts use approvedMandateContext. */
function planReviewExactInputs(input: {
  mandateId: string
  specDigest: string
  planDigest: string
  draftActionId: string
}): {
  mandateId: string
  specDigest: string
  planDigest: string
  draftActionId: string
} {
  return {
    mandateId: input.mandateId,
    specDigest: input.specDigest,
    planDigest: input.planDigest,
    draftActionId: input.draftActionId,
  }
}

async function planAction(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  body: string,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: NonNullable<History['operations'][number]['record']>,
): Promise<FeatureContinuation> {
  const approved = approvedMandateContext(contracts, mandate, [history, ...evidence.parents])
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  if (approved.status !== 'ready') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  // Plan/implement consume the accepted Spec snapshot, not a live reread.
  void body
  const macro = contracts.planMacro(evidence, mandate)
  if (macro.phase === 'uncertain' || macro.phase === 'blocked') {
    return {
      kind: 'blocked',
      reason: macro.evidence[0]?.code ?? macro.phase,
      diagnostics: macro.evidence,
    }
  }
  if (macro.phase === 'needs-review') {
    if (macro.draftActionId === null) return { kind: 'blocked', reason: 'plan-review-unbound' }
    const draft = history.operations.find(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.action === 'plan' &&
        operation.record.payload.phase === 'result' &&
        operation.record.payload.actionId === macro.draftActionId,
    )?.record
    const structured = draft != null && isRecord(draft.payload.structured) ? draft.payload.structured : null
    if (structured === null || !Array.isArray(structured.steps) || !Array.isArray(structured.resolutions)) {
      return { kind: 'blocked', reason: 'plan-draft-unreadable' }
    }
    const planDigest = contracts.planDigest({
      steps: structured.steps,
      resolutions: structured.resolutions,
    })
    const operationId = randomUUID()
    const startId = randomUUID()
    const started = await publishRecord(
      contracts,
      history,
      {
        repository: scope.repository,
        target: scope.target,
        version: 1,
        recordId: startId,
        runId: randomUUID(),
        operationId,
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'plan-review',
          actionId: operationId,
          mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
          exactInputs: planReviewExactInputs({
            mandateId: mandate.recordId,
            draftActionId: macro.draftActionId,
            specDigest: contracts.specDigest(approved.specBody),
            planDigest,
          }),
          slots: [
            { slotId: 'architect', specialist: 'R-workflow-plan-architect' },
            { slotId: 'adversarial', specialist: 'R-workflow-plan-adversarial' },
          ],
        },
      },
      gh,
      cwd,
      evidence.parents,
    )
    if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
    const criteria = acceptanceCriteria(approved.specBody)
    const draftBlock = `Confirmed plan draft actionId=${macro.draftActionId}:\n${JSON.stringify(structured)}`
    const reviewTask = [
      `Review the confirmed plan draft ${macro.draftActionId}.`,
      `Acceptance criteria: ${criteria.join(' | ')}`,
      approved.specBlock,
      draftBlock,
      'Return clear or blocking blockers only. Do not implement.',
    ].join('\n')
    return {
      kind: 'action',
      node: 'plan-review',
      start: { scope, recordId: startId, kind: 'action-receipt' },
      followUp: batch(operationId, [
        {
          name: 'architect',
          agent: 'R-workflow-plan-architect',
          task: reviewTask,
        },
        {
          name: 'adversarial',
          agent: 'R-workflow-plan-adversarial',
          task: [
            `Adversarially review the confirmed plan draft ${macro.draftActionId}.`,
            `Acceptance criteria: ${criteria.join(' | ')}`,
            approved.specBlock,
            draftBlock,
            'Return clear or blocking blockers only. Do not implement.',
          ].join('\n'),
        },
      ]),
    }
  }
  if (macro.phase === 'needs-amendment') {
    const criteria = acceptanceCriteria(approved.specBody)
    const draftBlock = planStructuredBlock(history, macro.draftActionId, 'Original plan draft')
    if (draftBlock === null) return { kind: 'blocked', reason: 'plan-draft-unreadable' }
    const originals = planReviewOriginalsBlock(history, macro.reviewActionId)
    if (originals === null) return { kind: 'blocked', reason: 'plan-review-unbound' }
    const operationId = randomUUID()
    const startId = randomUUID()
    const started = await publishRecord(
      contracts,
      history,
      {
        repository: scope.repository,
        target: scope.target,
        version: 1,
        recordId: startId,
        runId: randomUUID(),
        operationId,
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'plan',
          actionId: operationId,
          mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
          exactInputs: planExactInputs({
            mandateId: mandate.recordId,
            specDigest: contracts.specDigest(approved.specBody),
            amendsReviewActionId: macro.reviewActionId,
            requiredBlockers: macro.blockers,
          }),
        },
      },
      gh,
      cwd,
      evidence.parents,
    )
    if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
    return {
      kind: 'action',
      node: 'plan',
      start: { scope, recordId: startId, kind: 'action-receipt' },
      followUp: batch(operationId, [
        {
          name: 'R-workflow-plan',
          agent: 'R-workflow-plan',
          task: [
            'Amend the plan to address every required blocker without changing the original review labels.',
            `Stable required blockers=${JSON.stringify(macro.blockers)}`,
            `Acceptance criteria: ${criteria.join(' | ')}`,
            approved.specBlock,
            draftBlock,
            originals,
            'Do not implement.',
          ].join('\n'),
        },
      ]),
    }
  }
  if (macro.phase !== 'needs-draft') {
    return { kind: 'blocked', reason: `plan-phase-${macro.phase}` }
  }
  const criteria = acceptanceCriteria(approved.specBody)
  if (criteria.length === 0) return { kind: 'operator-decision', reason: 'needs-scope' }
  const operationId = randomUUID()
  const startId = randomUUID()
  const started = await publishRecord(
    contracts,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'plan',
        actionId: operationId,
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
        exactInputs: planExactInputs({
          mandateId: mandate.recordId,
          specDigest: contracts.specDigest(approved.specBody),
          amendsReviewActionId: null,
          requiredBlockers: [],
        }),
      },
    },
    gh,
    cwd,
    evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  const reread = await contracts.readComposedWorkflowHistory([scope], { cwd, gh })
  const seen =
    reread.ok &&
    reread.histories[0]?.operations.some(
      (operation) => operation.record?.kind === 'action-receipt' && operation.record.payload.actionId === operationId,
    ) === true
  if (!seen) return { kind: 'blocked', reason: 'action-uncertain' }
  return {
    kind: 'action',
    node: 'plan',
    start: { scope, recordId: startId, kind: 'action-receipt' },
    followUp: batch(operationId, [
      {
        name: 'R-workflow-plan',
        agent: 'R-workflow-plan',
        task: [
          'Map every acceptance criterion to the code it changes and the evidence that proves it. Do not implement.',
          `Acceptance criteria: ${criteria.join(' | ')}`,
          approved.specBlock,
        ].join('\n'),
      },
    ]),
  }
}

type ModelActionInput =
  | {
      action: 'attribute-ci'
      scope: Scope
      start: ScopedRecordRef
      operationId: string
      ciEvidence: {
        evidenceDigest: string
        failures: NativeCiFailure[]
        supplied: unknown
        candidateGitSHA: string
        scope: Scope
        acceptedSemanticContext: string
      }
    }
  | {
      action: 'assess-spec'
      scope: Scope
      start: ScopedRecordRef
      operationId: string
      assessPair: {
        acceptedBody: string
        acceptedDigest: string
        currentBody: string
        currentDigest: string
      }
    }
  | {
      action: 'implement'
      scope: Scope
      start: ScopedRecordRef
      operationId: string
      approved: {
        specBlock: string
        requirementsBlock: string
        acceptanceLine?: string
      }
      planBlock: string
    }

function modelAction(input: ModelActionInput): FeatureContinuation {
  const { action, scope, start, operationId } = input
  const ciEvidence = input.action === 'attribute-ci' ? input.ciEvidence : undefined
  const approved = input.action === 'implement' ? input.approved : undefined
  const planBlock = input.action === 'implement' ? input.planBlock : undefined
  const assessPair = input.action === 'assess-spec' ? input.assessPair : undefined
  const agent =
    action === 'assess-spec'
      ? 'R-workflow-assess-spec'
      : action === 'attribute-ci'
        ? 'R-workflow-attribute-ci'
        : 'R-workflow-implement'
  const task =
    action === 'implement'
      ? [
          `Implement the confirmed plan in this worktree for ${scope.target}.`,
          approved?.acceptanceLine ?? 'Acceptance criteria: (none).',
          approved?.specBlock ?? 'Accepted Spec: (missing).',
          planBlock ?? 'Confirmed plan: (missing).',
          'Use only the accepted Spec and confirmed plan above with the mandate effective additionalRequirements; do not substitute local or current defaults.',
          'Run the changed path. Update affected docs. For a frontend or shared UI surface, record browser URL, steps, and observed result, or run the declared test_e2e command. Do not record ui-manual-only when test_e2e is declared. Stage only task-owned files. Commit with a Conventional subject ending (#N). Never git add -A, git add --all, or git add .',
        ].join('\n')
      : action === 'attribute-ci' && ciEvidence !== undefined
        ? [
            `Attribute the current CI failures for ${scope.target}.`,
            `candidateGitSHA=${ciEvidence.candidateGitSHA}`,
            `scope=${JSON.stringify(ciEvidence.scope)}`,
            `evidenceDigest=${ciEvidence.evidenceDigest}`,
            ciEvidence.acceptedSemanticContext,
            'Use only the retained native failure evidence and the approved change scope facts below. Return structured attribution only. Do not implement a repair.',
            `failures=${JSON.stringify(ciEvidence.failures)}`,
            `supplied=${JSON.stringify(ciEvidence.supplied)}`,
          ].join('\n')
        : action === 'assess-spec' && assessPair !== undefined
          ? [
              `Assess Spec change for ${scope.target}. Return only the structured classification. Do not implement a semantic repair.`,
              `acceptedDigest=${assessPair.acceptedDigest}`,
              `currentDigest=${assessPair.currentDigest}`,
              'acceptedBody:',
              JSON.stringify(assessPair.acceptedBody),
              'currentBody:',
              JSON.stringify(assessPair.currentBody),
              'Decode both JSON strings exactly; do not normalize whitespace.',
            ].join('\n')
          : `Perform the named ${action} action for ${scope.target}. Return only the structured classification. Do not implement a semantic repair.`
  return {
    kind: 'action',
    node: action,
    start,
    followUp: batch(operationId, [{ name: agent, agent, task }]),
  }
}

async function startModelReceiptAction(input: {
  action: 'assess-spec' | 'attribute-ci'
  loaded: Contracts
  history: History
  mandateHistory?: History
  mandate: NonNullable<History['operations'][number]['record']>
  evidence: WorkflowEvidence
  scope: Scope
  issue: { body: string }
  target:
    | { status: 'issue'; scope: Scope; issue: { number: number } }
    | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number; head: string; base: string; branch: string } }
  gh: Gh
  cwd: string
}): Promise<FeatureContinuation> {
  const mandateHistory = input.mandateHistory ?? input.history
  const selected = { mandate: input.mandate }
  const mandateScope = { repository: input.mandate.repository, target: input.mandate.target }
  const operationId = randomUUID()
  let exactInputs: Record<string, unknown>
  if (input.action === 'assess-spec') {
    const accepted = input.loaded.resolveAcceptedSpec(selected.mandate, [mandateHistory, ...input.evidence.parents])
    if (!accepted.ok) return { kind: 'blocked', reason: 'mandate-spec-missing' }
    exactInputs = {
      acceptedDigest: accepted.spec.digest,
      currentDigest: input.loaded.specDigest(input.issue.body),
      acceptedBody: accepted.spec.body,
      currentBody: input.issue.body,
    }
  } else {
    if (input.target.status !== 'pull-request')
      return { kind: 'blocked', reason: 'ci-attribution-requires-pull-request' }
    const evidence = await readNativeCiFailureEvidence(
      input.cwd,
      input.scope.repository,
      input.target.pullRequest.head,
      input.scope,
      {
        gh: input.gh,
        failedCheckEvidenceDigest: input.loaded.failedCheckEvidenceDigest,
      },
    )
    if (!evidence.ok) return { kind: 'blocked', reason: evidence.reason }
    exactInputs = {
      candidateGitSHA: input.target.pullRequest.head,
      scope: input.scope,
      failedChecks: evidence.failedChecks,
      evidenceDigest: evidence.evidenceDigest,
      failures: evidence.failures,
    }
    const approved = approvedMandateContext(input.loaded, selected.mandate, [mandateHistory, ...input.evidence.parents])
    // Absent Spec context may stay soft for legitimate no-pre-PR / standalone attribution.
    // Present-invalid / ambiguous Spec chain must refuse — never collapse to prose absence.
    if (approved.status === 'invalid') {
      return {
        kind: 'blocked',
        reason: `mandate-spec-${approved.reason}`,
        diagnostics: approved.diagnostics,
      }
    }
    const acceptedSemanticContext =
      approved.status === 'absent'
        ? 'Accepted semantic context: (absent — no confirmed accepted Spec for this attribution; do not invent a pre-PR plan or Spec).'
        : approved.specBlock
    const mandateIsPrimary =
      input.history.source.scope.repository === mandateHistory.source.scope.repository &&
      input.history.source.scope.target === mandateHistory.source.scope.target
    const mandateIsParent = input.evidence.parents.some(
      (history) =>
        history.source.scope.repository === mandateHistory.source.scope.repository &&
        history.source.scope.target === mandateHistory.source.scope.target,
    )
    // Attribution publishes on the PR while retaining the issue mandate as an
    // external history for canonical reference validation; it never copies it.
    const publicationParents =
      mandateIsPrimary || mandateIsParent ? input.evidence.parents : [mandateHistory, ...input.evidence.parents]
    const startId = randomUUID()
    const started = await publishRecord(
      input.loaded,
      input.history,
      {
        repository: input.scope.repository,
        target: input.scope.target,
        version: 1,
        recordId: startId,
        runId: randomUUID(),
        operationId,
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: input.action,
          actionId: operationId,
          mandate: { scope: mandateScope, recordId: selected.mandate.recordId, kind: 'mandate' },
          exactInputs,
        },
      },
      input.gh,
      input.cwd,
      publicationParents,
    )
    if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
    return modelAction({
      action: 'attribute-ci',
      scope: input.scope,
      start: { scope: input.scope, recordId: startId, kind: 'action-receipt' },
      operationId,
      ciEvidence: {
        evidenceDigest: evidence.evidenceDigest,
        failures: evidence.failures,
        supplied: evidence.supplied,
        candidateGitSHA: input.target.pullRequest.head,
        scope: input.scope,
        acceptedSemanticContext,
      },
    })
  }
  const assessExact = exactInputs as {
    acceptedBody: string
    acceptedDigest: string
    currentBody: string
    currentDigest: string
  }
  const startId = randomUUID()
  const started = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: input.action,
        actionId: operationId,
        mandate: { scope: mandateScope, recordId: selected.mandate.recordId, kind: 'mandate' },
        exactInputs,
      },
    },
    input.gh,
    input.cwd,
    input.evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  return modelAction({
    action: 'assess-spec',
    scope: input.scope,
    start: { scope: input.scope, recordId: startId, kind: 'action-receipt' },
    operationId,
    assessPair: {
      acceptedBody: assessExact.acceptedBody,
      acceptedDigest: assessExact.acceptedDigest,
      currentBody: assessExact.currentBody,
      currentDigest: assessExact.currentDigest,
    },
  })
}

export type NativeCiFailure = {
  name: string
  source: string
  observationId: string
  conclusion: string
}

export type NativeCiEvidence =
  | {
      ok: true
      failedChecks: string[]
      failures: NativeCiFailure[]
      evidenceDigest: string
      /** Full supplied rollup nodes retained for the model; not hashed as wall-clock. */
      supplied: unknown
    }
  | { ok: false; reason: string }

const CHECK_RUN_SOURCE = 'github-check-run'
const STATUS_CONTEXT_SOURCE = 'github-status-context'
const CHECK_STATUS = new Set(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'])
const CHECK_CONCLUSION = new Set([
  'action_required',
  'timed_out',
  'cancelled',
  'failure',
  'success',
  'neutral',
  'skipped',
  'startup_failure',
  'stale',
])
const RED_CI = new Set(['failure', 'timed_out', 'startup_failure'])
const STATUS_STATE = new Set(['expected', 'error', 'failure', 'pending', 'success'])
const RED_STATUS = new Set(['error', 'failure'])
const CI_PAGE = 100
const CI_PAGE_BOUND = 50

/**
 * GraphQL statusCheckRollup → engine FailedCheckFailure identity.
 * source is the frozen constant, never a suite id or context string.
 * CheckRun: source = github-check-run, observationId = CheckRun.id, name = check name.
 * StatusContext: source = github-status-context, observationId = StatusContext.id, name = context.
 * Unknown native state or conclusion refuses. Missing or malformed pageInfo, including a
 * non-boolean hasNextPage, is ci-evidence-incomplete and authorizes nothing.
 */
export async function readNativeCiFailureEvidence(
  cwd: string,
  repository: string,
  candidateGitSHA: string,
  scope: Scope,
  options?: {
    gh?: Gh
    failedCheckEvidenceDigest?: Contracts['failedCheckEvidenceDigest']
  },
): Promise<NativeCiEvidence> {
  const gh = options?.gh ?? defaultGh()
  let digest = options?.failedCheckEvidenceDigest
  if (digest === undefined) {
    const loaded = await loadContracts()
    if ('missing' in loaded) return { ok: false, reason: `engine-unavailable:${loaded.missing}` }
    digest = loaded.failedCheckEvidenceDigest
  }
  const [owner, name] = repository.split('/')
  if (!owner || !name || !/^[0-9a-f]{40}$/.test(candidateGitSHA)) {
    return { ok: false, reason: 'ci-evidence-target-unreadable' }
  }
  const query = `query($owner: String!, $name: String!, $sha: GitObjectID!, $after: String = null) {
    repository(owner: $owner, name: $name) {
      object(oid: $sha) {
        ... on Commit {
          statusCheckRollup {
            contexts(first: ${CI_PAGE}, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                __typename
                ... on CheckRun { id name status conclusion }
                ... on StatusContext { id context state }
              }
            }
          }
        }
      }
    }
  }`
  const nodes: unknown[] = []
  let after: string | null = null
  for (let page = 0; page < CI_PAGE_BOUND; page += 1) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-f',
      `sha=${candidateGitSHA}`,
    ]
    if (after !== null) args.push('-f', `after=${after}`)
    let parsed: unknown
    try {
      parsed = JSON.parse(await gh(cwd, args))
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'ci-evidence-unreadable' }
    }
    if (!isRecord(parsed) || !isRecord(parsed.data) || (Array.isArray(parsed.errors) && parsed.errors.length > 0)) {
      return { ok: false, reason: 'ci-evidence-unreadable' }
    }
    const repositoryNode = parsed.data.repository
    const objectNode = isRecord(repositoryNode) ? repositoryNode.object : null
    const rollup = isRecord(objectNode) ? objectNode.statusCheckRollup : null
    const contexts = isRecord(rollup) ? rollup.contexts : null
    const pageNodes = isRecord(contexts) && Array.isArray(contexts.nodes) ? contexts.nodes : null
    if (pageNodes === null) return { ok: false, reason: 'ci-evidence-unreadable' }
    nodes.push(...pageNodes)
    const pageInfo = isRecord(contexts) && isRecord(contexts.pageInfo) ? contexts.pageInfo : null
    if (pageInfo === null || typeof pageInfo.hasNextPage !== 'boolean') {
      return { ok: false, reason: 'ci-evidence-incomplete' }
    }
    if (pageInfo.hasNextPage !== true) break
    const cursor = typeof pageInfo?.endCursor === 'string' && pageInfo.endCursor.length > 0 ? pageInfo.endCursor : null
    if (cursor === null || cursor === after) return { ok: false, reason: 'ci-evidence-incomplete' }
    after = cursor
    if (page === CI_PAGE_BOUND - 1) return { ok: false, reason: 'ci-evidence-incomplete' }
  }
  const failures: NativeCiFailure[] = []
  for (const node of nodes) {
    if (!isRecord(node)) return { ok: false, reason: 'ci-native-identity-unknown' }
    if (node.__typename === 'StatusContext') {
      const state = typeof node.state === 'string' ? node.state.toLowerCase() : ''
      if (!STATUS_STATE.has(state)) return { ok: false, reason: 'ci-native-state-unknown' }
      if (!RED_STATUS.has(state)) continue
      const checkName = typeof node.context === 'string' && node.context.length > 0 ? node.context : null
      const observationId = typeof node.id === 'string' && node.id.length > 0 ? node.id : null
      if (checkName === null || observationId === null) return { ok: false, reason: 'ci-native-identity-unknown' }
      failures.push({ name: checkName, source: STATUS_CONTEXT_SOURCE, observationId, conclusion: state })
      continue
    }
    if (node.__typename !== 'CheckRun') return { ok: false, reason: 'ci-native-identity-unknown' }
    const status = typeof node.status === 'string' ? node.status.toLowerCase() : ''
    if (!CHECK_STATUS.has(status)) return { ok: false, reason: 'ci-native-state-unknown' }
    const rawConclusion = typeof node.conclusion === 'string' ? node.conclusion.toLowerCase() : ''
    if ((rawConclusion.length > 0 || status === 'completed') && !CHECK_CONCLUSION.has(rawConclusion)) {
      return { ok: false, reason: 'ci-native-state-unknown' }
    }
    if (status !== 'completed' || !RED_CI.has(rawConclusion)) continue
    const checkName = typeof node.name === 'string' && node.name.length > 0 ? node.name : null
    const observationId = typeof node.id === 'string' && node.id.length > 0 ? node.id : null
    if (checkName === null || observationId === null) return { ok: false, reason: 'ci-native-identity-unknown' }
    failures.push({ name: checkName, source: CHECK_RUN_SOURCE, observationId, conclusion: rawConclusion })
  }
  const seen = new Set<string>()
  for (const failure of failures) {
    const key = `${failure.source}\0${failure.observationId}`
    if (seen.has(key)) return { ok: false, reason: 'ci-native-identity-unknown' }
    seen.add(key)
  }
  if (failures.length === 0) return { ok: false, reason: 'ci-attribution-evidence-missing' }
  const failedChecks = [...new Set(failures.map((item) => item.name))]
  const evidenceDigest = digest({ candidateGitSHA, scope, failures })
  if (evidenceDigest === null) return { ok: false, reason: 'ci-native-identity-unknown' }
  return { ok: true, failedChecks, failures, evidenceDigest, supplied: nodes }
}

export async function publishFeatureNativeResult(input: {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  startHead?: string
  git?: GitRunner
  gh?: Gh
}): Promise<{ published: true } | { published: false; reason: string }> {
  const implement = input.result.batch.tasks.tasks.some((task) => task.agent === 'R-workflow-implement')
  if (!implement) return publishNonImplementResult(input)
  const loaded = await loadContracts()
  if ('missing' in loaded) return { published: false, reason: `engine-unavailable:${loaded.missing}` }
  const git = input.git ?? defaultGit()
  const gh = input.gh ?? defaultGh()
  if (input.start.kind !== 'action-receipt') return { published: false, reason: 'implementation-start-unconfirmed' }
  const composed = await loaded.readComposedWorkflowHistory([input.start.scope], { cwd: input.cwd, gh })
  if (!composed.ok) return { published: false, reason: composed.reason }
  const history = composed.histories[0]
  if (!history) return { published: false, reason: 'incomplete' }
  const receiptScope = input.start.scope
  const child = input.result.children[0]
  const startRecord = history.operations.find((operation) => {
    const record = operation.record
    return (
      record?.kind === 'action-receipt' &&
      record.recordId === input.start.recordId &&
      record.payload.phase === 'start' &&
      record.payload.action === 'implement' &&
      record.payload.actionId === input.result.batch.operationId
    )
  })?.record
  if (startRecord == null) {
    return { published: false, reason: 'implementation-start-unconfirmed' }
  }
  const start = startRecord
  // RESULT conserves START published mandate/branch/planActionId — never re-select active successor.
  const startMandate = isRecord(start.payload.mandate) ? start.payload.mandate : null
  if (
    startMandate === null ||
    !isRecord(startMandate.scope) ||
    typeof startMandate.scope.repository !== 'string' ||
    typeof startMandate.scope.target !== 'string' ||
    typeof startMandate.recordId !== 'string'
  ) {
    return { published: false, reason: 'mandate-missing' }
  }
  const mandate = {
    scope: { repository: startMandate.scope.repository, target: startMandate.scope.target },
    recordId: startMandate.recordId,
    kind: 'mandate' as const,
  }
  const mandateRead = await loaded.readComposedWorkflowHistory([mandate.scope], { cwd: input.cwd, gh })
  if (!mandateRead.ok || !mandateRead.histories[0])
    return { published: false, reason: mandateRead.ok ? 'incomplete' : mandateRead.reason }
  const mandateHistory = mandateRead.histories[0]
  const originalMandate = findHistoryRecord([mandateHistory], 'mandate', startMandate.recordId)
  if (originalMandate === null) return { published: false, reason: 'mandate-missing' }
  const parentHistories = await explicitParentHistories(loaded, originalMandate, { cwd: input.cwd, gh })
  if (!parentHistories.ok) return { published: false, reason: parentHistories.reason }
  const publicationParents = [mandateHistory, ...parentHistories.parents].filter(
    (context, index, contexts) =>
      (context.source.scope.repository !== receiptScope.repository ||
        context.source.scope.target !== receiptScope.target) &&
      contexts.findIndex(
        (known) =>
          known.source.scope.repository === context.source.scope.repository &&
          known.source.scope.target === context.source.scope.target,
      ) === index,
  )
  const branch =
    originalMandate !== null && typeof originalMandate.payload.branch === 'string'
      ? originalMandate.payload.branch
      : null
  const startExact = isRecord(start.payload.exactInputs) ? start.payload.exactInputs : null
  const startMandateId = startExact !== null && typeof startExact.mandateId === 'string' ? startExact.mandateId : null
  const planId = startExact !== null && typeof startExact.planActionId === 'string' ? startExact.planActionId : null
  if (startMandateId !== null && startMandateId !== mandate.recordId) {
    return { published: false, reason: 'implementation-start-unconfirmed' }
  }
  const resultExactInputs =
    startMandateId !== null && planId !== null ? { mandateId: startMandateId, planActionId: planId } : null
  if (typeof branch !== 'string' || branch.length === 0) {
    return { published: false, reason: 'implementation-branch-unbound' }
  }
  if (resultExactInputs === null) {
    return { published: false, reason: 'implementation-start-unconfirmed' }
  }
  const confirmedExactInputs = resultExactInputs
  const claim = child && isRecord(child.structured) ? child.structured : null
  const modelReason = claim !== null && typeof claim.reason === 'string' ? claim.reason : null
  const claimedIds = new Set<string>()
  if (claim !== null && Array.isArray(claim.commands)) {
    for (const command of claim.commands) {
      if (isRecord(command) && typeof command.toolCallId === 'string' && command.toolCallId.length > 0) {
        claimedIds.add(command.toolCallId)
      }
    }
  }
  if (typeof claim?.proofToolCallId === 'string' && claim.proofToolCallId.length > 0) {
    claimedIds.add(claim.proofToolCallId)
  }
  const admissionBindings = (
    commands: readonly { command: string; exitCode: number; toolCallId?: string; cwd?: string }[],
  ): { toolCallId: string; command: string; exitCode: number; cwd: string }[] => {
    const retained: { toolCallId: string; command: string; exitCode: number; cwd: string }[] = []
    for (const command of commands) {
      const toolCallId = command.toolCallId
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) continue
      retained.push({
        toolCallId,
        command: command.command,
        exitCode: command.exitCode,
        cwd: typeof command.cwd === 'string' && command.cwd.length > 0 ? command.cwd : input.cwd,
      })
    }
    return retained
  }
  /** Model ImplementationCommand rows: strict {toolCallId,command,exitCode}. Streams live on native.bashCalls. */
  const modelImplementationCommands = (): {
    toolCallId: string
    command: string
    exitCode: number
  }[] => {
    if (claim === null || !Array.isArray(claim.commands)) return []
    const retained: { toolCallId: string; command: string; exitCode: number }[] = []
    for (const command of claim.commands) {
      if (!isRecord(command)) continue
      if (
        typeof command.command !== 'string' ||
        typeof command.exitCode !== 'number' ||
        !Number.isInteger(command.exitCode)
      ) {
        continue
      }
      if (typeof command.toolCallId !== 'string' || command.toolCallId.length === 0) continue
      retained.push({
        toolCallId: command.toolCallId,
        command: command.command,
        exitCode: command.exitCode,
      })
    }
    return retained
  }
  const retain = async (
    reason: string,
    commits: readonly { sha: string; paths?: readonly string[] }[] = [],
    commands: readonly { command: string; exitCode: number; toolCallId?: string; cwd?: string }[] = [],
  ): Promise<{ confirmed: true } | { confirmed: false; reason: string }> => {
    if (!child) return { confirmed: false, reason: 'missing-contribution' }
    const admissionCommands = admissionBindings(commands)
    const structuredCommands = modelImplementationCommands()
    const published = await publishRecord(
      loaded,
      history,
      {
        repository: receiptScope.repository,
        target: receiptScope.target,
        version: 1,
        recordId: randomUUID(),
        runId: randomUUID(),
        operationId: `${input.result.batch.operationId}:result`,
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'implement',
          actionId: input.result.batch.operationId,
          mandate,
          start: { scope: receiptScope, recordId: start.recordId, kind: 'action-receipt' },
          exactInputs: confirmedExactInputs,
          native: implementNativeOutcome(child, input.result.complete, claimedIds),
          admission: {
            admitted: false,
            commits: commits.map((commit) => commit.sha),
            paths: commits.flatMap((commit) => commit.paths ?? []),
            commands: admissionCommands,
            remoteBranch: null,
            remoteTip: null,
            published: false,
            reason,
          },
          structured: {
            outcome: 'blocked',
            commitSHAs: commits.map((commit) => commit.sha),
            commands: structuredCommands,
            proofToolCallId: null,
            proofUnavailableReason: reason,
            reason: modelReason ?? reason,
          },
          diagnostics: [{ code: reason, message: reason }],
        },
      },
      gh,
      input.cwd,
      publicationParents,
    )
    return published.ok ? { confirmed: true } : { confirmed: false, reason: published.reason }
  }
  if (!input.result.complete || input.startHead === undefined || !child) {
    const reason = !input.result.complete
      ? 'action-uncertain'
      : input.startHead === undefined
        ? 'implementation-start-unobserved'
        : 'missing-contribution'
    await retain(reason)
    return { published: false, reason }
  }
  const { admitImplementationEvidence } = await import('./feature-entry.ts')
  const admission = await admitImplementationEvidence({
    cwd: input.cwd,
    startHead: input.startHead,
    ticket: scopeNumber(mandate.scope),
    children: input.result.children,
    git: async (args, dir) => {
      const shown = await git(dir, [...args])
      return { stdout: shown.stdout, exitCode: shown.code }
    },
  })
  const proofToolCallId = claim !== null && typeof claim.proofToolCallId === 'string' ? claim.proofToolCallId : null
  if (!admission.admitted || admission.commits.length === 0 || proofToolCallId === null) {
    const reason = !admission.admitted
      ? admission.reason || 'implementation-unconfirmed'
      : admission.commits.length === 0
        ? 'implementation-not-remote'
        : 'implementation-proof-unobserved'
    await retain(
      reason,
      admission.commits.map((sha) => ({ sha })),
      admission.commands,
    )
    return { published: false, reason }
  }
  const tip = admission.commits[admission.commits.length - 1]
  if (tip === undefined) {
    await retain(
      'implementation-not-remote',
      admission.commits.map((sha) => ({ sha })),
      admission.commands,
    )
    return { published: false, reason: 'implementation-not-remote' }
  }
  const authorizePush = async (): Promise<boolean> => {
    if (inhibited.has(input.cwd) || inhibited.has(inhibitKey(mandate.scope))) return false
    const fresh = await loaded.readComposedWorkflowHistory([mandate.scope], { cwd: input.cwd, gh })
    if (!fresh.ok || !fresh.histories[0]) return false
    const freshMandate = findHistoryRecord([fresh.histories[0]], 'mandate', mandate.recordId)
    if (freshMandate === null) return false
    const freshParents = await explicitParentHistories(loaded, freshMandate, { cwd: input.cwd, gh })
    if (!freshParents.ok) return false
    const current = loaded.selectApplicableMandate(fresh.histories[0], freshParents.parents)
    return (
      !inhibited.has(input.cwd) &&
      !inhibited.has(inhibitKey(mandate.scope)) &&
      current.status === 'applicable' &&
      current.mandate?.recordId === mandate.recordId
    )
  }
  const remote = await proveAuthorizedBranch(git, input.cwd, branch, tip, authorizePush)
  if (!remote.ok) {
    const retained = await retain(
      remote.reason,
      admission.commits.map((sha) => ({ sha })),
      admission.commands,
    )
    return retained.confirmed ? { published: true } : { published: false, reason: retained.reason }
  }
  if (modelReason === null) {
    await retain(
      'implementation-claim-missing',
      admission.commits.map((sha) => ({ sha })),
      admission.commands,
    )
    return { published: false, reason: 'implementation-claim-missing' }
  }
  const structuredCommands = modelImplementationCommands()
  if (structuredCommands.length === 0) {
    await retain(
      'implementation-command-unidentified',
      admission.commits.map((sha) => ({ sha })),
      admission.commands,
    )
    return { published: false, reason: 'implementation-command-unidentified' }
  }
  const published = await publishRecord(
    loaded,
    history,
    {
      repository: receiptScope.repository,
      target: receiptScope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: `${input.result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload: {
        phase: 'result',
        action: 'implement',
        actionId: input.result.batch.operationId,
        mandate,
        start: { scope: receiptScope, recordId: start.recordId, kind: 'action-receipt' },
        exactInputs: confirmedExactInputs,
        native: implementNativeOutcome(child, true, claimedIds),
        admission: {
          admitted: true,
          commits: admission.commits,
          paths: admission.paths,
          commands: admission.commands,
          remoteBranch: branch,
          remoteTip: remote.remoteTip,
          published: true,
          reason: admission.reason,
        },
        structured: {
          outcome: 'implemented',
          commitSHAs: admission.commits,
          commands: structuredCommands,
          proofToolCallId,
          proofUnavailableReason: null,
          reason: modelReason,
        },
        diagnostics: [],
      },
    },
    gh,
    input.cwd,
    publicationParents,
  )
  return published.ok ? { published: true } : { published: false, reason: published.reason }
}

export async function requestFeatureSessionPause(input: {
  cwd: string
  reason: 'session-stop' | 'session-switch' | 'session-shutdown'
  interrupt: (() => Promise<void>) | ((operationId: string) => Promise<void>)
  reference?: string
  gh?: Gh
}): Promise<FeatureContinuation> {
  inhibited.set(input.cwd, 'pause')
  const result =
    input.reference === undefined
      ? ({ kind: 'paused', confirmed: false, reason: input.reason } satisfies PausedContinuation)
      : await continueFeatureAtTarget({
          cwd: input.cwd,
          reference: input.reference,
          control: 'pause',
          principal: false,
          native: { reviewPort: null },
          gh: input.gh,
        })
  await (input.interrupt as (operationId?: string) => Promise<void>)('session')
  return result
}

/**
 * Host watch exit. One object. Missing reference refuses.
 * Non-terminal progress re-enters with internal `continue`, which never
 * sets explicit selection/resume authority; a confirmed pause stays paused.
 */
export async function consumeWatchExit(input: {
  cwd: string
  pr: number
  code: number
  reference: string
  gh?: Gh
  git?: GitRunner
}): Promise<FeatureContinuation> {
  if (input.reference.trim().length === 0) return { kind: 'blocked', reason: 'watch-reference-missing' }
  const landed = await applyCiWatchExit(input.cwd, input.pr, input.code, { gh: input.gh, git: input.git })
  const outcome = featureLandOutcome(landed)
  if (outcome.action === 'start-watch' || outcome.action === 'reattach-watch') {
    return typeof landed.watch === 'string'
      ? { kind: 'watch', command: landed.watch }
      : { kind: 'blocked', reason: 'watch-missing' }
  }
  if (outcome.action === 'stop' || outcome.action === 'blocked') return { kind: 'terminal', reason: outcome.reason }
  return reenterFeature({ cwd: input.cwd, reference: input.reference, gh: input.gh, git: input.git })
}

function bindingMatches(payload: Record<string, unknown>, mandateId: string, branch: string, base: string): boolean {
  const mandate = payload.mandate
  if (mandate === null || typeof mandate !== 'object' || !('recordId' in mandate)) return false
  return mandate.recordId === mandateId && payload.branch === branch && payload.base === base
}

/**
 * Publish the one PR-to-mandate association after native head/base match.
 * A confirmed matching record is reused. A conflict is not replaced.
 */
export async function confirmWorkflowBinding(input: {
  cwd: string
  pr: number
  issue: number
  branch: string
  base: string
  gh?: Gh
}): Promise<{ ok: true; recordId: string } | { ok: false; reason: string }> {
  const gh = input.gh ?? defaultGh()
  const loaded = await loadContracts()
  if ('missing' in loaded) return { ok: false, reason: `engine-unavailable:${loaded.missing}` }
  const repoRaw = await gh(input.cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  const repoParsed: unknown = JSON.parse(repoRaw)
  if (repoParsed === null || typeof repoParsed !== 'object' || !('nameWithOwner' in repoParsed)) {
    return { ok: false, reason: 'repository-unreadable' }
  }
  if (typeof repoParsed.nameWithOwner !== 'string') return { ok: false, reason: 'repository-unreadable' }
  const repository = repoParsed.nameWithOwner
  const prRaw = await gh(input.cwd, [
    'pr',
    'view',
    String(input.pr),
    '--repo',
    repository,
    '--json',
    'headRefName,baseRefName',
  ])
  const prParsed: unknown = JSON.parse(prRaw)
  if (
    prParsed === null ||
    typeof prParsed !== 'object' ||
    !('headRefName' in prParsed) ||
    !('baseRefName' in prParsed)
  ) {
    return { ok: false, reason: 'native-metadata-unreadable' }
  }
  if (prParsed.headRefName !== input.branch || prParsed.baseRefName !== input.base) {
    return { ok: false, reason: 'native-metadata-mismatch' }
  }
  const issueScope = loaded.githubScope(repository, input.issue)
  const prScope = loaded.githubScope(repository, input.pr)
  const issueHistory = await loaded.readComposedWorkflowHistory([issueScope], { cwd: input.cwd, gh })
  if (!issueHistory.ok) return { ok: false, reason: issueHistory.reason }
  const issueRecord = issueHistory.histories[0]
  if (!issueRecord) return { ok: false, reason: 'incomplete' }
  // Child feature mandates parent-ref the epic; load that chain before selection.
  const localMandate =
    [...issueRecord.operations]
      .reverse()
      .find((operation) => operation.status === 'complete' && operation.record?.kind === 'mandate')?.record ?? null
  const parents = await explicitParentHistories(loaded, localMandate, { cwd: input.cwd, gh })
  if (!parents.ok) return { ok: false, reason: parents.reason }
  const external = [...issueHistory.histories.slice(1), ...parents.parents]
  const selected = loaded.selectApplicableMandate(issueRecord, external)
  if (selected.status !== 'applicable' || selected.mandate === null) {
    return { ok: false, reason: selected.status === 'refused' ? selected.reason : 'mandate-missing' }
  }
  const prHistory = await loaded.readComposedWorkflowHistory([prScope], { cwd: input.cwd, gh })
  if (!prHistory.ok) return { ok: false, reason: prHistory.reason }
  const history = prHistory.histories[0]
  if (!history) return { ok: false, reason: 'incomplete' }
  const bindings = history.operations.flatMap((operation) => {
    const record = operation.record
    if (record === null || record.kind !== 'workflow-binding') return []
    return [{ status: operation.status, recordId: record.recordId, payload: record.payload }]
  })
  if (bindings.some((item) => item.status !== 'complete')) return { ok: false, reason: 'binding-partial' }
  const selectedMandate = selected.mandate
  const matches = bindings.filter((item) =>
    bindingMatches(item.payload, selectedMandate.recordId, input.branch, input.base),
  )
  if (bindings.length > 1 || (bindings.length === 1 && matches.length === 0)) {
    return { ok: false, reason: 'binding-conflict' }
  }
  const existing = matches[0]
  if (existing) return { ok: true, recordId: existing.recordId }
  const recordId = `workflow-binding:${prScope.target}:${selected.mandate.recordId}`
  const built = loaded.buildRecord({
    repository: prScope.repository,
    target: prScope.target,
    version: 1,
    recordId,
    runId: recordId,
    operationId: recordId,
    kind: 'workflow-binding',
    payload: {
      mandate: { scope: issueScope, recordId: selected.mandate.recordId, kind: 'mandate' },
      branch: input.branch,
      base: input.base,
    },
  })
  if (!built.ok) return { ok: false, reason: built.diagnostics.map((item) => item.code).join(',') || 'record-invalid' }
  const published = await loaded.publishConfirmedWorkflowRecord(built.value, history, { cwd: input.cwd, gh }, null, [
    ...issueHistory.histories,
    ...parents.parents,
  ])
  return published.status === 'confirmed' ? { ok: true, recordId } : { ok: false, reason: published.status }
}

function implementedCommits(history: History): string[] {
  for (const operation of [...history.operations].reverse()) {
    const record = operation.record
    if (
      record?.kind !== 'action-receipt' ||
      record.payload.action !== 'implement' ||
      record.payload.phase !== 'result'
    ) {
      continue
    }
    const structured = record.payload.structured
    if (!isRecord(structured) || structured.outcome !== 'implemented' || !Array.isArray(structured.commitSHAs)) continue
    return structured.commitSHAs.filter((sha): sha is string => typeof sha === 'string')
  }
  return []
}

async function proveAuthorizedBranch(
  git: GitRunner,
  cwd: string,
  branch: string,
  tip: string,
  authorizePush: () => Promise<boolean>,
): Promise<{ ok: true; remoteTip: string } | { ok: false; reason: string }> {
  const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current.code !== 0 || current.stdout.trim() !== branch)
    return { ok: false, reason: 'implementation-branch-mismatch' }
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== tip) return { ok: false, reason: 'implementation-head-mismatch' }
  const observed = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const observedTip = observed.stdout.trim().split(/\s+/)[0] ?? ''
  if (observed.code === 0 && observedTip === tip) return { ok: true, remoteTip: observedTip }
  // This is the last local authority check before a new remote mutation.
  // GitHub control changes can still race this external write; no cross-system
  // lock is introduced here.
  if (!(await authorizePush())) return { ok: false, reason: 'implementation-admission-refused' }
  const pushed = await git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`])
  if (pushed.code !== 0) return { ok: false, reason: 'implementation-not-remote' }
  const remote = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const remoteTip = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (remote.code !== 0 || remoteTip !== tip) return { ok: false, reason: 'implementation-not-remote' }
  return { ok: true, remoteTip }
}

async function remoteContains(git: GitRunner, cwd: string, branch: string, shas: readonly string[]): Promise<boolean> {
  const fetched = await git(cwd, ['fetch', 'origin', branch])
  if (fetched.code !== 0) return false
  for (const sha of shas) {
    const contained = await git(cwd, ['merge-base', '--is-ancestor', sha, `origin/${branch}`])
    if (contained.code !== 0) return false
  }
  return shas.length > 0
}

async function openPullRequestAfterRemoteProof(
  history: History,
  reference: string,
  issue: { title: string; body: string },
  number: number,
  git: GitRunner,
  gh: Gh,
  cwd: string,
  mandate: NonNullable<History['operations'][number]['record']>,
  exactMandateRef?: ScopedRecordRef,
): Promise<FeatureContinuation> {
  const branch = mandate.payload.branch
  const base = mandate.payload.base
  const shas = implementedCommits(history)
  if (typeof branch !== 'string' || typeof base !== 'string' || shas.length === 0) {
    return { kind: 'blocked', reason: 'implementation-not-remote' }
  }
  if (!(await remoteContains(git, cwd, branch, shas))) {
    return { kind: 'blocked', reason: 'implementation-not-remote' }
  }
  try {
    await openPr(cwd, { issue: number, branch, base, title: issue.title, body: issue.body }, { gh })
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'publish-failed' }
  }
  return reenterFeature({ cwd, reference, gh, git, exactMandateRef })
}

async function reviewAfterBinding(
  contracts: Contracts,
  issueHistory: History,
  delivery: Delivery | null,
  parents: readonly History[],
): Promise<FeatureContinuation> {
  if (delivery === null) return { kind: 'blocked', reason: 'binding-missing' }
  const selected = contracts.selectApplicableMandate(issueHistory, parents)
  if (selected.status !== 'applicable' || selected.mandate === null) {
    return { kind: 'blocked', reason: 'binding-missing' }
  }
  const mandateId = selected.mandate.recordId
  const branch = selected.mandate.payload.branch
  const base = selected.mandate.payload.base
  if (typeof branch !== 'string' || typeof base !== 'string') return { kind: 'blocked', reason: 'binding-missing' }
  const bound = delivery.history.operations.some((operation) => {
    const record = operation.record
    return (
      operation.status === 'complete' &&
      record?.kind === 'workflow-binding' &&
      bindingMatches(record.payload, mandateId, branch, base)
    )
  })
  return bound ? { kind: 'review', pr: delivery.number } : { kind: 'blocked', reason: 'binding-missing' }
}

async function publishNonImplementResult(input: {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  gh?: Gh
}): Promise<{ published: true } | { published: false; reason: string }> {
  const loaded = await loadContracts()
  if ('missing' in loaded) return { published: false, reason: `engine-unavailable:${loaded.missing}` }
  const gh = input.gh ?? defaultGh()
  if (input.start.kind !== 'action-receipt') return { published: false, reason: 'action-uncertain' }
  const composed = await loaded.readComposedWorkflowHistory([input.start.scope], { cwd: input.cwd, gh })
  if (!composed.ok) return { published: false, reason: composed.reason }
  const history = composed.histories[0]
  if (!history) return { published: false, reason: 'incomplete' }
  const receiptScope = input.start.scope
  const publicationParents = composed.histories.slice(1)
  const started = (source: History): History['operations'][number]['record'] | null =>
    source.operations.find((operation) => {
      const record = operation.record
      return (
        record?.kind === 'action-receipt' &&
        record.recordId === input.start.recordId &&
        record.payload.phase === 'start' &&
        record.payload.actionId === input.result.batch.operationId
      )
    })?.record ?? null
  const opened = started(history)
  // Terminal receipt publication is authorized by the exact confirmed start,
  // not by whether that mandate remains eligible for subsequent work.
  if (opened?.kind === 'action-receipt') {
    const mandate = opened.payload.mandate
    if (
      !isRecord(mandate) ||
      !isRecord(mandate.scope) ||
      typeof mandate.scope.repository !== 'string' ||
      typeof mandate.scope.target !== 'string' ||
      typeof mandate.recordId !== 'string' ||
      mandate.kind !== 'mandate'
    )
      return { published: false, reason: 'action-uncertain' }
    const mandateScope = { repository: mandate.scope.repository, target: mandate.scope.target }
    const mandateRead = await loaded.readComposedWorkflowHistory([mandateScope], { cwd: input.cwd, gh })
    if (!mandateRead.ok || !mandateRead.histories[0])
      return { published: false, reason: mandateRead.ok ? 'incomplete' : mandateRead.reason }
    const mandateHistory = mandateRead.histories[0]
    const mandateRecord = mandateHistory.operations.find(
      (operation) =>
        operation.status === 'complete' &&
        operation.record?.kind === 'mandate' &&
        operation.record.recordId === mandate.recordId,
    )?.record
    if (mandateRecord == null) return { published: false, reason: 'action-uncertain' }
    const parents = await explicitParentHistories(loaded, mandateRecord, { cwd: input.cwd, gh })
    if (!parents.ok) return { published: false, reason: parents.reason }
    for (const context of [mandateHistory, ...parents.parents]) {
      if (
        context.source.scope.repository === receiptScope.repository &&
        context.source.scope.target === receiptScope.target
      )
        continue
      if (
        publicationParents.some(
          (known) =>
            known.source.scope.repository === context.source.scope.repository &&
            known.source.scope.target === context.source.scope.target,
        )
      )
        continue
      publicationParents.push(context)
    }
  }
  if (opened?.kind !== 'action-receipt') return { published: false, reason: 'action-uncertain' }
  const action = typeof opened.payload.action === 'string' ? opened.payload.action : null
  if (action === null) return { published: false, reason: 'action-uncertain' }
  if (!input.result.complete) return { published: false, reason: 'action-uncertain' }
  if (action === 'plan-review') {
    const slots = Array.isArray(opened.payload.slots) ? opened.payload.slots : null
    if (slots === null) return { published: false, reason: 'plan-review-slots-missing' }
    const contributions = slots.map((slot) => {
      const slotId = isRecord(slot) && typeof slot.slotId === 'string' ? slot.slotId : null
      const specialist = isRecord(slot) && typeof slot.specialist === 'string' ? slot.specialist : null
      const child = input.result.children.find((entry) => entry.expectedId === slotId) ?? null
      return {
        content: 'action-result',
        inventoryId: null,
        host: {
          origin: 'native',
          phase: null,
          role: specialist,
          slotId,
          chunk: null,
          childId: child?.id ?? null,
        },
        rawAttempts: child === null ? [] : child.submissions,
        native: child === null ? null : nativeOutcome(child, child.usable && child.structured !== null),
        structured: child?.structured ?? null,
        findings: null,
      }
    })
    const published = await publishRecord(
      loaded,
      history,
      {
        repository: receiptScope.repository,
        target: receiptScope.target,
        version: 1,
        recordId: randomUUID(),
        runId: randomUUID(),
        operationId: `${input.result.batch.operationId}:result`,
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'plan-review',
          actionId: input.result.batch.operationId,
          mandate: opened.payload.mandate,
          start: { scope: receiptScope, recordId: opened.recordId, kind: 'action-receipt' },
          exactInputs: opened.payload.exactInputs,
          slots,
          contributions,
          native: nativeOutcome(input.result.children[0] ?? emptyChild(), true),
          structured: null,
          admission: null,
          diagnostics: contributions
            .filter((contribution) => contribution.host.childId === null)
            .map((contribution) => ({
              code: 'missing-contribution',
              message: `plan-review slot ${contribution.host.slotId ?? 'unknown'} missing`,
            })),
        },
      },
      gh,
      input.cwd,
      publicationParents,
    )
    return published.ok ? { published: true } : { published: false, reason: published.reason }
  }
  const child = input.result.children[0]
  if (!child) return { published: false, reason: 'missing-contribution' }
  if (action === 'plan') {
    const structured = isRecord(child.structured) ? child.structured : null
    if (structured === null || !Array.isArray(structured.steps) || !Array.isArray(structured.resolutions)) {
      return { published: false, reason: 'plan-output-invalid' }
    }
    const published = await publishRecord(
      loaded,
      history,
      {
        repository: receiptScope.repository,
        target: receiptScope.target,
        version: 1,
        recordId: randomUUID(),
        runId: randomUUID(),
        operationId: `${input.result.batch.operationId}:result`,
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'plan',
          actionId: input.result.batch.operationId,
          mandate: opened.payload.mandate,
          start: { scope: receiptScope, recordId: opened.recordId, kind: 'action-receipt' },
          exactInputs: opened.payload.exactInputs,
          native: nativeOutcome(child, true),
          structured: { steps: structured.steps, resolutions: structured.resolutions },
          admission: null,
          diagnostics: [],
        },
      },
      gh,
      input.cwd,
      publicationParents,
    )
    return published.ok ? { published: true } : { published: false, reason: published.reason }
  }
  if (action === 'assess-spec' || action === 'attribute-ci') {
    if (child.structured === null) return { published: false, reason: `${action}-output-invalid` }
    const published = await publishRecord(
      loaded,
      history,
      {
        repository: receiptScope.repository,
        target: receiptScope.target,
        version: 1,
        recordId: randomUUID(),
        runId: randomUUID(),
        operationId: `${input.result.batch.operationId}:result`,
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action,
          actionId: input.result.batch.operationId,
          mandate: opened.payload.mandate,
          start: { scope: receiptScope, recordId: opened.recordId, kind: 'action-receipt' },
          exactInputs: opened.payload.exactInputs,
          native: nativeOutcome(child, true),
          structured: child.structured,
          admission: null,
          diagnostics: [],
        },
      },
      gh,
      input.cwd,
      publicationParents,
    )
    return published.ok ? { published: true } : { published: false, reason: published.reason }
  }
  return { published: false, reason: `action-result-unhandled:${action}` }
}

function emptyChild(): NativeChildResult {
  return {
    id: null,
    expectedId: null,
    submissions: [],
    proofEvidence: null,
    bashCalls: [],
    raw: null,
    partialText: null,
    structured: null,
    usable: false,
    reason: 'absent',
  }
}

function nativeOutcome(
  child: NativeChildResult,
  usable: boolean,
): { completion: 'completed' | 'incomplete'; strict: 'valid' | 'invalid' | 'absent'; raw: NativeChildResult['raw'] } {
  return {
    completion: child.usable ? 'completed' : 'incomplete',
    strict: usable ? 'valid' : 'invalid',
    raw: child.raw,
  }
}

/**
 * Emit admitted-ci-correction only when admitAttributedCiCorrection returns attributed-correction.
 * attributionRecordId = attribute-ci result receipt id (not start).
 * scope = resolveAcceptedSpec(...).spec.body (not exactInputs.scope / evidence path).
 * reference = `#${pr}` for resolveExplicit — not a differing feature issue subject.
 */
async function tryAdmittedCiCorrectionContinuation(input: {
  cwd: string
  history: History
  mandateHistory?: History
  parents: readonly History[]
  scope: Scope
  head: string | null
  branch: string | null
  base: string | null
  pr: number
  gh: Gh
  ciFailed: boolean
  resolveAcceptedSpec: Contracts['resolveAcceptedSpec']
  selectApplicableMandate: Contracts['selectApplicableMandate']
}): Promise<FeatureContinuation | null | { kind: 'blocked'; reason: string }> {
  if (!input.ciFailed || input.head === null || !/^[0-9a-f]{40}$/.test(input.head)) return null
  const decoded = await readDecodedHistory(input.scope, input.cwd, input.gh)
  if (!decoded.ok) return { kind: 'blocked', reason: decoded.reason }
  const attributionRecordId = latestAttributeCiChangeReceiptId(decoded.history, input.head, input.scope)
  if (attributionRecordId === null) return null
  const mandateHistory = input.mandateHistory ?? input.history
  const selected = input.selectApplicableMandate(mandateHistory, input.parents)
  if (selected.status !== 'applicable' || selected.mandate === null) {
    return { kind: 'blocked', reason: 'mandate-missing' }
  }
  const accepted = input.resolveAcceptedSpec(selected.mandate, [mandateHistory, ...input.parents])
  if (!accepted.ok) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const correctionScope = accepted.spec.body
  if (correctionScope.trim().length === 0) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  // The fresh decoded history above is both receipt selection and correction admission evidence.
  const admitted = await admitAttributedCiCorrection({
    cwd: input.cwd,
    target: {
      repository: input.scope.repository,
      target: input.scope.target,
      number: input.pr,
      kind: 'pull-request',
      state: 'open',
      candidateGitSHA: input.head,
    },
    scope: correctionScope,
    branch: input.branch,
    base: input.base,
    attributionRecordId,
    workflow: {
      nextReviewStep: (cwd, pr, options) => nextReviewStep(cwd, pr, { ...options, gh: input.gh }),
    },
    options: withRoxabiGitHubPolicy({ cwd: input.cwd, gh: input.gh }),
    readHistory: async () => decoded.history,
  })
  if (!admitted.ok) return { kind: 'blocked', reason: admitted.diagnostics[0] ?? 'ci-attribution-unconfirmed' }
  if (admitted.value.status === 'spent') {
    return { kind: 'terminal', reason: admitted.value.reason }
  }
  if (admitted.value.status === 'unsafe') {
    return { kind: 'blocked', reason: admitted.value.reason }
  }
  if (admitted.value.status !== 'attributed-correction') return null
  return {
    kind: 'admitted-ci-correction',
    reference: `#${input.pr}`,
    attributionRecordId: admitted.value.attributionRecordId,
    scope: admitted.value.scope,
  }
}

function latestAttributeCiChangeReceiptId(history: DecodedHistory, head: string, scope: Scope): string | null {
  for (let index = history.operations.length - 1; index >= 0; index -= 1) {
    const operation = history.operations[index]
    const record = operation?.record
    if (operation?.status !== 'complete' || record?.kind !== 'action-receipt') continue
    const payload = record.payload
    if (!isRecord(payload) || payload.phase !== 'result' || payload.action !== 'attribute-ci') continue
    const structured = isRecord(payload.structured) ? payload.structured : null
    const exact = isRecord(payload.exactInputs) ? payload.exactInputs : null
    if (structured === null || structured.attribution !== 'change' || exact === null) continue
    if (exact.candidateGitSHA !== head) continue
    const inputScope = isRecord(exact.scope) ? exact.scope : null
    if (inputScope === null || inputScope.repository !== scope.repository || inputScope.target !== scope.target) {
      continue
    }
    return record.recordId
  }
  return null
}

/**
 * Implement native outcome. nativeOutcomeSchema: {completion,strict,raw,bashCalls?}.
 * raw = untouched SDK terminal. bashCalls = claim-referenced NativeProofBashCall copies
 * (input+result, conflicting duplicates kept); unreferenced dropped. Never wrap raw.
 */
function implementNativeOutcome(
  child: NativeChildResult,
  usable: boolean,
  claimedIds: ReadonlySet<string>,
): {
  completion: 'completed' | 'incomplete'
  strict: 'valid' | 'invalid' | 'absent'
  raw: NativeChildResult['raw']
  bashCalls?: readonly NonNullable<NativeChildResult['bashCalls']>[number][]
} {
  const bashCalls = (child.bashCalls ?? []).filter((call) => claimedIds.has(call.toolCallId))
  return {
    completion: child.usable ? 'completed' : 'incomplete',
    strict: usable ? 'valid' : 'invalid',
    raw: child.raw,
    ...(bashCalls.length > 0 ? { bashCalls } : {}),
  }
}

async function pullRequestMerged(gh: Gh, input: { cwd: string }, number: number): Promise<boolean> {
  try {
    const raw = await gh(input.cwd, ['pr', 'view', String(number), '--json', 'state'])
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) && parsed.state === 'MERGED'
  } catch {
    return false
  }
}

async function currentReviewStep(
  cwd: string,
  number: number,
  head: string,
  gh: Gh,
  ciFailed = false,
): Promise<'review' | 'fix' | 'land' | 'stop' | null> {
  if (ciFailed) {
    try {
      return (await nextReviewStep(cwd, number, { ciFailed: true, gh })).action
    } catch {
      return 'stop'
    }
  }
  const records = await readReviewRecords(cwd, number, { gh })
  if (!records.ok) {
    const message = records.diagnostics[0]?.message
    throw new Error(message !== undefined && message.length > 0 ? message : 'review-records-unreadable')
  }
  const step = reviewStep(records.value, { head }).action
  if (step === 'stop') return step
  if (records.value.head !== head) return null
  return step
}

async function startImplement(
  loaded: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  scope: Scope,
  issue: { body: string },
  git: GitRunner,
  gh: Gh,
  cwd: string,
  mandate: NonNullable<History['operations'][number]['record']>,
): Promise<FeatureContinuation> {
  void git
  void issue
  const composed = evidence.parents
  const selected = { mandate }
  const approved = approvedMandateContext(loaded, selected.mandate, [history, ...composed])
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  if (approved.status !== 'ready') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const macro = loaded.planMacro(evidence, selected.mandate)
  const planAction = finalEligiblePlanActionId(macro)
  if (planAction === null) return { kind: 'blocked', reason: 'plan-unconfirmed' }
  const planBlock = planStructuredBlock(history, planAction, 'Confirmed final plan')
  if (planBlock === null) return { kind: 'blocked', reason: 'plan-unconfirmed' }
  const operationId = randomUUID()
  const recordId = randomUUID()
  const published = await publishRecord(
    loaded,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId,
      runId: randomUUID(),
      operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'implement',
        actionId: operationId,
        mandate: { scope, recordId: selected.mandate.recordId, kind: 'mandate' },
        // implementExactSchema refs only; prompt embeds accepted Spec + final plan selected by planMacro.
        exactInputs: {
          mandateId: selected.mandate.recordId,
          planActionId: planAction,
        },
      },
    },
    gh,
    cwd,
    composed,
  )
  if (!published.ok) return { kind: 'blocked', reason: published.reason, diagnostics: published.diagnostics }
  const reread = await loaded.readComposedWorkflowHistory([scope], { cwd, gh })
  const seen = reread.ok && reread.histories[0]?.operations.some((operation) => operation.record?.recordId === recordId)
  if (!seen) return { kind: 'blocked', reason: 'implementation-start-unconfirmed' }
  const criteria = acceptanceCriteria(approved.specBody)
  return modelAction({
    action: 'implement',
    scope,
    start: { scope, recordId, kind: 'action-receipt' },
    operationId,
    approved: { ...approved, acceptanceLine: `Acceptance criteria: ${criteria.join(' | ')}` },
    planBlock,
  })
}

function absentSelector(status: NativeSelector['status'] = 'absent'): NativeSelector {
  return { status, evidence: [] }
}

function buildSpecializedDecisions(input: {
  reviewStep: SpecializedDecisions['reviewStep']
  epicStep: SpecializedDecisions['epicStep']
  ciWatchStatus: SpecializedDecisions['ciWatchStatus']
  pullRequestOpen: boolean
  proof: ProofSelector
}): SpecializedDecisions {
  return {
    reviewStep: input.reviewStep,
    epicStep: input.epicStep,
    epicLand: null,
    ciWatchStatus: input.ciWatchStatus,
    publish: absentSelector(input.pullRequestOpen ? 'published' : 'absent'),
    landing: absentSelector('absent'),
    watch: absentSelector('absent'),
    proof: input.proof,
  }
}

async function currentCiWatchStatus(gh: Gh, cwd: string, pr: number): Promise<SpecializedDecisions['ciWatchStatus']> {
  try {
    const raw = await gh(cwd, ['pr', 'view', String(pr), '--json', 'statusCheckRollup'])
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.statusCheckRollup)) return 'unknown'
    const nodes = parsed.statusCheckRollup
    let pending = false
    let red = false
    let any = false
    for (const node of nodes) {
      if (!isRecord(node)) continue
      any = true
      const status = typeof node.status === 'string' ? node.status.toLowerCase() : ''
      const conclusion = typeof node.conclusion === 'string' ? node.conclusion.toLowerCase() : ''
      if (status !== 'completed') {
        pending = true
        continue
      }
      if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') red = true
    }
    if (!any) return 'unknown'
    if (red) return 'red'
    if (pending) return 'pending'
    return 'green'
  } catch {
    return 'unknown'
  }
}

async function classifyRedCiBeforeDispatch(
  cwd: string,
  pr: number,
  gh: Gh,
  git: GitRunner,
): Promise<FeatureContinuation | null> {
  try {
    const step = await nextReviewStep(cwd, pr, { ciFailed: true, gh, git })
    const classified = classifyCiCorrectionStep(step)
    if (classified.status === 'spent') {
      return { kind: 'terminal', reason: classified.reason }
    }
    if (classified.status === 'unsafe') {
      return { kind: 'blocked', reason: classified.reason }
    }
    if (classified.status === 'refused' && classified.action === 'stop') {
      return { kind: 'blocked', reason: classified.reason ?? 'ci-correction-refused' }
    }
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('latest review record to approve the current head')) {
      return { kind: 'blocked', reason: 'head-unapproved' }
    }
    return { kind: 'blocked', reason: `ci-correction-step-unreadable:${message}` }
  }
}

async function runEpicPostMergeHook(cwd: string, epic: number): Promise<void> {
  const driver = fileURLToPath(new URL('../skills/feature/epic-driver.ts', import.meta.url))
  if (!existsSync(driver)) throw new Error('epic-driver-unavailable')
  const directory = mkdtempSync(join(tmpdir(), 'omp-build-epic-hook-'))
  try {
    await execFileAsync(
      'bun',
      ['--no-env-file', '--no-install', driver, 'hook', '--epic', String(epic), '--repo', cwd],
      {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    )
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // The hook failure remains authoritative; cleanup cannot mask it.
    }
  }
}

async function runGraphAction(
  action: string,
  input: {
    loaded: Contracts
    history: History
    evidence: WorkflowEvidence
    scope: Scope
    issue: { title: string; body: string; labels: string[]; updatedAt: string }
    number: number
    git: GitRunner
    gh: Gh
    cwd: string
    reference: string
    target:
      | { status: 'issue'; scope: Scope; issue: { number: number } }
      | {
          status: 'pull-request'
          scope: Scope
          pullRequest: { pr: number; head: string; base: string; branch: string }
        }
    delivery: Delivery | null
    ciFailed?: boolean
    exactMandateRef?: ScopedRecordRef
    mandateRef: ScopedRecordRef | null
    pause?: PauseBinding
  },
): Promise<FeatureContinuation> {
  if (action === 'fix') {
    if (input.delivery === null) return { kind: 'blocked', reason: 'ci-attribution-requires-pull-request' }
    const admitted = await tryAdmittedCiCorrectionContinuation({
      cwd: input.cwd,
      history: input.delivery.history,
      mandateHistory: input.history,
      parents: input.evidence.parents,
      scope: input.delivery.scope,
      head: input.delivery.head,
      branch: input.delivery.branch,
      base: input.delivery.base,
      pr: input.delivery.number,
      gh: input.gh,
      ciFailed: input.ciFailed === true,
      resolveAcceptedSpec: input.loaded.resolveAcceptedSpec,
      selectApplicableMandate: input.loaded.selectApplicableMandate,
    })
    if (admitted !== null) return admitted
    if (input.ciFailed === true) return { kind: 'blocked', reason: 'ci-attribution-unconfirmed' }
    return { kind: 'fix', reference: input.reference }
  }
  if (action === 'land') {
    if (input.delivery === null) return { kind: 'blocked', reason: 'land-requires-pull-request' }
    // nextReviewStep may return land without a grant; qualify active mandate here.
    const selected = input.loaded.selectApplicableMandate(input.history, input.evidence.parents)
    if (selected.status !== 'applicable' || selected.mandate === null) {
      return {
        kind: 'blocked',
        reason: selected.status === 'refused' ? `mandate-${selected.reason}` : 'mandate-missing',
      }
    }
    const landed = await landPr(input.cwd, input.delivery.number, { gh: input.gh, git: input.git })
    const outcome = featureLandOutcome(landed)
    if ((outcome.action === 'start-watch' || outcome.action === 'reattach-watch') && typeof landed.watch === 'string') {
      return { kind: 'watch', command: landed.watch }
    }
    if (outcome.action === 'report-merged') {
      return reenterFeature({
        cwd: input.cwd,
        reference: input.reference,
        gh: input.gh,
        git: input.git,
        exactMandateRef: input.exactMandateRef,
      })
    }
    if (outcome.action === 'stop' || outcome.action === 'blocked') return { kind: 'terminal', reason: outcome.reason }
    return { kind: 'blocked', reason: outcome.action }
  }
  if (action === 'resume') {
    if (input.pause === undefined) return { kind: 'blocked', reason: 'resume-pause-missing' }
    if (
      !matchesRecordRef(input.pause.mandate, input.scope, input.pause.mandate.recordId, 'mandate') ||
      !matchesRecordRef(input.pause.confirmation, input.scope, input.pause.confirmation.recordId, 'operator-control')
    ) {
      return { kind: 'blocked', reason: 'resume-pause-unreadable' }
    }
    const history = input.history as unknown as DecodedHistory
    const mandate = input.loaded.bindExternalRef(input.pause.mandate, history)
    const confirmation = input.loaded.bindExternalRef(input.pause.confirmation, history)
    if (!mandate.ok || !confirmation.ok || !isRecord(confirmation.value) || !isRecord(confirmation.value.payload)) {
      return { kind: 'blocked', reason: 'resume-pause-unreadable' }
    }
    const body = confirmation.value.payload
    const controlId = typeof body.controlId === 'string' && body.controlId.length > 0 ? body.controlId : null
    if (
      body.control !== 'pause-confirmed' ||
      controlId === null ||
      !matchesRecordRef(body.mandate, input.pause.mandate.scope, input.pause.mandate.recordId, input.pause.mandate.kind)
    ) {
      return { kind: 'blocked', reason: 'resume-pause-unreadable' }
    }
    const published = await publishRecord(
      input.loaded,
      input.history,
      {
        repository: input.scope.repository,
        target: input.scope.target,
        version: 1,
        recordId: randomUUID(),
        runId: randomUUID(),
        operationId: randomUUID(),
        kind: 'operator-control',
        payload: {
          control: 'resume',
          controlId,
          predecessor: input.pause.confirmation,
          mandate: input.pause.mandate,
        },
      },
      input.gh,
      input.cwd,
      input.evidence.parents,
    )
    if (!published.ok) return { kind: 'blocked', reason: published.reason, diagnostics: published.diagnostics }
    inhibited.delete(inhibitKey(input.scope))
    inhibited.delete(input.cwd)
    return continueFeatureAtTarget(
      {
        cwd: input.cwd,
        reference: input.reference,
        control: 'continue',
        principal: false,
        native: { reviewPort: null },
        git: input.git,
        gh: input.gh,
      },
      input.exactMandateRef,
    )
  }
  if (action === 'proof') {
    if (input.delivery === null) return { kind: 'blocked', reason: 'proof-requires-pull-request' }
    const pr = input.delivery.number
    const head = input.delivery.head
    const script = fileURLToPath(new URL('../skills/feature/proof-acquire.ts', import.meta.url))
    try {
      await execFileAsync('bun', ['--no-env-file', script, '--pr', String(pr)], {
        cwd: input.cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch (error) {
      const failed = error !== null && typeof error === 'object' ? error : {}
      const stderr = 'stderr' in failed && typeof failed.stderr === 'string' ? failed.stderr.trim() : ''
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: 'blocked',
        reason:
          stderr.length > 0
            ? `proof-acquire-failed:${stderr.slice(0, 240)}`
            : `proof-acquire-failed:${message.slice(0, 240)}`,
      }
    }
    const readiness = await proofSelectorFor({
      cwd: input.cwd,
      repository: input.delivery.scope.repository,
      delivery: input.delivery,
      git: input.git,
      gh: input.gh,
    })
    if (!readiness.ok) return { kind: 'blocked', reason: readiness.reason }
    const admission = readiness.selector.admission
    if (admission === null || admission.candidateGitSHA !== head || readiness.selector.candidateGitSHA !== head) {
      return { kind: 'blocked', reason: 'proof-acquire-unconfirmed' }
    }
    return reenterFeature({
      cwd: input.cwd,
      reference: input.reference,
      gh: input.gh,
      git: input.git,
      exactMandateRef: input.exactMandateRef,
    })
  }
  if (action === 'epic-next') {
    try {
      const next = await epicNext(input.cwd, input.number, false)
      const step = next.step
      if ((step.action === 'start' || step.action === 'resume') && typeof step.ticket === 'number') {
        return continueFeature({
          cwd: input.cwd,
          reference: `#${step.ticket}`,
          control: 'continue',
          principal: false,
          native: { reviewPort: null },
          git: input.git,
          gh: input.gh,
        })
      }
      return { kind: 'terminal', reason: `epic-${step.action}` }
    } catch (error) {
      return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-next-failed' }
    }
  }
  if (action === 'epic-final') {
    if (input.mandateRef === null) return { kind: 'blocked', reason: 'epic-final-mandate-missing' }
    try {
      const request = await epicFinalReviewRequest(input.cwd, input.number)
      const materials = await prepareEpicFinalReviewMaterials({
        cwd: input.cwd,
        request,
        mandateRef: input.mandateRef,
        git: input.git,
        gh: input.gh,
      })
      return { kind: 'epic-final-review', review: materials }
    } catch (error) {
      return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-final-unprepared' }
    }
  }
  if (action === 'mark-fix') {
    const filed = await fileEpicFixTicket(input.cwd, input.number, input.history)
    if (filed.kind === 'terminal' && filed.reason.startsWith('epic-fix-marked:')) {
      return reenterFeature({
        cwd: input.cwd,
        reference: input.reference,
        gh: input.gh,
        git: input.git,
        exactMandateRef: input.exactMandateRef,
      })
    }
    return filed
  }
  if (action === 'hook') {
    const selected = input.loaded.selectApplicableMandate(input.history, input.evidence.parents)
    if (selected.status !== 'applicable' || selected.mandate === null) {
      return { kind: 'blocked', reason: 'hook-mandate-missing' }
    }
    const mandate = selected.mandate
    const parent = payload(mandate).parent
    if (mandateRoleOf(mandate) === 'feature') {
      if (
        !isRecord(parent) ||
        !isRecord(parent.scope) ||
        typeof parent.scope.repository !== 'string' ||
        typeof parent.scope.target !== 'string' ||
        typeof parent.recordId !== 'string' ||
        parent.kind !== 'mandate'
      ) {
        return { kind: 'blocked', reason: 'parent-mandate-unreadable' }
      }
      const parentRef: ScopedRecordRef = {
        scope: { repository: parent.scope.repository, target: parent.scope.target },
        recordId: parent.recordId,
        kind: 'mandate',
      }
      return continueFeatureAtTarget(
        {
          cwd: input.cwd,
          reference: parent.scope.target,
          control: 'continue',
          principal: false,
          native: { reviewPort: null },
          git: input.git,
          gh: input.gh,
        },
        parentRef,
      )
    }
    if (mandateRoleOf(mandate) !== 'epic') return { kind: 'blocked', reason: 'epic-hook-role' }
    try {
      await runEpicPostMergeHook(input.cwd, input.number)
      return reenterFeature({
        cwd: input.cwd,
        reference: input.reference,
        gh: input.gh,
        git: input.git,
        exactMandateRef: input.exactMandateRef,
      })
    } catch (error) {
      return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-hook-failed' }
    }
  }
  if (action === 'report') {
    try {
      const step = await epicStep(input.cwd, input.number)
      const outcome = step.name === 'drop' ? 'drop' : 'complete'
      await epicReport(input.cwd, input.number, outcome, step.name === 'drop' ? 'epic-drop' : '')
      return { kind: 'terminal', reason: `epic-${outcome}` }
    } catch (error) {
      return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-report-failed' }
    }
  }
  return { kind: 'blocked', reason: `action-unwired:${action}` }
}

async function fileEpicFixTicket(cwd: string, epic: number, history: History): Promise<FeatureContinuation> {
  try {
    const step = await epicStep(cwd, epic)
    if (step.step.action !== 'final-review' || step.step.stage !== 'fix-ticket') {
      return { kind: 'blocked', reason: 'epic-fix-ticket-not-due' }
    }
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-fix-ticket-unreadable' }
  }
  const decision = [...history.operations].reverse().find((operation) => operation.record?.kind === 'decision')?.record
  if (!decision) return { kind: 'blocked', reason: 'epic-fix-source-decision-missing' }
  const judgment = isRecord(decision.payload.judgment) ? decision.payload.judgment : null
  const title =
    judgment !== null && typeof judgment.summary === 'string' && judgment.summary.trim().length > 0
      ? judgment.summary.trim().slice(0, 80)
      : `Fix epic #${epic} blocking findings`
  const body = [
    `Parent: #${epic}`,
    '',
    `Source decision: ${decision.recordId}`,
    '',
    'Filed through the trusted issue-triage path for the Epic fix-ticket stage.',
  ].join('\n')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  if (!existsSync(triageCli)) return { kind: 'blocked', reason: 'issue-triage-unavailable' }
  const dir = mkdtempSync(join(tmpdir(), 'omp-build-epic-fix-'))
  try {
    const titleFile = join(dir, 'title.txt')
    const bodyFile = join(dir, 'body.md')
    writeFileSync(titleFile, title)
    writeFileSync(bodyFile, body)
    const repo = history.source.scope.repository
    const created = await execFileAsync(
      'bun',
      [
        '--no-env-file',
        triageCli,
        'create',
        '--title-file',
        titleFile,
        '--body-file',
        bodyFile,
        '--type',
        'fix',
        '--size',
        's',
        '--parent',
        `#${epic}`,
      ],
      {
        cwd: triageDirectory,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REPO: repo },
        maxBuffer: 8 * 1024 * 1024,
      },
    )
    const match = /(?:^|\n)Created #([1-9][0-9]*)\b/m.exec(created.stdout)
    if (!match) return { kind: 'blocked', reason: 'issue-triage-create-unconfirmed' }
    const ticket = Number(match[1])
    await epicMarkFix(cwd, epic, ticket)
    return { kind: 'terminal', reason: `epic-fix-marked:#${ticket}` }
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-fix-ticket-failed' }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}
