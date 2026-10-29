import { createHash } from 'node:crypto'

import { type ActionResult, actionResultSchema, type Json } from '../dist/contracts.js'
import type { NativeChildResult, NativeProofDirective, NativeTask } from '../omp/review-runtime/contracts.js'
import { prepareObservedCorrection } from './correction-action-observation.ts'
import type {
  CorrectionEffectResult,
  ManifestedStageRecord,
  NativeDispatchResult,
} from './correction-execution-contract'
import type { CorrectionNativeRuntime } from './correction-native-runtime'
import {
  actionRequest,
  codePin,
  confirmPreparedAction,
  deliveryTask,
  prepareRefusal,
  recordStageRef,
} from './delivery-action.ts'
import type { FixTarget } from './fix-contract.ts'
import type { ActionSubject, PreparedUwAction } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'

type Guard = Extract<ActionResult, { outcome: 'applied' }>['guardInventory'][number]
export type ObservedProof = { toolCallId: string; input: Json; result: Json; exitCode: number }
export type NativeProofExpectation = NativeProofDirective & { guardId: string | null }

export type AppliedCauseContext = {
  causeJSON: string
  guards: readonly Guard[]
  proofPaths: readonly string[]
  proof: ObservedProof | null
  proofUnavailableReason: string | null
  contributionIds: readonly string[]
}

export function failed<T>(kind: 'retryable' | 'terminal', ...diagnostics: string[]): CorrectionEffectResult<T> {
  return { ok: false, kind, diagnostics }
}

function jsonBashCall(call: {
  toolCallId: string
  input: Json
  effectiveCwd: string | null
  result: Json | null
  exitCode: number | null
}): Json {
  return {
    toolCallId: call.toolCallId,
    input: call.input,
    effectiveCwd: call.effectiveCwd,
    result: call.result,
    exitCode: call.exitCode,
  }
}

export function jsonEvidence(evidence: NativeChildResult['proofEvidence']): Json {
  return evidence === null
    ? null
    : {
        purpose: evidence.purpose,
        causeId: evidence.causeId,
        occurrence: evidence.occurrence,
        guardId: evidence.guardId,
        call: evidence.call === null ? null : jsonBashCall(evidence.call),
      }
}

function jsonChild(child: NativeChildResult): Json {
  const record: { [key: string]: Json } = {
    id: child.id,
    expectedId: child.expectedId,
    submissions: child.submissions.map((item) => ({
      attemptIndex: item.attemptIndex,
      data: item.data,
      raw: item.raw,
      partialText: item.partialText,
    })),
    proofEvidence: jsonEvidence(child.proofEvidence),
    raw: child.raw,
    partialText: child.partialText,
    structured: child.structured,
    usable: child.usable,
    reason: child.reason,
  }
  if (child.bashCalls !== undefined) record.bashCalls = child.bashCalls.map(jsonBashCall)
  return record
}

export function nativeActionRaw(
  causeId: string,
  result: NativeDispatchResult,
  child: NativeChildResult,
  observed: Json,
  proof: ObservedProof | null,
): Json {
  return {
    causeId,
    batch: result.native.raw,
    children: result.native.children.map(jsonChild),
    output: child.structured,
    proofEvidence: jsonEvidence(child.proofEvidence),
    observed,
    proof:
      proof === null
        ? null
        : { toolCallId: proof.toolCallId, input: proof.input, result: proof.result, exitCode: proof.exitCode },
  }
}

export function actionTask(
  name: string,
  agent: string,
  task: string,
  solutionSpace: string,
  proofEvidence: NativeProofDirective,
): Omit<NativeTask, 'action'> {
  return { name, agent, task, solutionSpace, proofEvidence }
}

export function citedStageRecords(
  records: ReadonlyMap<string, ManifestedStageRecord>,
  ids: readonly string[],
): ManifestedStageRecord[] | null {
  const selected: ManifestedStageRecord[] = []
  for (const id of ids) {
    const record = records.get(id)
    if (record === undefined) return null
    selected.push(record)
  }
  return selected
}

