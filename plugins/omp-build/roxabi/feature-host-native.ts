import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { NativeBatch, NativeBatchCallbacks, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureGit } from './feature-contract.ts'
import { rememberFeatureOwner } from './feature-host-ownership.ts'

const actionStarts = new WeakMap<NativeBatch, ScopedRecordRef>()
const implementationStarts = new WeakMap<NativeBatch, string>()
const execGit = promisify(execFile)

async function publishNativeResult(host: FeatureCommandHost, settled: NativeBatchResult) {
  try {
    const start = actionStarts.get(settled.batch)
    if (start === undefined) throw new Error('action-start-missing')
    const startHead = implementationStarts.get(settled.batch)
    return await host.workflow.publishFeatureNativeResult({
      cwd: host.cwd,
      result: settled,
      start,
      ...(startHead === undefined ? {} : { startHead }),
    })
  } catch (error) {
    await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

async function publishCompletedResult(
  host: FeatureCommandHost,
  result: NativeBatchResult,
): Promise<NativeBatch | null> {
  const publication = await publishNativeResult(host, result)
  if (publication.published) return result.batch
  await host.send(`feature-stopped: ${publication.reason}`)
  if (!publication.retained) throw new Error(publication.reason)
  return null
}

async function publishStoppedResult(host: FeatureCommandHost, result: NativeBatchResult): Promise<void> {
  const publication = await publishNativeResult(host, result)
  if (!publication.published) await host.send(`feature-stopped: ${publication.reason}`)
}

export async function announceFeatureBatch(
  reference: string,
  followUp: NativeBatch,
  actionStart: ScopedRecordRef,
  host: FeatureCommandHost,
  deliver: (result: ContinueFeatureResult) => Promise<void>,
): Promise<void> {
  if (!isNativeBatch(followUp)) {
    await host.send('feature-stopped: action-undeliverable')
    return
  }
  if (host.featureContinuationInhibited() || host.principal) {
    await host.send('feature-stopped: continuation-inhibited')
    return
  }
  rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: true })
  host.markFeatureBatch(followUp)
  actionStarts.set(followUp, actionStart)
  if (isImplementationBatch(followUp)) {
    const start = await readImplementationStart(host)
    if (!start.ok) {
      await host.send(`feature-stopped: ${start.reason}`)
      return
    }
    implementationStarts.set(followUp, start.head)
  }
  let admittedBatch: NativeBatch | null = null
  const callbacks: NativeBatchCallbacks = {
    onComplete: async (result) => {
      admittedBatch = await publishCompletedResult(host, result)
    },
    onSettled: async () => {
      if (admittedBatch !== followUp) return
      admittedBatch = null
      if (host.featureContinuationInhibited()) return
      const next = await host.workflow.continueFeature({
        cwd: host.cwd,
        reference,
        control: 'continue',
        principal: false,
      })
      await deliver(next)
    },
    onStop: async (_reason, result) => {
      if (result !== null) await publishStoppedResult(host, result)
    },
  }
  let acquired = false
  try {
    host.native.activate(followUp, callbacks)
    acquired = true
    await host.native.announce(followUp)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (acquired) await host.native.stopOwned(followUp, reason)
    await host.send(`feature-stopped: ${reason}`)
    return
  }
}

function isNativeBatch(value: NativeBatch): boolean {
  return (
    typeof value?.operationId === 'string' &&
    value.operationId.length > 0 &&
    Array.isArray(value.tasks?.tasks) &&
    value.tasks.tasks.length > 0 &&
    value.tasks.tasks.every(
      (task) => typeof task.name === 'string' && task.name.length > 0 && typeof task.agent === 'string',
    )
  )
}

function isImplementationBatch(batch: NativeBatch): boolean {
  return batch.tasks.tasks.some((task) => task.agent === 'R-workflow-implement')
}

async function readImplementationStart(
  host: FeatureCommandHost,
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const git: FeatureGit =
    host.git ??
    (async (args, cwd) => {
      try {
        const shown = await execGit('git', [...args], { cwd, encoding: 'utf8' })
        return { stdout: observedGitText(shown.stdout), exitCode: 0 }
      } catch (error) {
        const stdout =
          typeof error === 'object' && error !== null && 'stdout' in error ? observedGitText(error.stdout) : ''
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : 1
        return { stdout, exitCode: typeof code === 'number' ? code : 1 }
      }
    })
  const head = await git(['rev-parse', 'HEAD'], host.cwd)
  const sha = head.stdout.trim()
  if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, reason: 'implementation-start-unobserved' }
  }
  return { ok: true, head: sha }
}

function observedGitText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}
