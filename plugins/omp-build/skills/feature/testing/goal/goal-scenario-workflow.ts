/**
 * Forked so the direct workflow leaves `Bun.spawn` under real bun. The
 * Vitest worker's `Bun.spawn` exits 1 with an empty payload even for `/bin/echo`.
 *
 * This default entry does not inject GH. The goal-only direct entry does.
 */

import type { ActionInputs } from '../../../../engine/action-input-schema.ts'
import type { ConfirmedReviewSemanticContext } from '../../../../roxabi/review-semantic-canon.ts'
import { prepareUwAction } from '../../../../roxabi/uw-action-inputs.ts'
import { createProductionActionPorts } from '../../../../roxabi/uw-input-readers.ts'
import { type Refusal, refuse, repositoryOf } from '../../review-base.ts'
import type { LandingResult } from '../../workflow-landing.d.ts'
import { landPr } from '../../workflow-landing.js'
import type { OpenPrResult } from '../../workflow-pr.d.ts'
import { openPr } from '../../workflow-pr.js'
import type { LandingConfig } from '../../workflow-readiness.d.ts'
import { fetchBase } from '../../workflow-readiness.js'
import type { ReviewCapture } from '../../workflow-review-input.d.ts'
import { captureReviewInput, validateReviewInput } from '../../workflow-review-input.js'
import { gitResult, gh as workflowGh } from '../../workflow-runtime.js'
import type { CiWatchExit } from '../../workflow-watch.d.ts'
import { applyCiWatchExit } from '../../workflow-watch.js'

export type GoalWorkflowGh = (cwd: string, args: string[]) => Promise<string>

export type GoalWorkflowPayload = {
  issue?: number
  branch?: string
  base?: string
  title?: string
  pr?: number
  code?: number
  mode?: string
  landing?: LandingConfig
  head?: string
  input?: string | null
}

function workflowOptions(gh?: GoalWorkflowGh): { gh?: GoalWorkflowGh } {
  if (gh === undefined) return {}
  return { gh }
}

function openGoalPr(cwd: string, payload: GoalWorkflowPayload, gh?: GoalWorkflowGh) {
  return openPr(
    cwd,
    {
      issue: payload.issue ?? 0,
      branch: payload.branch ?? '',
      base: payload.base ?? '',
      title: payload.title ?? '',
    },
    workflowOptions(gh),
  )
}

function landGoalPr(cwd: string, payload: GoalWorkflowPayload, gh?: GoalWorkflowGh) {
  return landPr(cwd, payload.pr ?? 0, { landing: payload.landing, ...workflowOptions(gh) })
}

async function reviewInputsFor(
  cwd: string,
  pr: number,
  head: string,
  semantic: ConfirmedReviewSemanticContext,
  ghFn: GoalWorkflowGh,
): Promise<{ ok: true; value: ActionInputs } | Refusal> {
  const repository = await repositoryOf(ghFn, cwd)
  const viewed = JSON.parse(
    await ghFn(cwd, ['pr', 'view', String(pr), '--repo', repository, '--json', 'baseRefName']),
  ) as { baseRefName?: unknown }
  if (typeof viewed.baseRefName !== 'string' || viewed.baseRefName.length === 0) {
    return refuse('unreadable', 'PR base branch is unreadable')
  }
  const base = await fetchBase(cwd, viewed.baseRefName, gitResult, ghFn)
  if ('refusal' in base) return base.refusal
  const pullRequest = { repository, target: `${repository}#${pr}` }
  const prepared = await prepareUwAction(
    {
      actionId: `review-${pr}`,
      purpose: 'review',
      subject:
        semantic.mode === 'standalone'
          ? { kind: 'standalone-pr', pullRequest }
          : { kind: 'uw', uw: semantic.scope, pullRequest, binding: null },
      code: { repository, base: base.tip, head, referenceCommit: head },
      stageSources: [],
      expandedContext: [],
    },
    createProductionActionPorts({ cwd, gh: ghFn }),
  )
  if (!prepared.ok) {
    return {
      ok: false,
      reason: 'unreadable',
      error: prepared.diagnostics.map((item) => item.message).join('; ') || 'review action inputs are unreadable',
    }
  }
  return { ok: true, value: prepared.value.inputs }
}

async function captureGoalReview(
  cwd: string,
  payload: GoalWorkflowPayload,
  gh?: GoalWorkflowGh,
): Promise<ReviewCapture | (ReviewCapture & { inputs: ActionInputs }) | Refusal> {
  const ghFn = gh ?? workflowGh
  const captured = await captureReviewInput(cwd, payload.pr ?? 0, payload.head ?? '', workflowOptions(gh))
  if (!captured.ok) return captured
  if (typeof captured.input !== 'string') return refuse('unreadable', 'review input digest is absent')
  const inputs = await reviewInputsFor(cwd, payload.pr ?? 0, payload.head ?? '', captured.semantic, ghFn)
  if (!inputs.ok) return inputs
  if (inputs.value.fingerprint !== captured.input) {
    return refuse('unreadable', 'captured review digest does not match prepared action inputs')
  }
  return { ...captured, inputs: inputs.value }
}

function validateGoalReview(cwd: string, payload: GoalWorkflowPayload, gh?: GoalWorkflowGh) {
  return validateReviewInput(cwd, payload.pr ?? 0, payload.head ?? '', payload.input ?? null, workflowOptions(gh))
}

function applyGoalWatch(cwd: string, payload: GoalWorkflowPayload, gh?: GoalWorkflowGh) {
  return applyCiWatchExit(cwd, payload.pr ?? 0, payload.code ?? 1, { mode: payload.mode, ...workflowOptions(gh) })
}

type GoalWorkflowResult =
  | OpenPrResult
  | LandingResult
  | ReviewCapture
  | (ReviewCapture & { inputs: ActionInputs })
  | { ok: true }
  | Refusal
  | CiWatchExit

type GoalWorkflowCall = (cwd: string, payload: GoalWorkflowPayload, gh?: GoalWorkflowGh) => Promise<GoalWorkflowResult>

const goalWorkflowCalls: Record<string, GoalWorkflowCall> = {
  openPr: openGoalPr,
  landPr: landGoalPr,
  captureReviewInput: captureGoalReview,
  validateReviewInput: validateGoalReview,
  applyCiWatchExit: applyGoalWatch,
}

export async function dispatchGoalWorkflow(
  fn: string | undefined,
  cwd: string,
  payload: GoalWorkflowPayload,
  gh?: GoalWorkflowGh,
): Promise<GoalWorkflowResult | null> {
  const call = fn === undefined ? undefined : goalWorkflowCalls[fn]
  if (!call) return null
  return call(cwd, payload, gh)
}

if (import.meta.main) {
  const [, , fn, cwd, payloadText] = process.argv
  const result = await dispatchGoalWorkflow(fn, cwd ?? '', JSON.parse(payloadText ?? '{}'))
  if (result === null) {
    process.stderr.write(`unknown workflow call ${fn ?? ''}\n`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
