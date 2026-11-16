import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  acquireDestinationAdmissionLease,
  releaseDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import { featureMandate, pullHistory } from './feature-ci-review-fixture.ts'
import { seedReviewFixture } from './feature-review-fixture.ts'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'
import { readSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const [mode, cwd, rootDir, stateFile, boxText] = process.argv.slice(2)
if (!mode || !cwd || !rootDir || !stateFile) throw new Error('cold-worker-arguments-missing')
const gh = Bun.which('gh')
if (
  !gh ||
  realpathSync(gh) !== realpathSync(join(import.meta.dirname, 'fix-recovery-gh-fault.ts')) ||
  process.env.HOME !== rootDir ||
  process.env.GH_CONFIG_DIR !== join(rootDir, 'gh-config') ||
  process.env.GH_SIM_STATE !== stateFile ||
  ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'].some(
    (key) => process.env[key],
  )
)
  throw new Error('cold-worker-environment-not-isolated')

async function until<T>(read: () => T | undefined, name: string): Promise<T> {
  const end = Date.now() + 45_000
  while (Date.now() < end) {
    const value = read()
    if (value !== undefined) return value
    await delay(25)
  }
  throw new Error(`cold-worker-timeout:${name}`)
}
if (!boxText) throw new Error('cold-worker-box-missing')
const box = JSON.parse(boxText) as Box
box.env = process.env

