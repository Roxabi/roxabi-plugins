import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  acquireDestinationAdmissionLease,
  releaseDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import { featureMandate } from './feature-ci-review-fixture.ts'
import { readCiAttributionReceipt, setupCiPrelude, until, yieldNative } from './fix-recovery-ci-support.ts'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const [mode, cwd, rootDir, stateFile, boxText] = process.argv.slice(2)
if (!mode || !cwd || !rootDir || !stateFile) throw new Error('recovery-worker-arguments-missing')
if (!boxText) throw new Error('recovery-worker-box-missing')
const box = JSON.parse(boxText) as Box
box.env = process.env
if (mode === 'prelude') {
  const result = await setupCiPrelude(box, cwd, rootDir)
  process.stdout.write(`${JSON.stringify({ mode, ...result })}\n`)
  process.exit(0)
}
const probe = join(rootDir, 'active-child-probe')
const ready = join(rootDir, 'active-child-ready')
const release = join(rootDir, 'release-active-child')
async function leaseIsOccupied(): Promise<boolean> {
  const opening = featureMandate(box).history.operations.find(
    (item) => item.status === 'complete' && item.record?.kind === 'fix-owner' && item.record.payload.phase === 'opened',
  )?.record
  if (opening?.kind !== 'fix-owner' || opening.payload.phase !== 'opened')
    throw new Error('recovery-worker-opening-missing')
  const result = await acquireDestinationAdmissionLease({ destination: opening.payload.common.destination })
  if (result.status === 'acquired') {
    await releaseDestinationAdmissionLease(result.lease)
    return false
  }
  if (result.status !== 'occupied') throw new Error(`recovery-worker-lease-observation:${JSON.stringify(result)}`)
  return true
}
const approvals: unknown[] = []
const dialogs: string[] = []
const notifications: string[] = []
let phase: 'idle' | 'execute' | 'recover' | 'attribute' = 'idle'
let called = false
let confirmationCount = 0
let headBefore: string | null = null
let headAfter: string | null = null
const root = await createRecoveryTestRoot({
  cwd,
  agentDir: join(rootDir, `${mode}-agent`),
  sandboxHome: rootDir,
  ghConfigDir: join(rootDir, 'gh-config'),
  ghSimulatorState: stateFile,
  credential: process.env.RECOVERY_TEST_CREDENTIAL ?? '',
  responses: [],
  agentModelOverrides: {
    'R-review-fix-intake': 'recovery-test/recovery-test',
    'R-workflow-attribute-ci': 'recovery-test/recovery-test',
  },
  onApproval: async (prompt) => {
    approvals.push(prompt)
    return 'once'
  },
  onConfirmation: async () => {
    if (phase === 'recover') confirmationCount++
    if (mode === 'stale-confirmation' && phase === 'recover') {
      headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.com',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--allow-empty',
          '-m',
          'fixture: move head during confirmation',
        ],
        { cwd, env: process.env, stdio: 'pipe' },
      )
      headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    }
    return 'confirm'
  },
  onDisplay: (text) => dialogs.push(text),
  onNotification: (text) => notifications.push(text),
  handler: (context) => {
    const names = new Set((context.tools ?? []).map((tool) => tool.name))
    if (names.has('yield')) return yieldNative(JSON.stringify(context.messages), phase, probe, release)
    if (phase === 'recover' && !called) {
      called = true
      return {
        content: [
          { type: 'toolCall', id: 'held-recover', name: 'omp_build_recover_interrupted_fix', arguments: { pr: 7 } },
        ],
      }
    }
    if ((phase === 'execute' || phase === 'attribute') && !called) {
      const text = JSON.stringify(context.messages).replaceAll('\\"', '"')
      const match = /"batchId"\s*:\s*"([^"]+)"/.exec(text)
      if (match) {
        called = true
        return {
          content: [
            {
              type: 'toolCall',
              id: 'held-native',
              name: 'omp_build_execute_native_batch',
              arguments: { batchId: match[1] },
            },
          ],
        }
      }
    }
    return { content: ['Sandbox operator event completed.'] }
  },
})
const nativeResult = Promise.withResolvers<{ isError: boolean; result: unknown }>()
const unsubscribeNativeResult = root.session.subscribe((event) => {
  if (
    event.type === 'tool_execution_end' &&
    event.toolCallId === 'held-native' &&
    event.toolName === 'omp_build_execute_native_batch'
  ) {
    nativeResult.resolve({ isError: event.isError === true, result: event.result })
  }
})
async function requireNativeCompletion(): Promise<void> {
  const result = await nativeResult.promise
  if (result.isError) throw new Error(`recovery-worker-native-tool-failed:${JSON.stringify(result.result)}`)
}
try {
  await root.session.prompt('/tooling-pin activate')
  if (
    !notifications.includes('tooling-pin: activated for this session') &&
    !notifications.includes('tooling-pin: tooling-pin-not-needed')
  )
    throw new Error(`recovery-worker-pin-refused:${JSON.stringify(notifications)}`)
  if (mode === 'no-witness') {
    const marker = process.env.FIX_RECOVERY_FAULT_MARKER
    if (!marker || !process.env.FIX_RECOVERY_FAULT_RELEASE) throw new Error('recovery-worker-fault-config-missing')
    const command = root.session.prompt('/fix #7 Correct the selected region.')
    let commandDone = false
    void command.then(
      () => {
        commandDone = true
      },
      () => {
        commandDone = true
      },
    )
    const reached = await until(
      () => (existsSync(marker) ? 'marker' : commandDone ? 'terminal' : undefined),
      'missing-witness-request-cut',
    )
    if (reached !== 'marker')
      throw new Error(
        `recovery-worker-before-request:${JSON.stringify({ notifications, messages: root.session.messages, errors: root.errors })}`,
      )
    const leaseHeld = await leaseIsOccupied()
    const flushed = Promise.withResolvers<void>()
    process.stdout.write(
      `${JSON.stringify({ mode, pid: process.pid, leaseHeld, nativeDispatches: root.nativeDispatches, children: root.children })}\n`,
      () => flushed.resolve(),
    )
    await flushed.promise
    // Exit while the pre-dispatch POST is held: no synthetic settlement or drain claim.
    process.exit(0)
  } else if (mode === 'origin') {
    // The fix announcement triggers an SDK-owned turn; let that turn consume its batch.
    phase = 'execute'
    await root.session.prompt('/fix #7 Correct the selected region.')
    const leaseHeld = await leaseIsOccupied()
    await until(
      () => (existsSync(probe) && root.nativeDispatches.length > 0 && root.children.length > 0 ? true : undefined),
      'native-child-probe',
    )
    writeFileSync(
      ready,
      JSON.stringify({
        pid: process.pid,
        called,
        nativeDispatches: root.nativeDispatches,
        children: root.children,
        leaseHeld,
      }),
    )
    await until(() => (existsSync(release) ? true : undefined), 'child-release')
    await requireNativeCompletion()
    await root.session.waitForIdle()
    process.stdout.write(
      `${JSON.stringify({ mode, nativeDispatches: root.nativeDispatches, children: root.children, approvals: approvals.length, probe: readFileSync(probe, 'utf8'), errors: root.errors, notifications })}\n`,
    )
  } else if (mode === 'recover' || mode === 'stale-confirmation') {
    phase = 'recover'
    await root.session.prompt('Recover the interrupted fix for pull request 7.')
    process.stdout.write(
      `${JSON.stringify({
        mode,
        called,
        nativeDispatches: root.nativeDispatches,
        children: root.children,
        approvals: approvals.length,
        confirmationCount,
        headBefore,
        headAfter,
        dialogs,
        notifications,
        messages: root.session.messages,
        errors: root.errors,
      })}\n`,
    )
  } else if (mode === 'attribute') {
    phase = 'attribute'
    await root.session.prompt('/feature #42')
    await requireNativeCompletion()
    await root.session.waitForIdle()
    const receipt = await readCiAttributionReceipt(box)
    const marker = process.env.FIX_RECOVERY_FAULT_MARKER
    if (!marker) throw new Error('recovery-worker-attribution-fault-missing')
    await until(() => (existsSync(marker) ? true : undefined), 'initial-ci-owner-refusal')
    process.stdout.write(
      `${JSON.stringify({ mode, receipt, called, nativeDispatches: root.nativeDispatches, children: root.children, approvals: approvals.length, notifications, errors: root.errors })}\n`,
    )
  } else if (mode === 'ci-old') {
    const marker = process.env.FIX_RECOVERY_FAULT_MARKER
    const gate = process.env.FIX_RECOVERY_FAULT_RELEASE
    if (!marker || !gate) throw new Error('recovery-worker-ci-fault-missing')
    const command = root.session.prompt('/feature #42')
    const reached = await until(() => (existsSync(marker) ? true : undefined), 'ci-request-fault')
    if (!reached) throw new Error('recovery-worker-ci-request-fault-missing')
    const leaseWasHeld = await leaseIsOccupied()
    writeFileSync(gate, 'release\n')
    await command
    await root.session.waitForIdle()
    const end = Date.now() + 45_000
    while (await leaseIsOccupied()) {
      if (Date.now() >= end) throw new Error('recovery-worker-ci-lease-not-released')
      await delay(25)
    }
    process.stdout.write(
      `${JSON.stringify({
        mode,
        pid: process.pid,
        sessionId: root.session.sessionManager.getSessionId(),
        leaseWasHeld,
        leaseReleased: true,
        nativeDispatches: root.nativeDispatches,
        children: root.children,
        marker: JSON.parse(readFileSync(marker, 'utf8')),
        notifications,
      })}\n`,
    )
  } else if (mode === 'ci-continue') {
    phase = 'recover'
    await root.session.prompt('Recover the interrupted fix for pull request 7.')
    const recoveryMessages = JSON.stringify(root.session.messages)
    if (!recoveryMessages.includes('Interrupted fix ownership was neutrally closed'))
      throw new Error(`recovery-worker-close-refused:${recoveryMessages}`)
    await root.session.waitForIdle()
    phase = 'execute'
    called = false
    await root.session.prompt('/feature #42')
    await until(
      () => (existsSync(probe) && root.nativeDispatches.length > 0 && root.children.length > 0 ? true : undefined),
      'continued-native-probe',
    )
    writeFileSync(release, 'release\n')
    await requireNativeCompletion()
    await root.session.waitForIdle()
    process.stdout.write(
      `${JSON.stringify({
        mode,
        pid: process.pid,
        sessionId: root.session.sessionManager.getSessionId(),
        called,
        nativeDispatches: root.nativeDispatches,
        children: root.children,
        approvals: approvals.length,
        confirmationCount,
        dialogs,
        notifications,
        probe: readFileSync(probe, 'utf8'),
        recoveryMessages,
      })}\n`,
    )
  } else throw new Error('recovery-worker-mode-unknown')
} finally {
  unsubscribeNativeResult()
  await root.dispose()
}
