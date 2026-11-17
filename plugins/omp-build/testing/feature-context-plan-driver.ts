import { execFileSync } from 'node:child_process'
import type { PlanOutput, PlanReview } from '../engine/workflow-output-schema.ts'
import type { ContinueFeatureResult } from '../roxabi/feature-contract.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { continueFeature } from '../roxabi/workflow.ts'
import { SCOPE } from './feature-recovery-fixture.ts'
import { captureNativePlanBatch } from './native-plan-capture.ts'

/** Publish the successor's actual draft and both specialist reviews through native capture. */
export async function finishContextPlan(
  cwd: string,
  operator: OperatorPort,
  selected: ContinueFeatureResult,
  options: { reference?: string; path?: string } = {},
) {
  if (selected.kind !== 'action' || selected.node !== 'plan')
    throw new Error(`Successor plan unavailable: ${JSON.stringify(selected)}`)
  const git = (revision: string) => execFileSync('git', ['rev-parse', revision], { cwd, encoding: 'utf8' }).trim()
  const identity = { repository: SCOPE.repository, commit: git('HEAD'), tree: git('HEAD^{tree}') }
  const draft: PlanOutput = {
    steps: [
      {
        id: 'preserve-region',
        criterionIds: ['C1'],
        change: 'Preserve the selected region and timezone',
        doneWhen: 'The region and timezone are preserved',
        evidence: 'An executable check verifies the saved region',
        paths: [options.path ?? 'README.md'],
      },
    ],
    resolutions: [],
  }
  const draftTask = selected.followUp.tasks.tasks[0]
  if (!draftTask) throw new Error('Successor plan task unavailable')
  const captured = await captureNativePlanBatch({
    batch: selected.followUp,
    cwd,
    git: identity,
    claims: [{ task: draftTask.name, childId: 'successor-plan-child', value: draft }],
  })
  const published = await publishFeatureNativeResult({ cwd, start: selected.start, result: captured })
  if (!published.published) throw new Error(`Successor plan publication failed: ${JSON.stringify(published)}`)
  const uw = await createInstalledUwOperations({ cwd, operator })
  const review = await continueFeature({
    cwd,
    reference: options.reference ?? '#42',
    control: 'continue',
    principal: false,
    uw,
  })
  if (review.kind !== 'action' || review.node !== 'plan-review')
    throw new Error(`Successor plan review unavailable: ${JSON.stringify(review)}`)
  const clear: PlanReview = { outcome: 'clear', blockers: [] }
  const reviewCapture = await captureNativePlanBatch({
    batch: review.followUp,
    cwd,
    git: identity,
    claims: review.followUp.tasks.tasks.map((task, index) => ({
      task: task.name,
      childId: `successor-review-${index}`,
      value: clear,
    })),
  })
  if (review.followUp.tasks.tasks.length !== 2) throw new Error('Expected two successor plan reviewers')
  const reviewPublished = await publishFeatureNativeResult({ cwd, start: review.start, result: reviewCapture })
  if (!reviewPublished.published)
    throw new Error(`Successor review publication failed: ${JSON.stringify(reviewPublished)}`)
  return { selected, published, reviewPublished }
}
