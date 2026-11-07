import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadReviewClassCatalogues } from '../roxabi/review-class-catalogues.ts'

import { reviewRecords } from '../skills/feature/workflow-records.js'
import { reviewStep } from '../skills/feature/workflow-review-state.js'
import { gh } from '../skills/feature/workflow-runtime.js'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { citedHistory, history } from './feature-review-race-history.ts'
import { nextReviewRecords } from './feature-review-race-reviews.ts'
import { reviewDecision } from './feature-review-synthesis-sources.ts'
import { createReviewDriver } from './native-review-driver.ts'

type Mode = 'latest' | 'pause'

function waitFor(file: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  let watcher!: ReturnType<typeof watch>
  let timer!: ReturnType<typeof setTimeout>
  const done = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    watcher.close()
    if (error === undefined) resolve()
    else reject(error)
  }
  watcher = watch(path.dirname(file), (_event, name) => {
    if (name === path.basename(file) && existsSync(file)) done()
  })
  timer = setTimeout(() => done(new Error(`git barrier timeout: ${file}`)), 10_000)
  if (existsSync(file)) done()
  return promise
}
type GitBarrier = { started: Promise<void>; release(): void; close(): void }

function gitBarrier(kind: 'preflight' | 'checkout'): GitBarrier {
  const state = process.env.GH_SIM_STATE
  if (state === undefined) throw new Error('gh-state-missing')
  const root = mkdtempSync(path.join(path.dirname(state), 'omp-race-git-'))
  const started = path.join(root, 'started')
  const release = path.join(root, 'release')
  const once = path.join(root, 'once')
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const condition =
    kind === 'preflight'
      ? '[ "$1" = ls-remote ] && [ "$2" = --refs ]'
      : '[ "$1" = worktree ] && [ "$2" = list ] && [ "$3" = --porcelain ]'
  const record = kind === 'preflight' ? 'fix-request' : 'review'
  const script = `#!/bin/sh\nif ${condition} && grep -q "kind=${record} " "$GH_SIM_STATE" && mkdir "$OMP_RACE_GIT_ONCE" 2>/dev/null; then : > "$OMP_RACE_GIT_STARTED"; deadline=$(( $(date +%s) + 20 )); while [ ! -f "$OMP_RACE_GIT_RELEASE" ]; do [ "$(date +%s)" -lt "$deadline" ] || exit 124; sleep 0.01; done; fi\nexec "$OMP_RACE_REAL_GIT" "$@"\n`
  writeFileSync(path.join(root, 'git'), script)
  chmodSync(path.join(root, 'git'), 0o755)
  const before = process.env.PATH
  Object.assign(process.env, {
    PATH: `${root}:${before}`,
    OMP_RACE_GIT_STARTED: started,
    OMP_RACE_GIT_RELEASE: release,
    OMP_RACE_GIT_ONCE: once,
    OMP_RACE_REAL_GIT: real,
  })
  return {
    started: waitFor(started),
    release: () => writeFileSync(release, 'release\n'),
    close: () => {
      if (before === undefined) delete process.env.PATH
      else process.env.PATH = before
      delete process.env.OMP_RACE_GIT_STARTED
      delete process.env.OMP_RACE_GIT_RELEASE
      delete process.env.OMP_RACE_GIT_ONCE
      delete process.env.OMP_RACE_REAL_GIT
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function failNextPost() {
  const state = process.env.GH_SIM_STATE
  if (state === undefined) throw new Error('gh-state-missing')
  const root = mkdtempSync(path.join(path.dirname(state), 'omp-race-gh-'))
  const failed = path.join(root, 'operator-control-post-refused')
  const real = execFileSync('which', ['gh'], { encoding: 'utf8' }).trim()
  const script =
    '#!/bin/sh\nif [ "$1" = api ]; then case " $* " in *" --method POST "*"kind=operator-control "*) : > "$OMP_RACE_POST_REFUSED"; echo gh-race-post-refused >&2; exit 1;; esac; fi\nexec "$OMP_RACE_REAL_GH" "$@"\n'
  writeFileSync(path.join(root, 'gh'), script)
  chmodSync(path.join(root, 'gh'), 0o755)
  const before = process.env.PATH
  process.env.PATH = `${root}:${before}`
  process.env.OMP_RACE_REAL_GH = real
  process.env.OMP_RACE_POST_REFUSED = failed
  return {
    failed: () => existsSync(failed),
    refused: waitFor(failed),
    close: () => {
      if (before === undefined) delete process.env.PATH
      else process.env.PATH = before
      delete process.env.OMP_RACE_REAL_GH
      delete process.env.OMP_RACE_POST_REFUSED
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function continuationPrerequisites(cwd: string, kind: 'preflight' | 'checkout') {
  const source = await history(cwd)
  const records = source.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const externalHistories = await citedHistory(cwd, source)
  const catalogues = await loadReviewClassCatalogues({ histories: [source, ...externalHistories], cwd, gh })
  const summary = reviewRecords(source, { catalogues, externalHistories })
  const requests = records.filter((record) => record.kind === 'fix-request')
  if (kind === 'preflight') {
    if (!source.source.complete || requests.length !== 1) throw new Error('fix-request-not-confirmed-before-race')
    return { complete: true, requests: requests.length }
  }
  const step = summary.ok ? reviewStep(summary.value, { head: summary.value.head }) : null
  if (!source.source.complete || step?.action !== 'fix' || requests.length !== 0)
    throw new Error(
      `fix-selection-not-confirmed-before-pause:${JSON.stringify({ complete: source.source.complete, summary, step, requests })}`,
    )
  return { complete: true, action: step.action, requests: requests.length }
}

type Cleanup = () => void | Promise<void>

async function cleanupRace(steps: readonly Cleanup[]): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

async function completeRace<T>(work: () => Promise<T>, cleanup: () => Promise<unknown[]>, message: string): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await work() }
  } catch (error) {
    outcome = { ok: false, error }
  }
  const errors = await cleanup()
  if (outcome.ok) {
    if (errors.length > 0) throw new AggregateError(errors, message)
    return outcome.value
  }
  if (errors.length > 0) throw new AggregateError([outcome.error, ...errors], `${message}; primary failure preserved`)
  throw outcome.error
}

async function latest(cwd: string) {
  const driver = await createReviewDriver(cwd)
  let barrier: GitBarrier | null = null
  let settling: Promise<void> | null = null
  return completeRace(
    async () => {
      await driver.settle(reviewInitialData)
      const armed = gitBarrier('preflight')
      barrier = armed
      settling = driver.settle((task) => reviewDecision(task.task))
      await armed.started
      const precondition = await continuationPrerequisites(cwd, 'preflight')
      const summary = await nextReviewRecords(cwd)
      armed.release()
      await settling
      const finalHistory = await history(cwd)
      return {
        active: driver.controller.active(),
        messages: driver.messages,
        precondition,
        summary,
        records: finalHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
      }
    },
    () =>
      cleanupRace([
        () => barrier?.release(),
        async () => {
          if (settling !== null) await settling
        },
        () => driver.controller.stop('race-cleanup'),
        () => barrier?.close(),
      ]),
    'review latest race cleanup failed',
  )
}

async function pause(cwd: string) {
  const driver = await createReviewDriver(cwd)
  let barrier: GitBarrier | null = null
  let closePost: { failed(): boolean; refused: Promise<void>; close(): void } | null = null
  let settling: Promise<void> | null = null
  return completeRace(
    async () => {
      await driver.settle(reviewInitialData)
      const armed = gitBarrier('checkout')
      barrier = armed
      settling = driver.settle((task) => reviewDecision(task.task))
      await armed.started
      const precondition = await continuationPrerequisites(cwd, 'checkout')
      if (driver.fixRun() !== undefined) throw new Error('fix-run-started-before-pause')
      closePost = failNextPost()
      const pausing = driver.pause()
      await closePost.refused
      if (!closePost.failed()) throw new Error('pause-post-was-not-refused')
      const pausedRecords = (await history(cwd)).operations.flatMap((operation) =>
        operation.record ? [operation.record] : [],
      )
      const controls = pausedRecords.filter((record) => record.kind === 'operator-control')
      if (controls.length !== 0) throw new Error('pause-control-persisted-despite-refusal')
      closePost.close()
      closePost = null
      execFileSync('gh', ['repo', 'view', 'acme/app', '--json', 'nameWithOwner'], { cwd, encoding: 'utf8' })
      armed.release()
      await Promise.all([pausing, settling])
      const finalHistory = await history(cwd)
      return {
        precondition,
        pause: { postRefused: true, operatorControls: controls.length, ghAvailable: true },
        active: driver.controller.active(),
        fixRun: driver.fixRun(),
        messages: driver.messages,
        records: finalHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
      }
    },
    () =>
      cleanupRace([
        () => barrier?.release(),
        async () => {
          if (settling !== null) await settling
        },
        () => closePost?.close(),
        () => driver.controller.stop('race-cleanup'),
        () => barrier?.close(),
      ]),
    'review pause race cleanup failed',
  )
}

export async function invokeReviewRace(cwd: string, mode: Mode): Promise<object> {
  return mode === 'latest' ? latest(cwd) : pause(cwd)
}
