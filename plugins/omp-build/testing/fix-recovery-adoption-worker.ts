import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  acquireDestinationAdmissionLease,
  releaseDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import { requiredReviewRecords } from '../skills/feature/workflow-records.js'
import { featureMandate, pullHistory } from './feature-ci-review-fixture.ts'
import { adoptionChildResponse } from './fix-recovery-adoption-child.ts'
import { adoptionRecoveryReport, nextAdoptionBatch } from './fix-recovery-adoption-observation.ts'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'
import { runRecoveryReviewPrelude } from './fix-recovery-review-prelude.ts'
import { readSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const [mode, cwd, rootDir, stateFile, boxText] = process.argv.slice(2)
if (!mode || !cwd || !rootDir || !stateFile || !boxText) throw new Error('adoption-worker-arguments-missing')
const box = JSON.parse(boxText) as Box
box.env = process.env
if (mode === 'prelude') {
  const review = await runRecoveryReviewPrelude({
    box,
    cwd,
    rootDir,
    credential: process.env.RECOVERY_TEST_CREDENTIAL ?? '',
    mode: 'defect',
  })
  process.stdout.write(`${JSON.stringify({ mode, review })}\n`)
  process.exit(0)
}
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await delay(25)
  }
  throw new Error(`adoption-worker-timeout:${label}`)
}
const approvals: unknown[] = []
const dialogs: string[] = []
const notifications: string[] = []
const nativeErrors: string[] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  nativeErrors.push(args.map(String).join(' '))
  originalConsoleError(...args)
}
const used = new Set<string>()
let phase: 'idle' | 'recover' | 'execute' | 'review' = 'idle'
let recoveryCalled = false
let confirmations = 0
const root = await createRecoveryTestRoot({
  cwd,
  agentDir: join(rootDir, `${mode}-agent`),
  sandboxHome: rootDir,
  ghConfigDir: join(rootDir, 'gh-config'),
  ghSimulatorState: stateFile,
  credential: process.env.RECOVERY_TEST_CREDENTIAL ?? '',
  responses: [],
  ...(mode === 'old'
    ? { additionalExtensionPaths: [join(import.meta.dirname, 'fix-recovery-historical-handoff.ts')] }
    : {}),
  agentModelOverrides: Object.fromEntries(
    [
      'fix-apply',
      'fix-falsify',
      'adversarial',
      'security-auditor',
      'architect',
      'devops',
      'tester',
      'spec',
      'synthesis',
      'recall',
    ].map((name) => [`R-review-${name}`, 'recovery-test/recovery-test']),
  ),
  onApproval: async (event) => {
    approvals.push(event)
    return 'once'
  },
  onConfirmation: async () => {
    confirmations++
    return 'confirm'
  },
  onDisplay: (text) => dialogs.push(text),
  onNotification: (text) => notifications.push(text),
  handler: (context) => {
    const names = new Set((context.tools ?? []).map((tool) => tool.name))
    if (names.has('yield')) return adoptionChildResponse(context, cwd, box)
    if (phase === 'recover' && !recoveryCalled) {
      recoveryCalled = true
      phase = 'execute'
      return {
        content: [
          { type: 'toolCall', id: 'adoption-recover', name: 'omp_build_recover_interrupted_fix', arguments: { pr: 7 } },
        ],
      }
    }
    if (phase === 'review') {
      phase = 'execute'
      return {
        content: [
          { type: 'toolCall', id: 'adoption-final-review', name: 'omp_build_start_review', arguments: { pr: 7 } },
        ],
      }
    }
    if (phase === 'execute') {
      const batchId = nextAdoptionBatch(context.messages, used)
      if (batchId) {
        used.add(batchId)
        return {
          content: [
            {
              type: 'toolCall',
              id: `adoption-batch-${used.size}`,
              name: 'omp_build_execute_native_batch',
              arguments: { batchId },
            },
          ],
        }
      }
    }
    return { content: ['Sandbox operator event completed.'] }
  },
})
try {
  await root.session.prompt('/tooling-pin activate')
  if (
    !notifications.includes('tooling-pin: activated for this session') &&
    !notifications.includes('tooling-pin: tooling-pin-not-needed')
  )
    throw new Error(`adoption-pin-refused:${JSON.stringify(notifications)}`)
  if (mode === 'old') {
    const marker = process.env.FIX_RECOVERY_FAULT_MARKER
    const release = process.env.FIX_RECOVERY_FAULT_RELEASE
    if (!marker || !release) throw new Error('adoption-fault-config-missing')
    const reviewId = process.env.RECOVERY_PRELUDE_REVIEW_ID
    if (!reviewId) throw new Error('adoption-historical-review-missing')
    const command = root.session.prompt(`/fixture-historical-review-fix ${reviewId}`)
    try {
      await until(() => (existsSync(marker) ? true : undefined), 'request-cut')
    } catch (error) {
      throw new Error(
        `adoption-before-request:${JSON.stringify({ error: String(error), notifications, errors: root.errors, messages: root.session.messages })}`,
      )
    }
    const opened = featureMandate(box).history.operations.find(
      (entry) => entry.record?.kind === 'fix-owner' && entry.record.payload.phase === 'opened',
    )?.record
    if (opened?.kind !== 'fix-owner' || opened.payload.phase !== 'opened')
      throw new Error('adoption-owner-opening-missing')
    const held = await acquireDestinationAdmissionLease({ destination: opened.payload.common.destination })
    if (held.status !== 'occupied') throw new Error(`adoption-owner-not-occupied:${JSON.stringify(held)}`)
    writeFileSync(release, 'release\n')
    await command
    const trace = process.env.RECOVERY_GH_TRACE
    const diagnostic = (error: unknown) => {
      const state = readSim(box)
      return `adoption-owner-settlement-diagnostic:${JSON.stringify({ error: String(error), nativeErrors, trace: trace && existsSync(trace) ? readFileSync(trace, 'utf8') : null, rawIssue: state.issues['42'], rawPull: state.prs['7'], issueHistory: featureMandate(box).history, pullHistory: pullHistory(box), notifications, errors: root.errors, messages: root.session.messages })}`
    }
    let settled: NonNullable<ReturnType<typeof featureMandate>['history']['operations'][number]['record']>
    try {
      settled = await until(() => {
        const record = featureMandate(box).history.operations.find(
          (entry) =>
            entry.status === 'complete' &&
            entry.record?.kind === 'fix-owner' &&
            entry.record.payload.phase === 'settled',
        )?.record
        if (record) return record
        if (nativeErrors.some((entry) => entry.includes('interrupted fix owner remains held:')))
          throw new Error('actual-host-settlement-held')
        return undefined
      }, 'owner-settlement')
    } catch (error) {
      throw new Error(diagnostic(error))
    }
    let released = false
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const candidate = await acquireDestinationAdmissionLease({ destination: opened.payload.common.destination })
      if (candidate.status === 'acquired') {
        released = (await releaseDestinationAdmissionLease(candidate.lease)).status === 'released'
        break
      }
      if (candidate.status !== 'occupied') throw new Error(`adoption-lease-check:${JSON.stringify(candidate)}`)
      await delay(25)
    }
    if (!released) throw new Error('adoption-lease-release-unobserved')
    process.stdout.write(
      `${JSON.stringify({ mode, pid: process.pid, sessionId: root.session.sessionManager.getSessionId(), opened, settled, held: true, released, nativeDispatches: root.nativeDispatches, children: root.children, notifications })}\n`,
    )
  } else if (mode === 'new') {
    phase = 'recover'
    await root.session.prompt('Recover the interrupted fix for pull request 7.')
    phase = 'execute'
    const report = (label: string) =>
      adoptionRecoveryReport({ label, root, box, recoveryCalled, used, notifications, nativeErrors })
    const recoveryResult = root.session.messages.find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'adoption-recover',
    )
    if (recoveryResult?.role === 'toolResult' && recoveryResult.isError) {
      throw new Error(report(`adoption-recovery-refused:${JSON.stringify(recoveryResult).slice(0, 1500)}`))
    }
    const originalReview = process.env.RECOVERY_PRELUDE_REVIEW_ID
    const originalRequest = process.env.RECOVERY_ORIGINAL_REQUEST_ID
    const originalDecision = process.env.RECOVERY_ORIGINAL_DECISION_ID
    if (!originalReview || !originalRequest || !originalDecision) throw new Error('adoption-original-lineage-missing')
    let completed = false
    let finalReviewRequested = false
    // Budget the correction and final-head review observed under the bounded CPU repro.
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      const failedBatch = root.session.messages.find(
        (message) =>
          message.role === 'toolResult' && message.toolName === 'omp_build_execute_native_batch' && message.isError,
      )
      if (failedBatch)
        throw new Error(report(`adoption-native-batch-failed:${JSON.stringify(failedBatch).slice(0, 12000)}`))
      const stopped = root.session.messages.find(
        (message) =>
          message.role === 'custom' &&
          typeof message.content === 'string' &&
          /\/fix\s+\S+\s+stopped:/.test(message.content),
      )
      if (stopped) throw new Error(report(`adoption-fix-stopped:${JSON.stringify(stopped).slice(0, 1500)}`))
      const records = pullHistory(box).operations.flatMap((entry) =>
        entry.status === 'complete' && entry.record ? [entry.record] : [],
      )
      const result = records.findLast(
        (record) =>
          record.kind === 'fix-result' &&
          record.payload.requestId === originalRequest &&
          record.payload.decisionId === originalDecision,
      )
      const review = records.findLast((record) => record.kind === 'review')
      if (result && !finalReviewRequested) {
        const finished = root.session.messages.some(
          (message) =>
            message.role === 'custom' &&
            typeof message.content === 'string' &&
            message.content.includes(result.recordId) &&
            message.content.includes('completed'),
        )
        if (finished) {
          const owner = featureMandate(box).history.operations.find(
            (entry) => entry.record?.kind === 'fix-owner' && entry.record.payload.phase === 'opened',
          )?.record
          if (owner?.kind !== 'fix-owner' || owner.payload.phase !== 'opened')
            throw new Error(report('adoption-destination-unavailable'))
          const lease = await acquireDestinationAdmissionLease({ destination: owner.payload.common.destination })
          if (lease.status === 'acquired') {
            const released = await releaseDestinationAdmissionLease(lease.lease)
            if (released.status !== 'released') throw new Error(report('adoption-probe-lease-release-failed'))
            await root.session.waitForIdle()
            phase = 'review'
            await root.session.prompt('Start a native review for the corrected head of pull request 7.')
            finalReviewRequested = true
          } else if (lease.status !== 'occupied') {
            throw new Error(report(`adoption-lease-observation:${JSON.stringify(lease)}`))
          }
        }
      }
      if (
        result?.kind === 'fix-result' &&
        review?.kind === 'review' &&
        review.recordId !== originalReview &&
        review.payload.candidateGitSHA === result.payload.candidateGitSHA
      ) {
        completed = true
        break
      }
      await delay(25)
    }
    await root.session.waitForIdle()
    for (const id of root.nativeDispatches) {
      const result = root.session.messages.find((message) => message.role === 'toolResult' && message.toolCallId === id)
      if (result?.role !== 'toolResult' || result.isError)
        throw new Error(report(`adoption-native-result-unconfirmed:${id}:${JSON.stringify(result).slice(0, 1500)}`))
    }
    if (!completed) throw new Error(report('adoption-not-complete'))
    const replay = await requiredReviewRecords(cwd, 7)
    process.stdout.write(
      `${JSON.stringify({ mode, pid: process.pid, sessionId: root.session.sessionManager.getSessionId(), recoveryCalled, finalReviewRequested, confirmations, approvals: approvals.length, nativeDispatches: root.nativeDispatches, children: root.children, dialogs, notifications, errors: root.errors, replay, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), code: readFileSync(join(cwd, 'src/save.ts'), 'utf8') })}\n`,
    )
  } else throw new Error('adoption-worker-mode-invalid')
} finally {
  console.error = originalConsoleError
  await root.dispose()
}
