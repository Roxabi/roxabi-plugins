import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ActionInputs, RecordInputRef } from '../../../../engine/action-input-schema.ts'
import { parseRecord } from '../../../../engine/record-construction.ts'
import type { ExternalRecordRef } from '../../../../engine/record-references.ts'
import type { Scope } from '../../../../engine/record-values.ts'
import type { UwCompletion } from '../../../../engine/uw-completion-types.ts'
import { scopeKey } from '../../../../engine/uw-graph.ts'
import { recordsOf } from '../../../../engine/workflow-control.ts'
import { captureSubagentEvent } from '../../../../omp/review-runtime/capture.ts'
import { captureChildResult, groundCapturedChildren } from '../../../../omp/review-runtime/child-capture.ts'
import type { Json, NativeBatch, NativeBatchResult } from '../../../../omp/review-runtime/contracts.ts'
import { createActiveBatch } from '../../../../omp/review-runtime/state.ts'
import { type PreparedEpicReview, prepareEpicFinalReviewMaterials } from '../../../../roxabi/epic-range-finalization.ts'
import type {
  PreparedReviewBatch,
  PublishedContribution,
  ReviewContext,
  ReviewPublisher,
} from '../../../../roxabi/review-contract.ts'
import type { UwRead } from '../../../../roxabi/uw-contract.ts'
import {
  currentParentIntegration,
  type ParentIntegrationRead,
} from '../../../../roxabi/uw-parent-current-integration.ts'
import { criterionEpicReviewGraph } from '../../../../testing/criterion-range-approval.ts'
import { createEpicDriver } from '../../epic-driver.ts'
import { type EpicStepRead, epicFinalReviewRequest } from '../../epic-driver-control.ts'
import { withEpicEffects } from '../../epic-driver-runtime.ts'
import { landedEpic } from './epic-driver-landed-fixture.ts'
import { prepareEpicParentReview } from './epic-driver-parent-review.ts'
import { cleanupSandbox, git, sandboxOf } from './epic-driver-sandbox.ts'

/** Native SDK-shaped submissions are captured against the actual assigned review tasks. */
async function captureReviewBatch(
  batch: NativeBatch,
  cwd: string,
  claims: readonly Json[],
): Promise<NativeBatchResult> {
  if (batch.tasks.tasks.length !== claims.length) throw new Error('Review claims do not cover the actual task roster')
  const identity = {
    repository: 'o/r',
    commit: git(cwd, 'rev-parse', 'HEAD'),
    tree: git(cwd, 'rev-parse', 'HEAD^{tree}'),
  }
  const active = createActiveBatch(
    batch,
    { onComplete: async () => {}, onStop: async () => {} },
    cwd,
    null,
    () => identity,
  )
  const captured = batch.tasks.tasks.map((task, index) => {
    const id = `review-native-${index}`
    const claim = claims[index]
    if (claim === undefined) throw new Error('Review claim unavailable for assigned task')
    active.childSlots.set(id, index)
    captureSubagentEvent(
      active,
      {
        id,
        event: { type: 'tool_execution_start', toolName: 'yield', toolCallId: `${id}-yield`, args: { data: claim } },
      },
      true,
    )
    const terminal = { id, exitCode: 0, structuredOutput: { status: 'valid', data: claim } }
    return captureChildResult(active, terminal, task.name, id)
  })
  const children = await groundCapturedChildren(active, captured)
  if (children.some((child) => !child.usable))
    throw new Error(`Review native capture refused: ${JSON.stringify(children)}`)
  return { batch, children, raw: {}, complete: true }
}

async function publishStage(
  publisher: ReviewPublisher,
  context: ReviewContext,
  prepared: PreparedReviewBatch,
  result: NativeBatchResult,
): Promise<PublishedContribution[]> {
  const authorization = await publisher.authorize(context, prepared.stage)
  if (!authorization.ok) throw new Error(`Review stage authorization refused: ${authorization.reason}`)
  const published = await publisher.publishInventory(prepared, () => true)
  if (!published.ok) throw new Error(`Review inventory refused: ${published.reason}`)
  const contributions: PublishedContribution[] = []
  for (const child of result.children) contributions.push(await publisher.publishRawContribution(prepared, child))
  return contributions
}

