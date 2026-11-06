import type { withNativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { openNativePlanStep, publishNativePlanStep } from '../../testing/native-plan-producer.ts'
import type { Scope } from '../record-values.ts'
import type { SpecEffective } from '../spec-effective-schema.ts'
import type { MandateRecord } from '../workflow-control.ts'

/** Capture both planning stages against the current native observation and checkout. */
export async function captureSamePrPlan(input: {
  world: Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]
  scope: Scope
  mandate: MandateRecord
  effective: SpecEffective
  commit: string
  tree: string
}) {
  const context = {
    world: input.world,
    scope: input.scope,
    mandate: input.mandate,
    parentScopes: [],
    git: { repository: input.scope.repository, commit: input.commit, tree: input.tree },
  }
  const draft = await openNativePlanStep(context, 'plan')
  const task = draft.opened.followUp.tasks.tasks[0]
  if (!task || draft.opened.followUp.tasks.tasks.length !== 1) throw new Error('Expected one plan task')
  const plan = await publishNativePlanStep(context, draft, [
    {
      task: task.name,
      childId: `plan-${draft.opened.followUp.operationId}`,
      value: {
        steps: input.effective.spec.criteria.map((criterion) => ({
          id: `step-${criterion.id}`,
          change: criterion.statement,
          doneWhen: criterion.statement,
          criterionIds: [criterion.id],
          evidence: 'Captured test evidence',
          paths: ['first.txt'],
        })),
        resolutions: [],
      },
    },
  ])
  if (!plan.published.published || !('record' in plan) || !plan.record)
    throw new Error(`Native plan publication refused: ${JSON.stringify(plan.published)}`)
  const review = await openNativePlanStep(context, 'plan-review')
  const tasks = review.opened.followUp.tasks.tasks
  if (tasks.length !== 2) throw new Error('Expected two independent plan reviewers')
  const reviewed = await publishNativePlanStep(
    context,
    review,
    tasks.map((item) => ({
      task: item.name,
      childId: `review-${review.opened.followUp.operationId}-${item.name}`,
      value: { outcome: 'clear' as const, blockers: [] },
    })),
  )
  if (!reviewed.published.published || !('record' in reviewed) || !reviewed.record)
    throw new Error(`Native plan review publication refused: ${JSON.stringify(reviewed.published)}`)
  return [draft.startRecord, plan.record, review.startRecord, reviewed.record]
}
