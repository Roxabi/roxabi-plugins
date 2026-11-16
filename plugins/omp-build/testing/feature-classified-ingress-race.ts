import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadReviewClassCatalogues } from '../roxabi/review-class-catalogues.ts'
import { reviewRecords } from '../skills/feature/workflow-records.js'
import { reviewStep } from '../skills/feature/workflow-review-state.js'
import { gh } from '../skills/feature/workflow-runtime.js'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { citedHistory, history } from './feature-review-race-history.ts'
import { reviewDecision } from './feature-review-synthesis-sources.ts'
import { createReviewDriver } from './native-review-driver.ts'

function waitFor(file: string): { promise: Promise<void>; cancel(): void } {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const watcher = watch(path.dirname(file), () => {
    if (existsSync(file)) done()
  })
  const timer = setTimeout(() => done(new Error('viewer-ingress-barrier-timeout')), 30_000)
  function done(error?: Error) {
    clearTimeout(timer)
    watcher.close()
    if (error) reject(error)
    else resolve()
  }
  if (existsSync(file)) done()
  return { promise, cancel: () => done() }
}

function restoreIngressEnvironment(originalPath: string | undefined, originalToken: string | undefined) {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalToken
  delete process.env.OMP_INGRESS_STARTED
  delete process.env.OMP_INGRESS_RELEASE
  delete process.env.OMP_INGRESS_REAL_GH
}

async function seedCompletedReview(cwd: string) {
  const driver = await createReviewDriver(cwd, 128_000, 'review-only')
  try {
    await driver.settle(reviewInitialData)
    await driver.settle((task) => reviewDecision(task.task))
  } finally {
    await driver.controller.stop('race-cleanup')
  }
  const source = await history(cwd)
  const records = source.operations.flatMap((item) => (item.record ? [item.record] : []))
  const externalHistories = await citedHistory(cwd, source)
  const catalogues = await loadReviewClassCatalogues({ histories: [source, ...externalHistories], cwd, gh })
  const summary = reviewRecords(source, { catalogues, externalHistories })
  const step = summary.ok ? reviewStep(summary.value, { head: summary.value.head }) : null
  const requests = records.filter((record) => record.kind === 'fix-request')
  const controls = records.filter((record) => record.kind === 'operator-control')
  if (!source.source.complete || step?.action !== 'fix' || requests.length !== 0 || controls.length !== 0)
    throw new Error(
      `fix-selection-not-confirmed-before-ingress:${JSON.stringify({ complete: source.source.complete, summary, step, requests, controls })}`,
    )
  return { precondition: { complete: true, action: step.action, requests: requests.length }, records }
}

export async function invokeClassifiedIngressRace(cwd: string) {
  const { precondition, records: before } = await seedCompletedReview(cwd)
  const seeded = { precondition }
  const driver = await createReviewDriver(cwd, 128_000, 'feature', false, true)
  const state = process.env.GH_SIM_STATE
  if (state === undefined) throw new Error('gh-state-missing')
  const root = mkdtempSync(path.join(path.dirname(state), 'omp-ingress-gh-'))
  const started = path.join(root, 'started')
  const release = path.join(root, 'release')
  const real = execFileSync('which', ['gh'], { encoding: 'utf8' }).trim()
  const originalPath = process.env.PATH
  const originalToken = process.env.GH_TOKEN
  const script =
    '#!/bin/sh\nif [ "$1" = api ] && [ "$2" = user ]; then case "$GH_TOKEN" in fixture-ingress-*) : > "$OMP_INGRESS_STARTED"; deadline=$(( $(date +%s) + 30 )); while [ ! -f "$OMP_INGRESS_RELEASE" ]; do [ "$(date +%s)" -lt "$deadline" ] || exit 124; sleep 0.01; done;; esac; fi\nexec "$OMP_INGRESS_REAL_GH" "$@"\n'
  writeFileSync(path.join(root, 'gh'), script)
  chmodSync(path.join(root, 'gh'), 0o755)
  Object.assign(process.env, {
    PATH: `${root}:${originalPath}`,
    OMP_INGRESS_STARTED: started,
    OMP_INGRESS_RELEASE: release,
    OMP_INGRESS_REAL_GH: real,
  })
  let beginning: Promise<void> | undefined
  try {
    const blocked = waitFor(started)
    beginning = driver.beginFeature()
    const state = () =>
      JSON.stringify({
        messages: driver.messages,
        hasFixIngress: driver.hasFixIngress(),
        fixRun: driver.fixRun() !== undefined,
        active: driver.controller.active() !== null,
      })
    try {
      await Promise.race([
        blocked.promise.catch((error) => {
          throw new Error(`viewer-ingress-barrier-failed:${state()}`, { cause: error })
        }),
        beginning.then(
          () => {
            throw new Error(`feature-completed-before-viewer-ingress:${state()}`)
          },
          (error) => {
            throw new Error(`feature-failed-before-viewer-ingress:${state()}`, { cause: error })
          },
        ),
      ])
    } finally {
      blocked.cancel()
    }
    if (!driver.hasFixIngress() || driver.fixRun() !== undefined) throw new Error('real-pre-owner-ingress-not-held')
    await driver.pauseFeature()
    const hold = driver.messages.find((message) => message.includes('feature-fix-ingress-unjoined'))
    if (hold === undefined) throw new Error(`explicit-ingress-hold-missing:${JSON.stringify(driver.messages)}`)
    if (!driver.hasFixIngress() || driver.fixRun() !== undefined) throw new Error('ingress-released-before-viewer')
    writeFileSync(release, 'release\n')
    await beginning
    if (driver.hasFixIngress() || driver.fixRun() !== undefined || driver.controller.active() !== null)
      throw new Error('ingress-activated-owner-after-pause')
    const after = (await history(cwd)).operations.flatMap((item) => (item.record ? [item.record] : []))
    return { seeded, hold, before, after, messages: driver.messages, ownerReleased: true }
  } finally {
    writeFileSync(release, 'release\n')
    if (beginning !== undefined) await beginning.catch(() => {})
    await driver.controller.stop('race-cleanup')
    restoreIngressEnvironment(originalPath, originalToken)
    rmSync(root, { recursive: true, force: true })
  }
}