if (mode === 'seed') {
  const branch = readSim(box).prs['7']?.headRefName
  if (!branch) throw new Error('cold-worker-branch-missing')
  await seedReviewFixture(box, cwd, branch)
} else {
  const dialogs: string[] = []
  const approvals: unknown[] = []
  const notifications: string[] = []
  const providerCalls: Array<{ phase: string; tools: string[]; messages: unknown }> = []
  let phase: 'idle' | 'recover' | 'native' = 'idle'
  let recoveryCalled = false
  let confirmations = 0
  let nativeCalled = false
  const probe = join(rootDir, 'native-probe.txt')
  const root = await createRecoveryTestRoot({
    cwd,
    agentDir: join(rootDir, `${mode}-agent`),
    sandboxHome: rootDir,
    ghConfigDir: join(rootDir, 'gh-config'),
    ghSimulatorState: stateFile,
    credential: process.env.RECOVERY_TEST_CREDENTIAL ?? '',
    responses: [],
    agentModelOverrides: { 'R-review-fix-intake': 'recovery-test/recovery-test' },
    onApproval: async (prompt) => {
      approvals.push(prompt)
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
      providerCalls.push({ phase, tools: [...names], messages: structuredClone(context.messages) })
      if (names.has('yield')) {
        if (!JSON.stringify(context.messages).includes('cold-probe')) {
          return {
            content: [
              {
                type: 'toolCall',
                id: 'cold-probe',
                name: 'bash',
                arguments: { command: `test -f src/save.ts && cat src/save.ts > '${probe}'` },
              },
            ],
          }
        }
        return {
          content: [{ type: 'toolCall', id: 'cold-yield', name: 'yield', arguments: { data: { findings: [] } } }],
        }
      }
      if (phase === 'recover' && !recoveryCalled) {
        recoveryCalled = true
        return {
          content: [
            { type: 'toolCall', id: 'cold-recover', name: 'omp_build_recover_interrupted_fix', arguments: { pr: 7 } },
          ],
        }
      }
      if (phase === 'native' && !nativeCalled) {
        const text = JSON.stringify(context.messages).replaceAll('\\"', '"')
        const match = /"batchId"\s*:\s*"([^"]+)"/.exec(text)
        if (match) {
          nativeCalled = true
          return {
            content: [
              {
                type: 'toolCall',
                id: 'cold-native',
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
  try {
    await root.session.prompt('/tooling-pin activate')
    const activated = notifications.includes('tooling-pin: activated for this session')
    if (!activated) {
      // This exact refusal is emitted only when resolvePluginPin accepted the shared pin.
      if (!notifications.includes('tooling-pin: tooling-pin-not-needed'))
        throw new Error(`cold-worker-pin-refused:${JSON.stringify(notifications)}`)
      await root.session.prompt('/tooling-pin status')
      if (!notifications.includes('tooling-pin: ordinary shared pin'))
        throw new Error(`cold-worker-shared-pin-status-unexpected:${JSON.stringify(notifications)}`)
    }
    if (mode === 'old' || mode === 'old-torn') {
      const marker = process.env.FIX_RECOVERY_FAULT_MARKER
      const release = process.env.FIX_RECOVERY_FAULT_RELEASE
      if (!marker || !release) throw new Error('cold-worker-fault-config-missing')
      // A programmatic SDK input, not a claim about terminal entry of control characters.
      const request = mode === 'old-torn' ? '\u0001'.repeat(4000) : 'Correct the selected region.'
      const command = root.session.prompt(`/fix #7 ${request}`)
      let commandDone = false
      let commandError: unknown
      let commandResult: boolean | undefined
      void command.then(
        (result) => {
          commandResult = result
          commandDone = true
        },
        (error) => {
          commandDone = true
          commandError = error
        },
      )
      const reached = await until(
        () => (existsSync(marker) ? 'marker' : commandDone ? 'command-returned' : undefined),
        'request-post-or-terminal',
      )
      if (reached !== 'marker') {
        await delay(0)
        throw new Error(
          `cold-worker-before-request-cut:${JSON.stringify({ commandError: String(commandError ?? ''), commandResult, notifications, messages: root.session.messages, errors: root.errors })}`,
        )
      }
      const opening = featureMandate(box).history.operations.find(
        (item) => item.record?.kind === 'fix-owner' && item.record.payload.phase === 'opened',
      )?.record
      if (opening?.kind !== 'fix-owner' || opening.payload.phase !== 'opened')
        throw new Error('cold-worker-owner-opening-missing')
      const destination = opening.payload.common.destination
      const held = await acquireDestinationAdmissionLease({ destination })
      if (held.status === 'acquired') {
        await releaseDestinationAdmissionLease(held.lease)
        throw new Error('cold-worker-owner-lease-not-held')
      }
      if (held.status !== 'occupied') throw new Error(`cold-worker-lease-observation:${JSON.stringify(held)}`)
      writeFileSync(release, 'release\n')
      await command
      const end = Date.now() + 45_000
      let leaseReleased = false
      while (Date.now() < end) {
        const candidate = await acquireDestinationAdmissionLease({ destination })
        if (candidate.status === 'acquired') {
          const released = await releaseDestinationAdmissionLease(candidate.lease)
          leaseReleased = released.status === 'released'
          break
        }
        if (candidate.status !== 'occupied')
          throw new Error(`cold-worker-release-observation:${JSON.stringify(candidate)}`)
        await delay(25)
      }
      if (!leaseReleased) throw new Error(`cold-worker-lease-not-released:${JSON.stringify(root.session.messages)}`)
      process.stdout.write(
        `${JSON.stringify({ mode, pid: process.pid, sessionId: root.session.sessionManager.getSessionId(), leaseWasHeld: true, leaseReleased, nativeDispatches: root.nativeDispatches, children: root.children, dialogs, notifications, messages: root.session.messages, marker: JSON.parse(readFileSync(marker, 'utf8')) })}\n`,
      )
    } else if (mode === 'new') {
      phase = 'recover'
      await root.session.prompt('Recover the interrupted fix for pull request 7.')
      const recoveryMessages = JSON.stringify(root.session.messages)
      if (!recoveryCalled || !recoveryMessages.includes('Interrupted fix ownership was neutrally closed')) {
        throw new Error(
          `cold-worker-recovery-refused:${JSON.stringify({ recoveryCalled, recoveryMessages, confirmations, dialogs, approvals: approvals.length, notifications, errors: root.errors, providerCalls })}`,
        )
      }
      phase = 'native'
      await root.session.prompt('/fix #7 Correct the selected region.')
      const diagnostic = (error: unknown) => {
        const state = readSim(box)
        return `cold-worker-native-diagnostic:${JSON.stringify({ error: String(error), nativeCalled, nativeDispatches: root.nativeDispatches, children: root.children, notifications, errors: root.errors, dialogs, providerCalls, messages: root.session.messages, rawIssue: state.issues['42'], rawPull: state.prs['7'], issueHistory: featureMandate(box).history, pullHistory: pullHistory(box) })}`
      }
      const freshStatus = () => {
        const messages = JSON.stringify(root.session.messages)
        if (/\/fix fix-[^\\\s"]+ stopped:/.test(messages)) return 'stopped' as const
        if (messages.includes('OMP_BUILD_NATIVE_BATCH:')) return 'announced' as const
        return undefined
      }
      try {
        const status = await until(freshStatus, 'native-announcement-or-stop')
        if (status === 'stopped') throw new Error('fresh-fix-stopped-before-announcement')
        // The real announcement owns the SDK turn; do not start a competing prompt.
        const outcome = await until(() => {
          const toolResult = root.session.messages.find(
            (message) => message.role === 'toolResult' && message.toolCallId === 'cold-native',
          )
          if (toolResult?.role === 'toolResult' && toolResult.isError)
            throw new Error(`native-tool-failed:${JSON.stringify(toolResult)}`)
          if (
            toolResult?.role === 'toolResult' &&
            existsSync(probe) &&
            root.nativeDispatches.includes('cold-native') &&
            root.children.length > 0
          )
            return 'observed' as const
          if (freshStatus() === 'stopped') return 'stopped' as const
          return undefined
        }, 'native-child-or-stop')
        if (outcome === 'stopped') throw new Error('fresh-fix-stopped-before-child-probe')
        await root.session.waitForIdle()
      } catch (error) {
        throw new Error(diagnostic(error))
      }
      process.stdout.write(
        `${JSON.stringify({ mode, pid: process.pid, sessionId: root.session.sessionManager.getSessionId(), recoveryCalled, nativeCalled, confirmations, probe: readFileSync(probe, 'utf8'), nativeDispatches: root.nativeDispatches, children: root.children, approvals: approvals.length, dialogs, notifications })}\n`,
      )
    } else throw new Error('cold-worker-mode-unknown')
  } finally {
    await root.dispose()
  }
}
