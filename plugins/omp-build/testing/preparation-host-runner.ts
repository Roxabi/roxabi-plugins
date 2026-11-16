import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { createPreparationCohort } from '../host/preparation-cohort.ts'
import { gh } from '../skills/feature/workflow-runtime.js'

const root = process.argv[2]
const mode = process.argv[3]
if (!root || (mode !== 'join' && mode !== 'stream-failure')) throw new Error('fixture-input-missing')
const fifo = path.join(root, 'release.fifo')
execFileSync('mkfifo', [fifo])

const originalSpawn = Bun.spawn
const ready = Promise.withResolvers<void>()
let actualExited = false
let otherStreamEnded = false
let actualExit: Promise<number> | undefined
let killActual: (() => void) | undefined
Object.defineProperty(Bun, 'spawn', {
  value: (...args: Parameters<typeof Bun.spawn>) => {
    const process = Reflect.apply(originalSpawn, Bun, args) as ReturnType<typeof Bun.spawn>
    killActual = () => {
      process.kill()
    }
    actualExit = process.exited.then((code) => {
      actualExited = true
      return code
    })
    const stdout = (process.stdout as ReadableStream<Uint8Array>).pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
        flush() {
          otherStreamEnded = true
        },
      }),
    )
    const stderr = (process.stderr as ReadableStream<Uint8Array>).pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          ready.resolve()
          if (mode === 'stream-failure') throw new Error('injected-stderr-read-failure')
          controller.enqueue(chunk)
        },
      }),
    )
    return { stdout, stderr, exited: process.exited }
  },
})
const turn = async () => {
  const barrier = Promise.withResolvers<void>()
  setImmediate(barrier.resolve)
  await barrier.promise
}
const releaseGate = async () => {
  const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
  try {
    await writer.writeFile('release')
  } finally {
    await writer.close()
  }
}
let released = false
try {
  const cohort = createPreparationCohort()
  let work!: Promise<string>
  const outer = cohort.run(() => {
    work = gh(root, ['api', 'fixture'])
    return 'outer-returned'
  })
  assert.equal(outer, 'outer-returned')
  let taskSettled = false
  const task = work.then(
    (value: string) => {
      taskSettled = true
      return { value }
    },
    (error: unknown) => {
      taskSettled = true
      return { error: error instanceof Error ? error.message : String(error) }
    },
  )
  await Promise.race([
    ready.promise,
    task.then((result) => {
      throw new Error(`worker-exited-before-ready:${JSON.stringify(result)}`)
    }),
  ])
  cohort.seal()
  assert.throws(() => cohort.run(() => undefined), /preparation-cohort-sealed/)
  let joinSettled = false
  const joined = cohort.join().then((result) => {
    joinSettled = true
    return result
  })
  await turn()
  assert.equal(actualExited, false, 'real worker must still be running')
  assert.equal(otherStreamEnded, false, 'real stdout must still be open')
  assert.equal(taskSettled, false, 'workflow returned before process and streams finished')
  assert.equal(joinSettled, false, 'cohort joined while the real command remained in flight')
  await releaseGate()
  released = true
  const result = await task
  assert.equal(await actualExit, 0)
  assert.equal(otherStreamEnded, true)
  const observed = await joined
  assert.equal(observed.status, 'joined')
  assert.equal(observed.operations.length, 1)
  if (mode === 'stream-failure') {
    assert.deepEqual(result, { error: 'injected-stderr-read-failure' })
    assert.equal(observed.operations[0]?.outcome, 'rejected')
  } else {
    assert.deepEqual(result, { value: 'actual-worker-output' })
    assert.equal(observed.operations[0]?.outcome, 'fulfilled')
  }
  process.stdout.write(`${JSON.stringify({ mode, completed: true })}\n`)
} finally {
  Object.defineProperty(Bun, 'spawn', { value: originalSpawn })
  if (!released && actualExit && !actualExited) {
    try {
      await releaseGate()
    } catch {
      killActual?.()
    }
  }
  if (actualExit) await actualExit
}
