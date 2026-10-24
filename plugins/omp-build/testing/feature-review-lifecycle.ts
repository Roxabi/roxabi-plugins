import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'

import { settleOwnedCorrectionFalsification } from './feature-review-falsification.ts'
import { createReviewDriver, type NativeData, type ReviewDriver } from './native-review-driver.ts'
import { finding } from './record-builders.ts'

type Mode = 'fix' | 'fresh-pause' | 'publication-pause'
type Data = NativeData

type SynthesisSources = { sourceContributionIds: string[]; sourceFindingIds: string[] }

function synthesisPayload(task: string): unknown {
  const marker =
    'Confirmed native source contributions (every original ID, provenance, extracted evidence, structured output, and raw attempt is authoritative):\n\n'
  const markerAt = task.indexOf(marker)
  if (markerAt === -1) throw new Error('synthesis-sources-missing')
  return JSON.parse(task.slice(markerAt + marker.length))
}

function collectSourceIds(source: unknown, result: SynthesisSources): void {
  if (
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    !('contributionId' in source) ||
    !('payload' in source)
  )
    throw new Error('synthesis-source-invalid')
  const contributionId = source.contributionId
  const payload = source.payload
  if (typeof contributionId !== 'string' || payload === null || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('synthesis-source-invalid')
  result.sourceContributionIds.push(contributionId)
  if (!('findings' in payload) || !Array.isArray(payload.findings)) return
  for (const item of payload.findings) {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      !('id' in item) ||
      typeof item.id !== 'string'
    )
      throw new Error('synthesis-finding-invalid')
    result.sourceFindingIds.push(item.id)
  }
}

function decodeSynthesisSources(task: string): SynthesisSources {
  const sources = synthesisPayload(task)
  if (!Array.isArray(sources)) throw new Error('synthesis-sources-invalid')
  const result: SynthesisSources = { sourceContributionIds: [], sourceFindingIds: [] }
  for (const source of sources) collectSourceIds(source, result)
  if (result.sourceContributionIds.length === 0 || result.sourceFindingIds.length === 0)
    throw new Error('synthesis-evidence-missing')
  return result
}
export function reviewDecision(task: string): Data {
  const { sourceContributionIds, sourceFindingIds } = decodeSynthesisSources(task)
  return {
    purpose: 'review',
    policy: { version: 'baseline' },
    sourceContributionIds,
    findings: [
      {
        id: 'selected-region-blocker',
        label: 'issue(blocking)',
        impactReason: 'The saved region can be stale.',
        state: 'usable',
        sourceFindingIds,
        description: 'Persist the selected region.',
        mergeReason: 'Both panel reports identify the same stale selected-region persistence defect.',
      },
    ],
    causes: [
      {
        id: 'selected-region-cause',
        title: 'Selected region persistence',
        mechanism: 'The save path retains a stale selected region.',
        fix: 'Persist the current selected region in the save path.',
        failure: 'A save after selecting a region stores the previous region.',
        restored: 'Saving retains the selected region.',
        paths: ['src/save.ts'],
        proof: 'Exercise a save after selecting a region.',
        findingIds: ['selected-region-blocker'],
        authorization: 'required',
      },
    ],
    standards: {
      state: 'observed',
      rows: [{ smell: 'State persistence', assessment: 'The save path must preserve the selected region.' }],
    },
  }
}

export function reviewInitialData(task: { name: string }): Data {
  if (task.name === 'spec')
    return { findings: [], specRows: [{ criterionText: 'preserves the region', verdict: 'met' }] }
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

export async function invokeOmpReviewApplyFalsify(cwd: string): Promise<object> {
  const driver = await createReviewDriver(cwd)
  await driver.settle(reviewInitialData)
  await driver.settle((task) => reviewDecision(task.task))
  const transition = driver.fixTransition(driver.messages.length)
  const stateFile = process.env.GH_SIM_STATE
  if (stateFile === undefined) throw new Error('gh-state-missing')
  let commit: string | null = null
  try {
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
        command: 'git status --porcelain',
        args: ['status', '--porcelain'],
        prepare: () => {
          writeFileSync(path.join(cwd, 'src/save.ts'), 'export const save = "selected-region"\n')
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
    const transitionOutcome = await transition
    const falsifyActive = driver.controller.active()
    const terminal = await settleOwnedCorrectionFalsification(driver, cwd)
    return {
      active: driver.controller.active(),
      comments: readComments(stateFile),
      commit,
      falsifyActive,
      messages: driver.messages,
      terminal,
      transitionOutcome,
    }
  } finally {
    await driver.controller.stop('test-cleanup')
  }
}
export async function invokeOmpReviewLifecycle(cwd: string, mode: Mode): Promise<object> {
  const driver = await createReviewDriver(cwd)
  if (mode === 'fresh-pause') return freshPause(driver)
  await driver.settle(reviewInitialData)
  return mode === 'fix' ? finishFix(driver) : pauseDuringPublication(driver)
}
