import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import { requiredReviewRecords } from '../skills/feature/workflow-records.js'
import { diagnostic as ciDiagnostic } from './ci-diagnostic.ts'
import {
  correctionCriteria,
  guardCommand,
  restoredSave,
  settleOwnedCorrectionFalsification,
} from './feature-review-falsification.ts'
import { fixtureSpecRow } from './feature-review-spec-row.ts'
import { cleanReviewDecision, reviewDecision } from './feature-review-synthesis-sources.ts'
import { finishFixtureDiagnostic } from './native-review-diagnostics.ts'
import { createReviewDriver, type NativeData, type ReviewDriver } from './native-review-driver.ts'
import { finding } from './record-builders.ts'

type Mode = 'fix' | 'fresh-pause' | 'publication-pause'
type Data = NativeData

export function reviewInitialData(task: NativeTask): Data {
  if (task.name === 'spec') return { findings: [], specRows: [fixtureSpecRow(task.action)] }
  if (!task.name.startsWith('panel-')) return { findings: [] }
  return {
    findings: [
      finding({
        label: 'issue(blocking)',
        description: 'Saving discards the selected region.',
        location: { file: 'src/save.ts', line: 1 },
        rootCause: 'The save path persists a stale selected region.',
        symptomsEvidence: 'Selecting a region then saving restores the previous region.',
      }),
    ],
  }
}

function waitFor(pathname: string, completion: Promise<unknown>): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  const finish = (error?: Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    watcher.close()
    if (error === undefined) resolve()
    else reject(error)
  }
  const timer = setTimeout(() => finish(new Error('final-review-publication-barrier-timeout')), 10_000)
  const watcher = watch(path.dirname(pathname), (_event, filename) => {
    if (filename === path.basename(pathname) && existsSync(pathname)) finish()
  })
  void completion.then(
    () => finish(new Error('final-review-publication-settled-before-barrier')),
    (error) => finish(error instanceof Error ? error : new Error(String(error))),
  )
  return promise
}

function readComments(stateFile: string): unknown[] {
  return JSON.parse(readFileSync(stateFile, 'utf8')).issues['42'].comments
}

async function freshPause(driver: ReviewDriver): Promise<object> {
  await driver.pause()
  const stateFile = process.env.GH_SIM_STATE
  if (stateFile === undefined) throw new Error('gh-state-missing')
  return {
    messages: driver.messages,
    active: driver.controller.active(),
    comments: readComments(stateFile),
    barrier: false,
  }
}

async function finishFix(driver: ReviewDriver): Promise<object> {
  await driver.settle((task) => reviewDecision(task.task))
  const active = driver.controller.active()
  const fixRun = driver.fixRun()
  const stateFile = process.env.GH_SIM_STATE
  if (stateFile === undefined) throw new Error('gh-state-missing')
  try {
    return {
      messages: driver.messages,
      active,
      fixRun: fixRun ? { runId: fixRun.runId, operationId: fixRun.operationId } : null,
      comments: readComments(stateFile),
      barrier: false,
    }
  } finally {
    await driver.controller.stop('test-cleanup')
  }
}

async function pauseDuringPublication(driver: ReviewDriver): Promise<object> {
  const root = process.env.GH_SIM_STATE
  if (root === undefined) throw new Error('gh-state-missing')
  const started = `${root}.final-review-started`
  const release = `${root}.final-review-release`
  Object.assign(process.env, {
    GH_SIM_COMMENT_BARRIER_MATCH: 'kind=review ',
    GH_SIM_COMMENT_BARRIER_STARTED: started,
    GH_SIM_COMMENT_BARRIER_RELEASE: release,
  })
  const publication = driver.settle((task) => reviewDecision(task.task))
  let pendingPause: Promise<unknown> | null = null
  let beforeRelease = 0
  try {
    await waitFor(started, publication)
    pendingPause = driver.pause()
    beforeRelease = driver.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH')).length
  } finally {
    if (!existsSync(release)) writeFileSync(release, 'release\n')
    if (pendingPause === null) await publication
    else await Promise.all([publication, pendingPause])
  }
  return {
    messages: driver.messages,
    active: driver.controller.active(),
    beforeRelease,
    comments: readComments(root),
    barrier: true,
  }
}

function driverDiagnostic(driver: ReviewDriver | undefined) {
  if (driver === undefined) return null
  const active = driver.controller.active()
  return {
    callbacks: driver.diagnostics,
    messages: driver.messages.map((message) => {
      if (message.includes('OMP_BUILD_NATIVE_BATCH')) return 'OMP_BUILD_NATIVE_BATCH'
      return message.split(':', 1)[0]
    }),
    active:
      active === null
        ? null
        : {
            operationId: active.operationId,
            tasks: active.tasks.tasks.map((task) => ({
              name: task.name,
              agent: task.agent,
              actionId: task.action.snapshot.actionId,
              fingerprint: task.action.inputs.fingerprint,
              head: task.action.inputs.manifest.code.head,
              refs: task.action.inputs.manifest.deliveryData.map((ref) => ({
                role: ref.role,
                kind: ref.record.kind,
                recordId: ref.record.recordId,
                selector: ref.selector,
              })),
            })),
          },
  }
}

