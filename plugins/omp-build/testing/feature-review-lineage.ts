import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { bindExternalRef, recordsOf } from '../engine/workflow-control.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import { selectedReviewRoot } from '../roxabi/uw-selected-review.ts'
import { reviewRecords } from '../skills/feature/workflow-records.js'
import { reviewStep } from '../skills/feature/workflow-review-state.js'
import {
  correctionCriteria,
  guardCommand,
  restoredSave,
  settleOwnedCorrectionFalsification,
} from './feature-review-falsification.ts'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { citedHistory, history } from './feature-review-race-history.ts'
import { reviewDecision } from './feature-review-synthesis-sources.ts'
import { createReviewDriver, type ReviewDriver } from './native-review-driver.ts'
import { finding } from './record-builders.ts'

type Capture = { head: string; fingerprint: string; causes: string[] }

function reviewData(task: NativeTask, round: number) {
  if (round !== 2 || !task.name.startsWith('panel-')) return reviewInitialData(task)
  const spec = task.action.inputs.manifest.spec
  if (spec.kind !== 'accepted' || spec.effective.spec.criteria[0] === undefined)
    throw new Error('review-fixture-accepted-criterion-missing')
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
        description: 'Saving accepts an empty region.',
        location: { file: 'src/save.ts', line: 1 },
        rootCause: 'The save path does not reject a missing selected region.',
        symptomsEvidence: 'An empty selected region can be saved.',
      }),
    ],
  }
}

async function runReview(driver: ReviewDriver, captures: Capture[], round: number): Promise<number> {
  await driver.settle((task: NativeTask) => {
    if (task.name === 'spec') {
      captures.push({
        head: task.action.inputs.manifest.code.head,
        fingerprint: task.action.inputs.fingerprint,
        causes: task.action.inputs.manifest.deliveryData
          .filter((ref) => ref.role === 'cause-state')
          .map((ref) => ref.record.recordId),
      })
    }
    return reviewData(task, round)
  })
  const after = driver.messages.length
  await driver.settle((task) => reviewDecision(task.task))
  return after
}

async function runCorrection(driver: ReviewDriver, cwd: string, round: number): Promise<void> {
  const prior = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  const corrected =
    round === 1
      ? restoredSave
      : 'export function save(region: string) { if (!region) throw new Error("region required"); return region }\n'
  const transition = driver.fixTransition(driver.messages.length)
  let commit: string | null = null
  await driver.settleAction(
    (task) => {
      if (commit === null) throw new Error('correction-commit-missing')
      return {
        outcome: 'applied',
        commitSHAs: [commit],
        commands: [],
        proofToolCallId: `${task.name}-proof`,
        proofUnavailableReason: null,
        proofPaths: [],
        criteria: correctionCriteria(task, commit),
        guardInventory: [
          {
            guardId: 'selected-region-guard',
            productionGuard: 'save retains the selected region',
            paths: ['src/save.ts'],
            intendedScenario: 'saving after a region selection retains that region',
          },
        ],
      }
    },
    {
      command: guardCommand,
      program: 'bash',
      args: ['-c', guardCommand],
      prepare: () => {
        writeFileSync(path.join(cwd, 'src/save.ts'), corrected)
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'src/save.ts'], { cwd })
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', `fix: review round ${round}`],
          { cwd },
        )
        commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
      },
    },
  )
  await transition
  const applied = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  if (commit !== applied || applied === prior) throw new Error('correction-transition-refused')
  const result = await settleOwnedCorrectionFalsification(driver, cwd, applied, prior, corrected)
  if (result.terminal.status !== 'complete')
    throw new Error(`correction-terminal-refused:${JSON.stringify(result.terminal)}`)
  await driver.nextBatch(result.reviewAfter)
}

async function priorCauseIds(cwd: string): Promise<string[]> {
  const source = await history(cwd)
  const histories = await citedHistory(cwd, source)
  return histories
    .flatMap(recordsOf)
    .filter((record) => record.kind === 'cause-disposition' || record.kind === 'cause-operation')
    .map((record) => record.recordId)
}

function authenticatedReviewRoots(source: DecodedHistory) {
  return recordsOf(source).flatMap((record) => {
    if (record.kind !== 'review') return []
    const selected = selectedReviewRoot(source, record.recordId)
    if (!selected.ok) throw new Error('selected-review-root-invalid')
    const bound = bindExternalRef(selected.value, source)
    if (!bound.ok || bound.value.kind !== 'review-attempt') throw new Error('selected-review-inventory-unbound')
    const root = bound.value
    if (
      root.payload.stage !== 'initial' ||
      root.payload.purpose !== 'review' ||
      root.payload.rootAttemptId !== root.recordId
    )
      throw new Error('selected-review-inventory-not-root')
    return [{ id: root.recordId, head: root.payload.candidateGitSHA, fingerprint: root.payload.actionInputDigest }]
  })
}

function inventoryIds(source: DecodedHistory): string[] {
  return recordsOf(source)
    .filter((record) => record.kind === 'review-attempt')
    .map((record) => record.recordId)
    .sort()
}

export async function invokeSuccessiveReviewLineage(cwd: string) {
  const started = performance.now()
  const driver = await createReviewDriver(cwd)
  const captures: Capture[] = []
  const expected: string[][] = []
  const timings: Array<{ phase: string; ms: number }> = []
  let checkpoint = started
  const mark = (phase: string) => {
    const now = performance.now()
    timings.push({ phase, ms: now - checkpoint })
    checkpoint = now
  }
  mark('driver-start')
  try {
    for (let round = 1; round <= 3; round++) {
      const reviewAfter = await runReview(driver, captures, round)
      if (round === 3) {
        try {
          await driver.nextBatch(reviewAfter)
        } catch {
          /* Inspect durable stop and actor state below. */
        }
      }
      mark(`review-${round}`)
      if (round < 3) {
        await runCorrection(driver, cwd, round)
        expected.push(await priorCauseIds(cwd))
        mark(`correction-${round}`)
      }
    }
    const current = await history(cwd)
    const summary = reviewRecords(current, { externalHistories: await citedHistory(cwd, current) })
    if (!summary.ok) throw new Error(`review-history-invalid:${JSON.stringify(summary.diagnostics)}`)
    const roots = authenticatedReviewRoots(current)
    const before = roots.length
    const inventoriesBefore = inventoryIds(current)
    const activeBefore = driver.controller.active()
    try {
      await driver.continueFeature()
    } catch {
      /* Durable state and actor state determine the outcome. */
    }
    const activeAfter = driver.controller.active()
    const afterHistory = await history(cwd)
    const after = authenticatedReviewRoots(afterHistory).length
    const inventoriesAfter = inventoryIds(afterHistory)
    mark('fourth-review-refusal')
    return {
      captures,
      expected,
      roots,
      reviews: summary.value.reviews,
      step: reviewStep(summary.value, { head: summary.value.head }),
      before,
      after,
      inventoriesBefore,
      inventoriesAfter,
      activeBefore,
      timings,
      activeAfter,
    }
  } finally {
    await driver.controller.stop('lineage-test-cleanup')
  }
}
