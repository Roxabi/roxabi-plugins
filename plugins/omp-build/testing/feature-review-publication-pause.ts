import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'
import { reviewDecision } from './feature-review-synthesis-sources.ts'
import type { ReviewDriver } from './native-review-driver.ts'

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

export function readComments(stateFile: string): unknown[] {
  return JSON.parse(readFileSync(stateFile, 'utf8')).issues['42'].comments
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages)
  return [error instanceof Error ? error.message : String(error)]
}

export async function pauseDuringPublication(driver: ReviewDriver): Promise<object> {
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
  const failures: unknown[] = []
  try {
    await waitFor(started, publication)
    pendingPause = driver.pause()
    beforeRelease = driver.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH')).length
  } catch (error) {
    failures.push(error)
  }
  try {
    if (!existsSync(release)) writeFileSync(release, 'release\n')
  } catch (error) {
    failures.push(error)
  }
  const [published, paused] = await Promise.allSettled([publication, pendingPause])
  if (paused.status === 'rejected') failures.push(paused.reason)
  if (failures.length > 0) {
    if (published.status === 'rejected') failures.push(published.reason)
    throw new AggregateError(failures, 'Publication pause fixture failed')
  }
  const publicationErrors = published.status === 'rejected' ? errorMessages(published.reason) : []
  return {
    messages: driver.messages,
    active: driver.controller.active(),
    beforeRelease,
    publicationErrors,
    comments: readComments(root),
    barrier: true,
  }
}