export async function invokeOmpReviewApplyFalsify(cwd: string): Promise<object> {
  ciDiagnostic('phase', 'child-review-entry')
  const priorHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  const driver = await createReviewDriver(cwd)
  ciDiagnostic('phase', 'child-driver-created')
  let primary: unknown
  let failed = false
  let outcome: object | undefined
  let stage = 'initial-review'
  try {
    await driver.settle(reviewInitialData)
    ciDiagnostic('phase', 'child-initial-review-complete')
    stage = 'initial-synthesis'
    await driver.settle((task) => reviewDecision(task.task))
    ciDiagnostic('phase', 'child-initial-synthesis-complete')
    const transition = driver.fixTransition(driver.messages.length)
    const stateFile = process.env.GH_SIM_STATE
    if (stateFile === undefined) throw new Error('gh-state-missing')
    let commit: string | null = null
    stage = 'correction-apply'
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
          writeFileSync(path.join(cwd, 'src/save.ts'), restoredSave)
          execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'src/save.ts'], { cwd })
          execFileSync(
            'git',
            ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'fix: preserve selected region'],
            {
              cwd,
            },
          )
          commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
        },
      },
    )
    ciDiagnostic('phase', 'child-correction-apply-complete')
    stage = 'correction-transition'
    const transitionOutcome = await transition
    ciDiagnostic('phase', 'child-correction-transition-complete')
    const falsifyActive = driver.controller.active()
    const appliedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    if (commit !== appliedHead || appliedHead === priorHead) throw new Error('correction-fixture-head-mismatch')
    stage = 'falsification-and-restoration'
    const { terminal, snapshots, reviewAfter } = await settleOwnedCorrectionFalsification(
      driver,
      cwd,
      appliedHead,
      priorHead,
    )
    ciDiagnostic('phase', 'child-falsification-complete')
    if (terminal.status !== 'complete')
      throw new Error(`correction-fixture-terminal-refused: ${JSON.stringify(terminal)}`)
    stage = 'automatic-final-review-start'
    await driver.nextBatch(reviewAfter)
    ciDiagnostic('phase', 'child-final-review-started')
    const reviewSnapshots: Array<{ head: string; index: string; fingerprint: string; sourceRecordId: string }> = []
    stage = 'final-review-initial'
    await driver.settle((task) => {
      if (task.name !== 'spec') return { findings: [] }
      const manifest = task.action.inputs.manifest
      const source = manifest.deliveryData.find(
        (ref) => ref.role === 'implementation' && ref.record.kind === 'fix-result',
      )
      if (manifest.code.head !== appliedHead || source === undefined)
        throw new Error('correction-fixture-final-review-source-mismatch')
      reviewSnapshots.push({
        head: manifest.code.head,
        index: task.action.snapshot.indexPath,
        fingerprint: task.action.inputs.fingerprint,
        sourceRecordId: source.record.recordId,
      })
      return { findings: [], specRows: [fixtureSpecRow(task.action)] }
    })
    ciDiagnostic('phase', 'child-final-review-initial-complete')
    stage = 'final-review-synthesis'
    await driver.settle((task) => cleanReviewDecision(task.task))
    ciDiagnostic('phase', 'child-final-review-synthesis-complete')
    stage = 'remote-review-replay'
    const replay = await requiredReviewRecords(cwd, 7)
    ciDiagnostic('phase', 'child-remote-replay-complete')
    if (replay.head !== appliedHead || replay.verdict !== 'Approve (clean)')
      throw new Error(`correction-fixture-remote-review-refused: ${JSON.stringify(replay)}`)
    outcome = {
      active: driver.controller.active(),
      comments: readComments(stateFile),
      snapshots,
      reviewSnapshots,
      replay,
      priorHead,
      commit,
      falsifyActive,
      messages: driver.messages,
      terminal,
      transitionOutcome,
    }
  } catch (error) {
    failed = true
    primary = error
  }
  const diagnostic = { stage, driver: () => driverDiagnostic(driver) }
  await finishFixtureDiagnostic(driver.controller, diagnostic, failed, primary)
  ciDiagnostic('phase', 'child-cleanup-complete')
  if (outcome === undefined) throw new Error('native-fixture-outcome-missing')
  return outcome
}
export async function invokeOmpReviewLifecycle(cwd: string, mode: Mode): Promise<object> {
  const driver = await createReviewDriver(cwd)
  if (mode === 'fresh-pause') return freshPause(driver)
  await driver.settle(reviewInitialData)
  return mode === 'fix' ? finishFix(driver) : pauseDuringPublication(driver)
}
