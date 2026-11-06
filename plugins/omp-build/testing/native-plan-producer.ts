import { canonicalValueDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { bindExternalRef, recordsOf } from '../engine/workflow-control.ts'
import { type PlanOutput, type PlanReview, planDigest, planOutputSchema } from '../engine/workflow-output-schema.ts'
import type { HostGitIdentity } from '../omp/review-runtime/host-git-observation.ts'
import { loadContracts } from '../roxabi/feature-engine.ts'
import { planAction } from '../roxabi/feature-plan-start.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import type { withNativeImplementationWorld } from './native-implementation-world.ts'
import { captureNativePlanBatch } from './native-plan-capture.ts'

type World = Pick<
  Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0],
  'cwd' | 'gh' | 'git' | 'operations'
>
type Context = {
  world: World
  scope: Scope
  mandate: MandateRecord
  parentScopes: readonly Scope[]
  git: HostGitIdentity
}

function requireUnplannedHistory(issue: DecodedHistory) {
  if (
    recordsOf(issue).some(
      (record) =>
        record.kind === 'action-receipt' &&
        (record.payload.action === 'plan' || record.payload.action === 'plan-review'),
    )
  )
    throw new Error('Native planning producer requires a genuinely unplanned initial history')
}

async function observe(input: Context) {
  const head = await input.world.git(input.world.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const tree = await input.world.git(input.world.cwd, ['rev-parse', '--verify', 'HEAD^{tree}'])
  if (
    input.git.repository !== input.scope.repository ||
    head.code !== 0 ||
    tree.code !== 0 ||
    head.stdout.trim() !== input.git.commit ||
    tree.stdout.trim() !== input.git.tree
  )
    throw new Error('Native plan capture identity does not match the independently observed checkout')
  const read = await input.world.operations.readUw(input.scope)
  if (read.observation.status !== 'complete' || read.accepted.status !== 'accepted')
    throw new Error(`Native planning requires an accepted complete observation: ${JSON.stringify(read.observation)}`)
  const find = (scope: Scope) =>
    read.histories.find(
      (history) => history.source.scope.repository === scope.repository && history.source.scope.target === scope.target,
    )
  const issue = find(input.scope)
  const parents = input.parentScopes.map((scope) => {
    const history = find(scope)
    if (!history) throw new Error(`Native planning ancestor is unavailable: ${scope.target}`)
    return history
  })
  if (!issue) throw new Error('Native planning issue history is unavailable')
  return {
    read,
    issue,
    parents,
    evidence: {
      issue,
      pullRequest: null,
      parents,
      causal: {
        histories: read.observation.histories,
        catalogues: read.observation.catalogues,
        observation: read.observation,
      },
    },
  }
}

/** Open the real current plan transition from the actual complete UW observation. */
export async function openNativePlanStep(input: Context, expected: 'plan' | 'plan-review') {
  const before = await observe(input)
  const contracts = await loadContracts()
  if ('missing' in contracts) throw new Error(`Missing engine ${contracts.missing}`)
  const opened = await planAction(
    contracts,
    before.evidence,
    before.issue,
    input.world.gh,
    input.world.cwd,
    input.scope,
    input.mandate,
    input.world.operations,
    input.world.git,
  )
  if (opened.kind !== 'action' || opened.node !== expected)
    throw new Error(`Native ${expected} START refused: ${JSON.stringify(opened)}`)
  const after = await observe(input)
  const bound = bindExternalRef(opened.start, after.issue)
  if (
    !bound.ok ||
    bound.value.kind !== 'action-receipt' ||
    bound.value.payload.action !== expected ||
    bound.value.payload.phase !== 'start'
  )
    throw new Error(`Native ${expected} START not authenticated after readback: ${JSON.stringify(bound)}`)
  return { opened, start: opened.start, startRecord: bound.value, before: before.read, after: after.read }
}

type Opened = Awaited<ReturnType<typeof openNativePlanStep>>

/** Publish only actually captured tasks; a missing specialist produces a refused incomplete batch. */
export async function publishNativePlanStep(
  input: Context,
  step: Opened,
  claims: readonly { task: string; childId: string; value: PlanOutput | PlanReview }[],
) {
  const result = await captureNativePlanBatch({
    batch: step.opened.followUp,
    cwd: input.world.cwd,
    git: input.git,
    claims,
  })
  const published = await publishFeatureNativeResult({
    cwd: input.world.cwd,
    start: step.start,
    result,
    gh: input.world.gh,
    git: input.world.git,
  })
  if (!published.published) return { published, result, read: await input.world.operations.readUw(input.scope) }
  if (!('receipt' in published) || !published.receipt)
    throw new Error('Native plan publication did not return a scoped receipt')
  const after = await observe(input)
  const bound = bindExternalRef(published.receipt, after.issue)
  if (
    !bound.ok ||
    bound.value.kind !== 'action-receipt' ||
    bound.value.payload.phase !== 'result' ||
    bound.value.payload.action !== step.startRecord.payload.action ||
    bound.value.payload.actionId !== step.startRecord.payload.actionId ||
    canonicalValueDigest(bound.value.payload.start) !== canonicalValueDigest(step.start) ||
    canonicalValueDigest(bound.value.payload.inputs) !== canonicalValueDigest(step.startRecord.payload.inputs) ||
    canonicalValueDigest(bound.value.payload.exactInputs) !== canonicalValueDigest(step.startRecord.payload.exactInputs)
  )
    throw new Error(`Native plan RESULT not authenticated after readback: ${JSON.stringify(bound)}`)
  return { published, result, read: after.read, receipt: published.receipt, record: bound.value }
}

/** Persist one actual draft and two independently captured specialist judgments. */
export async function produceNativePlan(
  input: Context & { output: PlanOutput; reviews: readonly [PlanReview, PlanReview] },
) {
  const initial = await observe(input)
  requireUnplannedHistory(initial.issue)
  const draft = await openNativePlanStep(input, 'plan')
  const planTask = draft.opened.followUp.tasks.tasks[0]
  if (!planTask || draft.opened.followUp.tasks.tasks.length !== 1)
    throw new Error('Native plan draft task is ambiguous')
  const plan = await publishNativePlanStep(input, draft, [
    { task: planTask.name, childId: 'native-plan', value: input.output },
  ])
  if (!plan.published.published || !('record' in plan) || !plan.record || !('receipt' in plan) || !plan.receipt)
    throw new Error(`Native plan publication refused: ${JSON.stringify(plan.published)}`)
  if (plan.record.payload.action !== 'plan' || plan.record.payload.phase !== 'result')
    throw new Error('Readback is not the native plan result')
  const persistedPlan = planOutputSchema.safeParse(plan.record.payload.structured)
  if (!persistedPlan.success || canonicalValueDigest(persistedPlan.data) !== canonicalValueDigest(input.output))
    throw new Error('Native plan output differs from its captured claim')
  const review = await openNativePlanStep(input, 'plan-review')
  if (review.startRecord.payload.action !== 'plan-review' || review.startRecord.payload.phase !== 'start')
    throw new Error('Native plan review START lacks slots')
  const slots = review.startRecord.payload.slots
  if (slots.length !== 2) throw new Error('Native plan review did not declare both specialist slots')
  const slotActions = slots.map((slot) => {
    if (!slot.action) throw new Error(`Native plan review slot ${slot.slotId} lacks its sealed action`)
    return { slotId: slot.slotId, specialist: slot.specialist, action: slot.action }
  })
  if (review.startRecord.payload.exactInputs.planDigest !== planDigest(persistedPlan.data))
    throw new Error('Native plan review is not bound to the persisted plan output')
  const reviewTasks = review.opened.followUp.tasks.tasks
  if (reviewTasks.length !== 2) throw new Error('Native plan review task count is wrong')
  const reviewed = await publishNativePlanStep(
    input,
    review,
    reviewTasks.map((task, index) => {
      const value = input.reviews[index]
      if (value === undefined) throw new Error('Native plan review task lacks its specialist judgment')
      return { task: task.name, childId: `native-plan-review-${task.name}`, value }
    }),
  )
  const verifyReview = () => {
    if (
      !reviewed.published.published ||
      !('record' in reviewed) ||
      !reviewed.record ||
      !('receipt' in reviewed) ||
      !reviewed.receipt
    )
      throw new Error(`Native plan review publication refused: ${JSON.stringify(reviewed.published)}`)
    if (
      reviewed.record.payload.action !== 'plan-review' ||
      reviewed.record.payload.phase !== 'result' ||
      reviewed.record.payload.contributions.length !== slots.length ||
      reviewed.record.payload.contributions.some(
        (contribution) => contribution.host.childId === null || contribution.rawAttempts.length === 0,
      )
    )
      throw new Error('Native plan review did not retain both actual specialist submissions')
    return { receipt: reviewed.receipt, record: reviewed.record, read: reviewed.read }
  }
  const verifiedReview = verifyReview()
  return {
    initial: initial.read,
    planStart: draft.start,
    planStartRecord: draft.startRecord,
    planResult: plan.receipt,
    planRecord: plan.record,
    reviewStart: review.start,
    reviewStartRecord: review.startRecord,
    reviewResult: verifiedReview.receipt,
    reviewRecord: verifiedReview.record,
    slotActions,
    planDigest: planDigest(persistedPlan.data),
    read: verifiedReview.read,
  }
}
