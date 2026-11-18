import { join } from 'node:path'
import { setupCiPrelude } from './fix-recovery-ci-support.ts'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const [mode, cwd, rootDir, stateFile, boxText, actionFile] = process.argv.slice(2)
if (!mode || !cwd || !rootDir || !stateFile || !boxText) throw new Error('fixture arguments missing')
const box = JSON.parse(boxText) as Box
box.env = process.env
if (mode === 'prelude') {
  const result = await setupCiPrelude(box, cwd, rootDir)
  process.stdout.write(`${JSON.stringify({ mode, result })}\n`)
  process.exit(0)
}
const dispatches: string[] = []
const notifications: string[] = []
let called = false
const root = await createRecoveryTestRoot({
  cwd,
  agentDir: join(rootDir, `${mode}-agent`),
  sandboxHome: rootDir,
  ghConfigDir: join(rootDir, 'gh-config'),
  ghSimulatorState: stateFile,
  credential: process.env.RECOVERY_TEST_CREDENTIAL ?? '',
  responses: [],
  agentModelOverrides: { 'R-workflow-attribute-ci': 'recovery-test/recovery-test' },
  onApproval: async () => 'once',
  onConfirmation: async () => 'confirm',
  onNotification: (message) => notifications.push(message),
  handler: (context) => {
    if ((context.tools ?? []).some((tool) => tool.name === 'yield')) {
      const data =
        mode === 'initial'
          ? {
              outcome: 'missing-context',
              missing: [
                {
                  locator: { kind: 'information-request', description: 'CI failure ownership' },
                  reason: 'The failure owner must be established',
                  targets: [],
                },
              ],
            }
          : { attribution: 'unknown', evidence: null }
      return { content: [{ type: 'toolCall', id: 'ci-yield', name: 'yield', arguments: { data } }] }
    }
    const text = JSON.stringify(context.messages).replaceAll('\\"', '"')
    const match = /"batchId"\s*:\s*"([^"]+)"/.exec(text)
    if (!called && match) {
      called = true
      return {
        content: [
          {
            type: 'toolCall',
            id: 'ci-native',
            name: 'omp_build_execute_native_batch',
            arguments: { batchId: match[1] },
          },
        ],
      }
    }
    return { content: ['Sandbox operator event completed.'] }
  },
})
const completion = Promise.withResolvers<{ isError: boolean; result: unknown }>()
const unsubscribe = root.session.subscribe((event) => {
  if (
    event.type === 'tool_execution_end' &&
    event.toolCallId === 'ci-native' &&
    event.toolName === 'omp_build_execute_native_batch'
  ) {
    dispatches.push(event.toolCallId)
    completion.resolve({ isError: event.isError === true, result: event.result })
  }
})
let stage = 'pin'
const terminate = () => {
  process.stderr.write(`CI lifecycle terminated at ${stage}; called=${called}\n`)
  void root.dispose().finally(() => process.exit(143))
}
process.once('SIGTERM', terminate)
async function bounded<T>(operation: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(
    () =>
      timeout.reject(
        new Error(
          `CI lifecycle timeout at ${stage}; called=${called}; notifications=${JSON.stringify(notifications)}; errors=${JSON.stringify(root.errors)}; messages=${JSON.stringify(root.session.messages)}`,
        ),
      ),
    25_000,
  )
  try {
    return await Promise.race([operation, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}
try {
  await bounded(root.session.prompt('/tooling-pin activate'))
  stage = 'feature-command'
  await bounded(root.session.prompt(mode === 'initial' ? '/feature #42' : `/feature #42 --action ${actionFile}`))
  stage = 'session-idle'
  await bounded(root.session.waitForIdle())
  if (called) {
    stage = 'native-completion'
    const result = await bounded(completion.promise)
    if (result.isError) throw new Error(`native dispatch failed: ${JSON.stringify(result.result)}`)
  }
  process.stdout.write(
    `${JSON.stringify({ mode, called, dispatches, children: root.children, notifications, messages: root.session.messages, errors: root.errors })}\n`,
  )
} finally {
  process.off('SIGTERM', terminate)
  unsubscribe()
  await root.dispose()
}
