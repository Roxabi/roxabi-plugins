import { execFileSync } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import { requiredReviewRecords } from '../skills/feature/workflow-records.js'
import {
  correctionCriteria,
  guardCommand,
  restoredSave,
  settleOwnedCorrectionFalsification,
} from './feature-review-falsification.ts'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { fixtureSpecRow } from './feature-review-spec-row.ts'
import { cleanReviewDecision, reviewDecision } from './feature-review-synthesis-sources.ts'
import { createReviewDriver } from './native-review-driver.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const scenario = process.argv[3] ?? 'ci'
if (scenario !== 'ci' && scenario !== 'fix-pr' && scenario !== 'fix-issue') throw new Error('fixture-scenario-invalid')
const started = performance.now()
const trace = (phase: string) => {
  if (scenario === 'ci') writeSync(2, `[ci-lifecycle] ${phase} ${Math.round(performance.now() - started)}ms\n`)
}
trace('runner-start')
const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
await installFixtureSdkSettings(cwd)
const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
trace('fixture-ready')
const driver = await createReviewDriver(cwd, 128_000, scenario === 'ci' ? 'feature' : scenario, true)
trace('driver-ready')
const manifests: Array<{ stage: string; inputs: NativeTask['action']['inputs'] }> = []
const capture = (stage: string) => (task: NativeTask) => {
  manifests.push({ stage, inputs: task.action.inputs })
}

let after = driver.messages.length
if (scenario === 'ci') {
  const intakeReady = driver.nextBatch(after)
  await driver.settle((task) => {
    capture('attribution')(task)
    return { attribution: 'change', evidence: null }
  })
  await intakeReady
}
trace('attribution-ready')
after = driver.messages.length
const synthesisReady = driver.nextBatch(after)
await driver.settle((task) => {
  capture('intake')(task)
  return reviewInitialData({ ...task, name: 'panel-ci' })
})
await synthesisReady
trace('intake-ready')
after = driver.messages.length
const applyReady = driver.nextBatch(after)
await driver.settle((task) => {
  capture('synthesis')(task)
  const decision: Record<string, unknown> = reviewDecision(task.task)
  const { standards: _standards, criterionVerdicts: _criterionVerdicts, ...correction } = decision
  return { ...correction, purpose: 'correction' }
})
await applyReady
trace('synthesis-ready')
let commit: string | null = null
const transition = driver.fixTransition(driver.messages.length)
await driver.settleAction(
  (task) => {
    capture('apply')(task)
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
      writeFileSync(path.join(cwd, 'src/save.ts'), restoredSave)
      execFileSync('git', ['add', 'src/save.ts'], { cwd })
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'fix: preserve selected region'],
        { cwd },
      )
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    },
  },
)
if ((await transition) !== 'next-batch' || commit === null || commit === priorHead)
  throw new Error(`correction-apply-refused: ${JSON.stringify(driver.messages)}`)
trace('apply-ready')
const { terminal, reviewAfter } = await settleOwnedCorrectionFalsification(
  driver,
  cwd,
  commit,
  priorHead,
  restoredSave,
  capture('post-apply'),
)
if (terminal.status !== 'complete') throw new Error(`correction-terminal-refused: ${JSON.stringify(terminal)}`)
trace('falsification-complete')
if (scenario !== 'ci') await driver.continueFeature()
await driver.nextBatch(reviewAfter)
trace('follow-on-ready')
await driver.settle((task) => {
  capture('follow-on-review')(task)
  return task.name === 'spec' ? { findings: [], specRows: [fixtureSpecRow(task.action)] } : { findings: [] }
})
trace('follow-on-review-complete')
await driver.settle((task) => {
  capture('follow-on-synthesis')(task)
  return cleanReviewDecision(task.task)
})
trace('follow-on-synthesis-complete')
const replay = await requiredReviewRecords(cwd, 7)
if (replay.head !== commit || replay.verdict !== 'Approve (clean)')
  throw new Error(`follow-on-review-refused: ${JSON.stringify(replay)}`)
trace('replay-complete')
process.stdout.write(`${JSON.stringify({ priorHead, commit, manifests, replay, messages: driver.messages })}\n`)
process.exit(0)
