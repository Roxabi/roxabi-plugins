import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import { isRecoveryFaultGh } from './fix-recovery-gh-identity.ts'
import { operatorDialogUi } from './operator-dialog-ui.ts'

/** Actual SDK root with the installed extension. UI answers are deterministic sandbox events. */
export async function createRecoveryTestRoot(input: {
  cwd: string
  agentDir: string
  sandboxHome: string
  ghConfigDir: string
  ghSimulatorState: string
  credential: string
  responses: NonNullable<Parameters<typeof createMockModel>[0]>['responses']
  agentModelOverrides: Record<string, string | string[]>
  handler?: NonNullable<Parameters<typeof createMockModel>[0]>['handler']
  onApproval: (prompt: unknown) => Promise<'once' | 'deny'>
  onConfirmation: () => Promise<'confirm' | 'refuse' | 'defer'>
  onDisplay?: (text: string) => void
  onNotification?: (message: string) => void
}) {
  // Set these before launching Bun: its executable lookup can cache PATH at startup.
  const gh = Bun.which('gh')
  if (
    !gh ||
    !isRecoveryFaultGh(gh) ||
    process.env.HOME !== input.sandboxHome ||
    process.env.GH_CONFIG_DIR !== input.ghConfigDir ||
    process.env.GH_SIM_STATE !== input.ghSimulatorState ||
    ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'].some(
      (key) => process.env[key],
    )
  ) {
    throw new Error('recovery-test-sandbox-environment-not-isolated')
  }
  const resolved = import.meta.resolve('@oh-my-pi/pi-coding-agent')
  const rootPath = dirname(resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved)
  const version = JSON.parse(await readFile(join(rootPath, '../package.json'), 'utf8')).version
  if (version !== '18.20.2') throw new Error(`unexpected SDK version: ${version}`)
  const [
    { createAgentSession },
    { Settings },
    { SessionManager },
    { AgentRegistry, isMintedAgentRef },
    { isLocalAgentSession },
    { initializeExtensions },
    { createMockModel },
    { AssistantMessageEventStream },
  ] = await Promise.all([
    import(join(rootPath, 'sdk.ts')),
    import('@oh-my-pi/pi-coding-agent/config/settings'),
    import('@oh-my-pi/pi-coding-agent/session/session-manager'),
    import('@oh-my-pi/pi-coding-agent/registry/agent-registry'),
    import('@oh-my-pi/pi-coding-agent/session/agent-session-handle'),
    import(join(rootPath, 'modes/runtime-init.ts')),
    import('@oh-my-pi/pi-ai/providers/mock'),
    import('@oh-my-pi/pi-ai/utils/event-stream'),
  ])
  const model = createMockModel({
    id: 'recovery-test',
    provider: 'recovery-test',
    responses: input.responses,
    handler: input.handler,
  })
  // The SDK mock provider omits the provider-dispatch callback. This transport
  // sends its real request context through that SDK boundary before scripting
  // a response, including any replacement and abort raised by the hook.
  const mockStream = model.stream
  model.stream = (requestModel, context, options) => {
    const stream = new AssistantMessageEventStream()
    void (async () => {
      try {
        options?.signal?.throwIfAborted()
        const request = (await options?.onPayload?.(context, requestModel, options.signal)) ?? context
        options?.signal?.throwIfAborted()
        if (
          request === null ||
          typeof request !== 'object' ||
          !('messages' in request) ||
          !Array.isArray(request.messages)
        ) {
          throw new Error('recovery-test-provider-invalid-replacement')
        }
        const inner = mockStream(requestModel, request as typeof context, options)
        for await (const event of inner) stream.push(event)
      } catch (error) {
        stream.fail(error)
      }
    })()
    return stream
  }
  const settings = Settings.isolated({
    'memory.backend': 'off',
    'autolearn.enabled': false,
    'tools.approvalMode': 'write',
    'task.agentModelOverrides': input.agentModelOverrides,
  })
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settings,
    model,
    sessionManager: SessionManager.create(input.cwd, join(input.agentDir, 'sessions')),
    getApiKey: async () => input.credential,
    bindProcessState: false,
    disableExtensionDiscovery: true,
    additionalExtensionPaths: [join(import.meta.dirname, '..')],
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    noContextFiles: true,
    skills: [],
    rules: [],
    promptTemplates: [],
  })
  const ref = AgentRegistry.global().get(session.getAgentId())
  if (
    !ref ||
    !isMintedAgentRef(ref) ||
    ref.kind !== 'main' ||
    ref.session !== session ||
    !isLocalAgentSession(session)
  ) {
    await session.dispose()
    throw new Error('real local SDK root unavailable')
  }
  // SDK root events observe attempted public dispatch; child/probe proves entry separately.
  const nativeDispatches: string[] = []
  const unsubscribeDispatch = session.subscribe((event) => {
    if (event.type === 'tool_execution_start' && event.toolName === 'omp_build_execute_native_batch') {
      nativeDispatches.push(event.toolCallId)
    }
  })
  // Registered children are actual SDK observations, not a count of attempted admissions.
  const children: string[] = []
  const unsubscribe = AgentRegistry.global().onChange(
    (event: { type: string; ref: { kind: string; parentId?: string; id: string } }) => {
      if (event.type === 'registered' && event.ref.kind === 'sub' && event.ref.parentId === ref.id)
        children.push(event.ref.id)
    },
  )
  session.modelRegistry.registerProvider('recovery-test', {
    api: 'mock',
    baseUrl: 'https://fixture.invalid',
    apiKey: input.credential,
    streamSimple: model.stream,
    models: [
      {
        id: 'recovery-test',
        name: 'recovery-test',
        reasoning: false,
        input: ['text'],
        supportsTools: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32768,
      },
    ],
  })
  const errors: unknown[] = []
  const ui = {
    ...operatorDialogUi(input.onConfirmation, input.onDisplay),
    approve: input.onApproval,
    notify: (message: string) => input.onNotification?.(message),
    setStatus: (key: string, text?: string) => input.onNotification?.(`${key}: ${text ?? ''}`),
    setWidget: () => {},
  }
  await initializeExtensions(session, {
    mode: 'tui',
    uiContext: ui,
    reportSendError: (_action: string, error: Error) => errors.push(error),
    reportRuntimeError: (error: unknown) => errors.push(error),
  })
  const nativeTools = session
    .getAllToolInfos()
    .filter((tool: { name: string }) => tool.name === 'omp_build_execute_native_batch')
  const source =
    nativeTools.length === 1 && nativeTools[0].sourceInfo?.source === 'extension'
      ? nativeTools[0].sourceInfo.path
      : undefined
  if (
    !source ||
    !session.preparedExtensions?.some(
      (item: { path: string; resolvedPath: string; factory: unknown }) =>
        item.factory && (item.path === source || item.resolvedPath === source),
    )
  )
    throw new Error('recovery-test-file-backed-guard-unavailable')
  return {
    session,
    ref,
    errors,
    children,
    nativeDispatches,
    async dispose() {
      unsubscribeDispatch()
      unsubscribe()
      await session.dispose()
    },
  }
}
