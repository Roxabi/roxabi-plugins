import { actionInputsSchema, canonicalValueDigest } from '../dist/contracts.js'
import type { Diagnostic, Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { NativeBatch, NativeProofDirective, NativeTask } from '../omp/review-runtime/contracts.ts'
import { isRecord } from './feature-engine.ts'
import type {
  ActionInputManifest,
  ActionInputs,
  ActionPurpose,
  ActionSubject,
  PinnedFileRef,
  PreparedUwAction,
  RecordInputRef,
  ReviewActionProjection,
  UwActionRequest,
} from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

const SHA = /^[0-9a-f]{40}$/

export type DeliveryCode = ActionInputManifest['code']

export type PreMandateAuthority = { kind: 'absent'; reason: 'pre-mandate' }

export type DeliveryTask = NativeTask & { readonly action: PreparedUwAction }

export function procedureIndexTask(procedure: string, indexPath: string): string {
  return [
    procedure,
    `Index: ${indexPath}`,
    'Read only that index and the files it names. Return only the structured result. Do not fetch live records or publish.',
  ].join('\n')
}

export function deliveryTask(input: {
  name: string
  agent: string
  procedure: string
  solutionSpace: string
  prepared: PreparedUwAction
  proofEvidence?: NativeProofDirective
}): DeliveryTask {
  return {
    name: input.name,
    agent: input.agent,
    solutionSpace: input.solutionSpace,
    task: procedureIndexTask(input.procedure, input.prepared.snapshot.indexPath),
    action: input.prepared,
    ...(input.proofEvidence === undefined ? {} : { proofEvidence: input.proofEvidence }),
  }
}

export function deliveryBatch(
  operationId: string,
  tasks: readonly DeliveryTask[],
  context = 'omp-build workflow action',
): NativeBatch {
  return { operationId, tasks: { context, tasks: [...tasks] } }
}

export function actionRequest(input: {
  actionId: string
  purpose: ActionPurpose
  subject: ActionSubject
  code: DeliveryCode
  stageSources?: readonly RecordInputRef[]
  expandedContext?: readonly (RecordInputRef | PinnedFileRef)[]
}): UwActionRequest {
  return {
    actionId: input.actionId,
    purpose: input.purpose,
    subject: input.subject,
    code: input.code,
    stageSources: input.stageSources ?? [],
    expandedContext: input.expandedContext ?? [],
  }
}

export function recordStageRef(record: {
  repository: string
  target: string
  kind: 'decision' | 'contribution'
  recordId: string
  payload: unknown
}): RecordInputRef {
  return {
    source: 'record',
    record: {
      scope: { repository: record.repository, target: record.target },
      kind: record.kind,
      recordId: record.recordId,
    },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  }
}

export function uwSubject(uw: Scope, pullRequest: Scope | null): Extract<ActionSubject, { kind: 'uw' }> {
  return { kind: 'uw', uw, pullRequest, binding: null }
}

/** Bound UW only. A pull-request scope is never requested as a UW mandate. */
export function correctionSubject(target: Scope, uw: Scope | undefined, pullRequest: Scope | null): ActionSubject {
  const samePullRequest =
    pullRequest !== null &&
    (uw === undefined || (uw.repository === pullRequest.repository && uw.target === pullRequest.target))
  if (samePullRequest) return { kind: 'standalone-pr', pullRequest }
  return uwSubject(uw ?? target, pullRequest)
}

export async function prepareDeliveryAction(
  operations: UwOperations,
  request: UwActionRequest,
  projection?: ReviewActionProjection,
): Promise<Result<PreparedUwAction, Diagnostic>> {
  return operations.prepareAction(request, projection)
}

export function prepareRefusal(diagnostics: readonly Diagnostic[]): string {
  return diagnostics[0]?.code ?? 'prepare-action-unavailable'
}

export function readActionInputs(value: unknown): ActionInputs | null {
  const parsed = actionInputsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function inputsMatchReadback(expected: ActionInputs, observed: unknown): boolean {
  const actual = readActionInputs(observed)
  if (actual === null) return false
  return (
    actual.fingerprint === expected.fingerprint && JSON.stringify(actual.manifest) === JSON.stringify(expected.manifest)
  )
}

export function receiptInputs(payload: unknown): ActionInputs | null {
  if (!isRecord(payload) || !('inputs' in payload)) return null
  return readActionInputs(payload.inputs)
}

export async function observeSha(git: GitRunner, cwd: string, ref: string): Promise<string | null> {
  const shown = await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
  const sha = shown.stdout.trim()
  return shown.code === 0 && SHA.test(sha) ? sha : null
}

export async function observeHeadCode(
  git: GitRunner,
  cwd: string,
  repository: string,
): Promise<{ ok: true; code: DeliveryCode } | { ok: false; reason: 'code-unobserved' }> {
  const head = await observeSha(git, cwd, 'HEAD')
  if (head === null) return { ok: false, reason: 'code-unobserved' }
  return { ok: true, code: { repository, base: head, head, referenceCommit: head } }
}

export function codePin(
  repository: string,
  base: string,
  head: string,
  referenceCommit: string,
): { ok: true; code: DeliveryCode } | { ok: false; reason: 'code-unobserved' } {
  if (![base, head, referenceCommit].every((sha) => SHA.test(sha))) return { ok: false, reason: 'code-unobserved' }
  return { ok: true, code: { repository, base, head, referenceCommit } }
}

export function preMandateMandate(): PreMandateAuthority {
  return { kind: 'absent', reason: 'pre-mandate' }
}

export function blocks(
  reason: string,
  diagnostics?: readonly Diagnostic[],
): { kind: 'blocked'; reason: string; diagnostics?: readonly Diagnostic[] } {
  return diagnostics === undefined || diagnostics.length === 0
    ? { kind: 'blocked', reason }
    : { kind: 'blocked', reason, diagnostics }
}

export async function confirmStartReadback(input: {
  read: (scopes: Scope[]) => Promise<{
    ok: boolean
    histories?: { operations: { record?: { recordId?: string; payload?: unknown } | null }[] }[]
  }>
  scope: Scope
  recordId: string
  inputs: ActionInputs
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const reread = await input.read([input.scope])
  const history = reread.ok ? reread.histories?.[0] : undefined
  const record = history?.operations.find((operation) => operation.record?.recordId === input.recordId)?.record
  if (record === undefined || record === null) return { ok: false, reason: 'action-start-unconfirmed' }
  return inputsMatchReadback(input.inputs, receiptInputs(record.payload))
    ? { ok: true }
    : { ok: false, reason: 'action-inputs-unconfirmed' }
}

/** Production prepare, then replay and snapshot verification. Fails closed on fingerprint drift. */
export async function confirmPreparedAction(
  operations: UwOperations,
  request: UwActionRequest,
  projection?: ReviewActionProjection,
): Promise<Result<PreparedUwAction, Diagnostic>> {
  const prepared = await prepareDeliveryAction(operations, request, projection)
  if (!prepared.ok) return prepared
  const replay = await operations.replayActionInputs({ reviewed: prepared.value.inputs, request })
  if (!replay.ok) return replay
  if (replay.value.fingerprint !== prepared.value.inputs.fingerprint) {
    return {
      ok: false,
      diagnostics: [{ code: 'review-input-changed', message: 'replay fingerprint diverged from the prepared action' }],
    }
  }
  const verified = await operations.verifyAction(prepared.value.snapshot)
  if (!verified.ok) return verified
  return prepared
}
