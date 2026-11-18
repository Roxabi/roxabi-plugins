import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { outsideEffectImplementResponse } from './context-external-effect-child.ts'
import {
  type OutsideEffectProduceFacts,
  type OutsideEffectWorkerMode,
  outsideEffectAgentDir,
  porcelain,
} from './context-external-effect-fixture.ts'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'

const [cwd, rootDir, stateFile, outsidePath, modeArg] = process.argv.slice(2)
if (!cwd || !rootDir || !stateFile || !outsidePath) throw new Error('outside-effect-worker-arguments-missing')
if (!outsidePath.startsWith('/') || outsidePath.includes(cwd))
  throw new Error('outside-effect-path-must-leave-checkout')
const mode = (modeArg ?? 'attributed-success') as OutsideEffectWorkerMode
if (mode !== 'attributed-success' && mode !== 'recreate-preselection')
  throw new Error(`outside-effect-worker-mode-invalid:${mode}`)

const notifications: string[] = []
const dispatches: string[] = []
let called = false
const root = await createRecoveryTestRoot({
  cwd,
  agentDir: outsideEffectAgentDir(rootDir),
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
    if ((context.tools ?? []).some((tool) => tool.name === 'yield'))
      return outsideEffectImplementResponse(context, outsidePath)
    const text = JSON.stringify(context.messages).replaceAll('\\"', '"')
    const match = /"batchId"\s*:\s*"([^"]+)"/.exec(text)
    if (!called && match) {
      called = true
      return {
        content: [
          {
            type: 'toolCall',
            id: 'outside-effect-native',
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
    event.toolCallId === 'outside-effect-native' &&
    event.toolName === 'omp_build_execute_native_batch'
  ) {
    dispatches.push(event.toolCallId)
    completion.resolve({ isError: event.isError === true, result: event.result })
  }
})

let stage = 'pin'
const terminate = () => {
  process.stderr.write(`outside-effect worker terminated at ${stage}; called=${called}\n`)
  void root.dispose().finally(() => process.exit(143))
}
process.once('SIGTERM', terminate)

async function bounded<T>(operation: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(
    () =>
      timeout.reject(
        new Error(
          `outside-effect timeout at ${stage}; called=${called}; notifications=${JSON.stringify(notifications)}; errors=${JSON.stringify(root.errors)}; messages=${JSON.stringify(root.session.messages)}`,
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
    throw new Error(`outside-effect-native-not-dispatched:${JSON.stringify({ notifications, errors: root.errors })}`)
  stage = 'native-completion'
  const nativeResult = await bounded(completion.promise)
  if (nativeResult.isError) throw new Error(`outside-effect-native-failed:${JSON.stringify(nativeResult.result)}`)

  const produce: OutsideEffectProduceFacts = {
    called,
    dispatches,
    sdkChildren: [...root.children],
    sdkErrors: [...root.errors],
    outsideExistsAfterProduce: existsSync(outsidePath),
    outsideRealPathAfterProduce: realpathSync(outsidePath),
    checkoutPorcelainAfterProduce: porcelain(cwd),
  }
  stage = 'dispose-sdk'
  unsubscribe()
  process.off('SIGTERM', terminate)
  await root.dispose()

  // Fresh adapter process: fixture SDK settings must be installed before workflow/material imports.
  stage = 'adapter-handoff'
  const produceFactsPath = join(rootDir, 'outside-effect-produce.json')
  writeFileSync(produceFactsPath, JSON.stringify(produce))
  const runtime = resolve(import.meta.dirname, 'context-external-effect-runtime.ts')
  const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
  const child = spawnSync(bun, [runtime, cwd, stateFile, outsidePath, mode, produceFactsPath], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 55_000,
  })
  if (child.status !== 0)
    throw new Error(
      `outside-effect-adapter-failed:status=${child.status};signal=${child.signal};error=${String(child.error)}\n${child.stderr}\n${child.stdout}`,
    )
  const line = child.stdout
    .trim()
    .split('\n')
    .findLast((item) => item.startsWith('{"mode"') || item.startsWith('{"called"'))
  if (line === undefined) throw new Error(`outside-effect-adapter-report-missing:\n${child.stderr}\n${child.stdout}`)
  process.stdout.write(`${line}\n`)
} finally {
  process.off('SIGTERM', terminate)
  unsubscribe()
  try {
    await root.dispose()
  } catch {
    /* already disposed after produce */
  }
}
