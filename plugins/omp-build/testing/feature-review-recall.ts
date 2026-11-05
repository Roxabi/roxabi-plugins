import { recordsOf } from '../engine/workflow-control.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { history } from './feature-review-race-history.ts'
import { reviewDecision } from './feature-review-synthesis-sources.ts'
import { createReviewDriver } from './native-review-driver.ts'
import { finding } from './record-builders.ts'

function initialData(task: NativeTask) {
  if (!task.name.startsWith('panel-')) return reviewInitialData(task)
  const spec = task.action.inputs.manifest.spec
  if (spec.kind !== 'accepted' || spec.effective.spec.criteria[0] === undefined)
    throw new Error('recall-criterion-missing')
  return {
    findings: [
      finding({
        label: 'issue(blocking)',
        target: {
          format: 'omp-build-finding-target/1',
          kind: 'criterion',
          spec: spec.effective.own,
          id: spec.effective.spec.criteria[0].id,
        },
        description: 'Saving discards the selected region.',
        location: { file: 'src/save.ts', line: 1 },
        rootCause: 'The save path persists a stale selected region.',
        symptomsEvidence: 'Selecting a region then saving restores the previous region.',
        classes: ['test-tautology'],
        rawCallsites: [1, 2, 3].map((line) => ({ file: 'src/save.ts', line })),
      }),
    ],
  }
}

export async function invokeRecallFixContinuation(cwd: string) {
  const driver = await createReviewDriver(cwd, 3000)
  try {
    await driver.settle(initialData)
    const recall = driver.controller.active()
    if (recall === null || !recall.tasks.tasks.some((task) => task.name.startsWith('recall-')))
      throw new Error('actual-recall-not-triggered')
    await driver.settle(() => ({ findings: [] }))
    await driver.settle((task) => reviewDecision(task.task))
    const records = recordsOf(await history(cwd))
    const published = records.find((record) => record.kind === 'review-attempt' && record.payload.stage === 'recall')
    const review = records.find(
      (record) =>
        record.kind === 'review' && published !== undefined && record.payload.inventoryIds.includes(published.recordId),
    )
    return {
      published: published !== undefined,
      reviewReferencesRecall: review !== undefined,
      fixActive: driver.fixRun() !== undefined,
      messages: driver.messages,
      diagnostics: driver.diagnostics,
    }
  } finally {
    await driver.controller.stop('recall-fixture-cleanup')
  }
}
