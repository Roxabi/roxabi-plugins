import { join } from 'node:path'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'
import { sameCallImplementResponse } from './implementation-same-call-id-child.ts'

const [cwd, rootDir, stateFile] = process.argv.slice(2)
if (!cwd || !rootDir || !stateFile) throw new Error('same-call-worker-arguments-missing')

const notifications: string[] = []
const dispatches: string[] = []
let called = false
const root = await createRecoveryTestRoot({
  cwd,
  agentDir: join(rootDir, 'same-call-agent'),
  sandboxHome: rootDir,
  ghConfigDir: join(rootDir, 'gh-config'),
  ghSimulatorState: stateFile,
  credential: process.env.RECOVERY_TEST_CREDENTIAL ?? '',
  responses: [],
  agentModelOverrides: { 'R-workflow-implement': 'recovery-test/recovery-test' },
  onApproval: async () => 'once',
  onConfirmation: async () => 'confirm',
  onNotification: (message) => notifications.push(message),
  handler: (context) => {
    if ((context.tools ?? []).some((tool) => tool.name === 'yield')) return sameCallImplementResponse(context, cwd)
    const text = JSON.stringify(context.messages).replaceAll('\\"', '"')
    const match = /"batchId"\s*:\s*"([^"]+)"/.exec(text)
    if (!called && match) {
      called = true
      return {
        content: [
          {
            type: 'toolCall',
            id: 'same-call-native',
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
    event.toolCallId === 'same-call-native' &&
    event.toolName === 'omp_build_execute_native_batch'
  ) {
    dispatches.push(event.toolCallId)
    completion.resolve({ isError: event.isError === true, result: event.result })
  }
})

let stage = 'pin'
const terminate = () => {
  process.stderr.write(`same-call worker terminated at ${stage}; called=${called}\n`)
  void root.dispose().finally(() => process.exit(143))
}
process.once('SIGTERM', terminate)

async function bounded<T>(operation: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(
    () =>
      timeout.reject(
        new Error(
          `same-call timeout at ${stage}; called=${called}; notifications=${JSON.stringify(notifications)}; errors=${JSON.stringify(root.errors)}; messages=${JSON.stringify(root.session.messages)}`,
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
  await bounded(root.session.prompt('/feature #42'))
  stage = 'session-idle'
  await bounded(root.session.waitForIdle())
  if (!called)
    throw new Error(`same-call-native-not-dispatched:${JSON.stringify({ notifications, errors: root.errors })}`)
  stage = 'native-completion'
  const result = await bounded(completion.promise)
  if (result.isError) throw new Error(`same-call-native-failed:${JSON.stringify(result.result)}`)
  process.stdout.write(
    `${JSON.stringify({
      called,
      dispatches,
      children: root.children,
      errors: root.errors,
    })}\n`,
  )
} finally {
  process.off('SIGTERM', terminate)
  unsubscribe()
  await root.dispose()
}