/** Owns the live sandbox until the caller has inspected the canonical final review and completion. */
export async function withEpicNativeFinalReview<T>(
  use: (evidence: {
    range: string
    input: ActionInputs
    integration: RecordInputRef
    completion: UwCompletion
    decision: ExternalRecordRef
    parentIntegration: ParentIntegrationRead
    read: UwRead
    initialTasks: readonly { name: string; agent: string }[]
    continuation: EpicStepRead
    presentation: { before: UwRead; after: UwRead } | null
  }) => Promise<T>,
  options: {
    editPresentation?: boolean
    onPresentation?: (before: UwRead, after: UwRead) => void
    onPrepared?: (prepared: PreparedEpicReview, issueFile: string) => Promise<void>
  } = {},
): Promise<T> {
  try {
    const world = await landedEpic()
    const parent = await prepareEpicParentReview(world)
    const scope = { repository: 'o/r', target: 'o/r#1' }
    const before = await world.native.operations.readUw(scope)
    if (before.completion.completions.get(scopeKey(scope))?.state === 'complete')
      throw new Error('Parent completed before its independent review')
    const box = sandboxOf()
    const epicHead = git(box.epic, 'rev-parse', 'HEAD')
    const epicBase = git(box.epic, 'rev-parse', 'refs/remotes/origin/main')
    const principalHead = git(world.principal, 'rev-parse', 'HEAD')
    const epicBranch = git(box.epic, 'branch', '--show-current')
    const projection = currentParentIntegration(before, epicBase, principalHead)
    if (
      principalHead !== parent.head ||
      epicBase !== parent.head ||
      epicHead !== parent.head ||
      epicBranch !== '' ||
      !projection.ok ||
      projection.value === null
    )
      throw new Error(
        `Parent checkout/integration mismatch: ${JSON.stringify({ epicHead, epicBase, principalHead, epicBranch, projection })}`,
      )
    if (git(box.epic, 'status', '--porcelain') !== '') throw new Error('Epic review checkout is dirty')
    const sync = (program: string, cwd: string, args: string[], input?: string) => {
      const result = spawnSync(program, args, { cwd, env: box.env, encoding: 'utf8', input })
      if (result.error || result.status !== 0)
        throw new Error(`${program} ${args.join(' ')}: ${result.stderr || result.error?.message}`)
      return result.stdout
    }
    return await withEpicEffects(
      {
        git: (cwd, args) => sync('git', cwd, args),
        gh: (cwd, args, input) => sync('gh', cwd, args, input),
        uw: world.native.operations,
        uwReadAuthor: 'operator',
      },
      async () => {
        let presentation: { before: UwRead; after: UwRead } | null = null
        if (options.editPresentation) {
          const file = path.join(box.state, 'uw-1.json')
          const native = JSON.parse(readFileSync(file, 'utf8'))
          native.data.repository.issue.body += '\n'
          native.data.repository.issue.updatedAt = '2026-10-22T12:00:00Z'
          writeFileSync(file, JSON.stringify(native))
          presentation = { before, after: await world.native.operations.readUw(scope) }
          options.onPresentation?.(presentation.before, presentation.after)
        }
        const request = await epicFinalReviewRequest(box.epic, 1)
        const pluginRoot = path.resolve(import.meta.dirname, '../../../..')
        const commit = git(import.meta.dirname, 'rev-parse', 'HEAD')
        const prepared = await prepareEpicFinalReviewMaterials({
          cwd: box.epic,
          request,
          mandateRef: { scope, kind: 'mandate', recordId: world.parent.recordId },
          git: world.native.git,
          gh: world.native.gh,
          operations: world.native.operations,
          pluginPin: { repository: 'Roxabi/roxabi-plugins', commit, installedRoot: pluginRoot },
        })
        await options.onPrepared?.(prepared, path.join(box.state, 'uw-1.json'))
        const initial = prepared.prepared
        assertReviewRoster(initial)
        const graph = criterionEpicReviewGraph({
          mandate: parent.mandate,
          inputs: parent.inputs,
          head: parent.head,
          range: parent.range,
          issueRecords: parent.issueRecords,
          coverageReferences: parent.coverageReferences,
        })
        const structured = graph.spec.payload.structured
        if (structured === null) throw new Error('Direct criterion review evidence is unavailable')
        const claims = initial.batch.tasks.tasks.map((task) =>
          task.agent === 'R-review-spec' ? structured : { findings: [] },
        )
        const result = await captureReviewBatch(initial.batch, box.epic, claims)
        const initialContributions = await publishStage(prepared.publisher, prepared.context, initial, result)
        const specIndex = initial.batch.tasks.tasks.findIndex((task) => task.agent === 'R-review-spec')
        const spec = initialContributions[specIndex]
        if (!spec) throw new Error('Captured spec contribution unavailable')
        const synthesis = await prepared.publisher.completeStage(initial, result, initialContributions, () => true)
        if (synthesis?.stage !== 'synthesis') throw new Error('Expected actual synthesis stage')
        const judgment = graph.decision.payload.judgment
        if (judgment.purpose !== 'review') throw new Error('Expected independent review judgment')
        const synthesisClaim = {
          ...judgment,
          sourceContributionIds: initialContributions.map((item) => item.id),
          criterionVerdicts: judgment.criterionVerdicts.map((entry) => ({ ...entry, contributionId: spec.id })),
        }
        const synthesisResult = await captureReviewBatch(synthesis.batch, box.epic, [synthesisClaim])
        const synthesisContributions = await publishStage(
          prepared.publisher,
          prepared.context,
          synthesis,
          synthesisResult,
        )
        const next = await prepared.publisher.completeStage(
          synthesis,
          synthesisResult,
          synthesisContributions,
          () => true,
        )
        if (next !== null) throw new Error('Unexpected review stage after synthesis')
        const after = await world.native.operations.readUw(scope)
        const { completion, decision } = completedReview(after, scope)
        const continuation = await createEpicDriver().readEpicStep(box.epic, 1)
        if (continuation.step.action !== 'post-merge')
          throw new Error(
            `Current final review did not release the real post-merge step: ${JSON.stringify(continuation)}`,
          )
        return use({
          range: parent.range,
          input: parent.inputs,
          integration: parent.integrationPin,
          completion,
          parentIntegration: currentParentIntegration(after, parent.head, parent.head),
          read: after,
          decision: { scope, kind: 'decision', recordId: decision.recordId },
          initialTasks: initial.batch.tasks.tasks.map((task) => ({ name: task.name, agent: task.agent })),
          presentation,
          continuation,
        })
      },
    )
  } finally {
    cleanupSandbox()
  }
}