/** Canonical prepare plus deliveryTask. The returned task carries the registered action. */
export async function registeredCorrectionTask(
  operations: UwOperations,
  target: FixTarget,
  actionStartHead: string,
  draft: Omit<NativeTask, 'action'>,
  stageRecords: readonly ManifestedStageRecord[],
  subject: ActionSubject,
  runtime?: CorrectionNativeRuntime,
): Promise<CorrectionEffectResult<NativeTask>> {
  if (target.baseGitSHA === null) return failed('terminal', 'prepare-action-unavailable')
  const pinned = codePin(target.repository, target.baseGitSHA, actionStartHead, actionStartHead)
  if (!pinned.ok) return failed('terminal', pinned.reason)
  const request = actionRequest({
    actionId: draft.name,
    purpose: 'correction',
    subject,
    code: pinned.code,
    stageSources: stageRecords.map(recordStageRef),
  })
  let prepared: PreparedUwAction
  if (actionStartHead !== target.candidateGitSHA && runtime?.options.correctionObservationRefs !== undefined) {
    const observed = await prepareObservedCorrection(operations, request, target, runtime)
    if (!observed.ok) return observed
    prepared = observed.value
  } else {
    const result = await confirmPreparedAction(operations, request)
    if (!result.ok) {
      const reason = prepareRefusal(result.diagnostics)
      return { ok: false, kind: 'terminal', diagnostics: [reason], preEffectRefusal: [reason] }
    }
    prepared = result.value
  }
  return {
    ok: true,
    value: deliveryTask({
      name: draft.name,
      agent: draft.agent,
      procedure: draft.task,
      solutionSpace: draft.solutionSpace,
      prepared,
      ...(draft.tools === undefined ? {} : { tools: draft.tools }),
      ...(draft.proofEvidence === undefined ? {} : { proofEvidence: draft.proofEvidence }),
    }),
  }
}

export function taskName(phase: string, causeId: string, suffix = ''): string {
  const base = `fix-${phase}-${causeId}${suffix}`.replace(/[^A-Za-z0-9._:-]/g, '-')
  return base.length <= 128
    ? base
    : `${base.slice(0, 115)}-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`
}

export function indexContext(recordIds: readonly string[]): Json {
  return { recordIds: [...recordIds] }
}

export function actionOutput(
  result: NativeDispatchResult,
): CorrectionEffectResult<{ child: NativeChildResult; output: ActionResult }> {
  if (!result.native.complete || result.native.children.length !== 1)
    return failed('terminal', 'native-action-result-incomplete')
  const child = result.native.children[0]
  if (!child?.usable || child.structured === null) return failed('terminal', 'native-action-output-unusable')
  const parsed = actionResultSchema.safeParse(child.structured)
  return parsed.success
    ? { ok: true, value: { child, output: parsed.data } }
    : failed('terminal', 'native-action-output-invalid')
}

export function observedProof(
  child: NativeChildResult,
  expected: NativeProofExpectation,
  selectedId: string | null,
  unavailableReason: string | null,
  cwd: string,
  realpath: (path: string) => string,
): CorrectionEffectResult<ObservedProof | null> {
  if (selectedId === null)
    return unavailableReason === null ? failed('terminal', 'native-proof-xor-invalid') : { ok: true, value: null }

  const evidence = child.proofEvidence
  if (
    unavailableReason !== null ||
    evidence === null ||
    evidence.purpose !== expected.purpose ||
    evidence.causeId !== expected.causeId ||
    evidence.occurrence !== expected.occurrence ||
    evidence.guardId !== expected.guardId ||
    evidence.call === null
  ) {
    return failed('terminal', 'native-proof-evidence-missing')
  }

  const call = evidence.call
  try {
    if (
      call.toolCallId !== selectedId ||
      call.result === null ||
      call.exitCode === null ||
      call.effectiveCwd === null ||
      realpath(call.effectiveCwd) !== realpath(cwd)
    ) {
      return failed('terminal', 'native-proof-evidence-incomplete')
    }
  } catch {
    return failed('terminal', 'native-proof-cwd-unreadable')
  }

  return {
    ok: true,
    value: {
      toolCallId: call.toolCallId,
      input: call.input,
      result: call.result,
      exitCode: call.exitCode,
    },
  }
}

export function causePaths(paths: readonly string[]): string[] | null {
  const normalized = paths.map((path) => path.replace(/:\d+$/, ''))
  return normalized.length === 0 ||
    normalized.some(
      (path) =>
        path.trim().length === 0 || path.startsWith('-') || path.startsWith('/') || path.split('/').includes('..'),
    )
    ? null
    : normalized
}

export function repoRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path === path.trim() &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:\//.test(path) &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '.' || part === '..')
  )
}