function assertReviewRoster(initial: PreparedReviewBatch): void {
  const inventory = parseRecord(initial.inventory)
  if (
    !inventory.ok ||
    inventory.value.kind !== 'review-attempt' ||
    inventory.value.payload.stage !== 'initial' ||
    inventory.value.payload.purpose !== 'review'
  )
    throw new Error('Initial canonical review inventory missing')
  const slots = inventory.value.payload.slots
  const specSlots = slots.filter((slot) => slot.role === 'R-review-spec' && slot.chunk === null)
  const adversarialSlots = slots.filter((slot) => slot.role === 'R-adversarial' && slot.chunk === null)
  if (
    specSlots.length !== 1 ||
    adversarialSlots.length !== 1 ||
    slots.some((slot) => slot.chunk !== null) ||
    initial.batch.tasks.tasks.filter((task) => task.name === specSlots[0]?.slotId && task.agent === 'R-review-spec')
      .length !== 1 ||
    initial.batch.tasks.tasks.filter(
      (task) => task.name === adversarialSlots[0]?.slotId && task.agent === 'R-review-adversarial',
    ).length !== 1
  )
    throw new Error(
      `Empty-range review lacks its independent context roster: ${JSON.stringify({
        tasks: initial.batch.tasks.tasks.map(({ name, agent, solutionSpace, task }) => ({
          name,
          agent,
          solutionSpace,
          task,
        })),
        slots: inventory.value.payload.slots,
        allocation: inventory.value.payload.allocation,
      })}`,
    )
}

function completedReview(after: UwRead, scope: Scope) {
  const completion = after.completion.completions.get(scopeKey(scope))
  if (after.observation.status !== 'complete' || completion?.state !== 'complete')
    throw new Error(`Parent final review did not complete: ${JSON.stringify(completion)}`)
  const history = after.observation.histories.find(
    (entry) => entry.source.scope.target === scope.target && entry.source.scope.repository === scope.repository,
  )
  const decision =
    history &&
    recordsOf(history).find(
      (record) =>
        record.kind === 'decision' &&
        completion.sources.some((ref) => ref.kind === 'decision' && ref.recordId === record.recordId),
    )
  if (decision?.kind !== 'decision') throw new Error('Completed parent does not cite its final decision')
  return { completion, decision }
}
