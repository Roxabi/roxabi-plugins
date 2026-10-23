import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  AgentEndEvent,
  BashToolDetails,
  BashToolInput,
  BeforeSubagentSpawnEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStopEvent,
  SessionSwitchEvent,
  SubagentEventPayload,
  ToolCallEvent,
  ToolResultEvent,
} from '@oh-my-pi/pi-coding-agent'
import type { Json, Submission } from '../contracts'

export type { Json }

export type NativeProofDirective = {
  purpose: 'fix-apply' | 'fix-revalidate' | 'fix-falsify'
  causeId: string
  occurrence: 'apply' | 'perturbed' | 'restored'
}

export type NativeTask = {
  name: string
  agent: string
  task: string
  solutionSpace: string
  tools?: string[]
  /** Host-only proof contract; stripped from the native task wire input. */
  proofEvidence?: NativeProofDirective
}

/** Exact native `task.batch` request guarded by the extension. */
export type NativeBatch = {
  operationId: string
  tasks: {
    context: string
    tasks: NativeTask[]
  }
}

/**
 * Execution-authority `task.batch` args for one authorized native batch.
 * Compared strictly at the native `tool_call` hook after the SDK strips harness intent `i`.
 * Model-facing announce adds `i` only at the announcement boundary — never stored on this object.
 */
export type NativeTaskWireInput = {
  context: string
  tasks: Array<Omit<NativeTask, 'proofEvidence'>>
}

const NATIVE_TASK_INTENT = 'omp-build native batch'

export type NativeProofBashCall = {
  toolCallId: string
  /** Original public Bash arguments, unchanged. */
  input: Json
  /** SDK-resolved host cwd, or null when the observed call cannot be resolved. */
  effectiveCwd: string | null
  result: Json | null
  exitCode: number | null
}

export type NativeProofEvidence = NativeProofDirective & {
  guardId: string | null
  call: NativeProofBashCall | null
}

export type NativeChildResult = {
  /** Native task result identity; never synthesized for an absent child. */
  id: string | null
  /** Host-authorized task name expected at this position, if one exists. */
  expectedId: string | null
  /** Every observed `yield` call, in child-local execution order. */
  submissions: Submission[]
  /** Narrow actual native Bash evidence for an explicitly declared fix proof only. */
  proofEvidence: NativeProofEvidence | null
  /** Referenced Bash calls only, including conflicting captures of those IDs. Unreferenced calls stay ephemeral. */
  bashCalls?: readonly NativeProofBashCall[]
  /** Exact terminal native child result, or null when no child result arrived. */
  raw: Json
  partialText: string | null
  /** The native final structured value only after strict terminal validation. */
  structured: Json | null
  usable: boolean
  reason: string | null
}
export type NativeBatchResult = {
  batch: NativeBatch
  children: NativeChildResult[]
  raw: Json
  complete: boolean
}

export type NativeBatchCallbacks = {
  /** Called once for each terminal or missing native child result before product interpretation. */
  onChildResult?: (child: NativeChildResult) => void | Promise<void>
  /** Called only after every required child reaches a strict valid terminal result. */
  onComplete: (result: NativeBatchResult) => void | Promise<void>
  /** Called once after onComplete resolves. agent_end does not invoke this. */
  onSettled?: (result: NativeBatchResult) => void | Promise<void>
  onStop: (reason: string, result: NativeBatchResult | null) => void | Promise<void>
}

/** The public SDK extension surface used by this bridge; no private runner APIs. */
export type NativeExtension = Pick<ExtensionAPI, 'on' | 'sendUserMessage'> & {
  events: Pick<ExtensionAPI['events'], 'on'>
}

type YieldRaw = {
  toolCallId: string
  contentIndex: number | null
  argumentDeltas: string[]
  argumentText: string
  rawBlock: string | null
  toolCallArguments: Json | null
  executionArguments: Json | null
}
type ChildCapture = {
  deltasByContentIndex: Map<number, string[]>
  textDeltas: string[]
  pendingCalls: Map<string, YieldRaw>
  pendingProofCalls: Map<string, { input: Json; effectiveCwd: string | null }>
  completedProofCalls: Map<string, NativeProofBashCall>
  ambiguousProofCallIds: Set<string>
  pendingBashCalls: Map<string, { input: Json; effectiveCwd: string | null }>
  completedBashCalls: Map<string, NativeProofBashCall>
  conflictingBashCalls: NativeProofBashCall[]
  ambiguousBashCallIds: Set<string>
  submissions: Submission[]
  partialText: string | null
}

type ActiveBatch = {
  batch: NativeBatch
  wire: NativeTaskWireInput
  callbacks: NativeBatchCallbacks
  defaultCwd: string | null
  admittedToolCallId: string | null
  spawnedIndexes: Set<number>
  announced: boolean
  announcementDispatched: boolean
  settling: boolean
  abortCleanup: (() => void) | null
  captures: Map<string, ChildCapture>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function json(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return true
  if (Array.isArray(value)) return value.every(json)
  return object(value) && Object.values(value).every(json)
}

/** Snapshot public SDK values through ordinary JSON wire semantics: omit undefined object fields. */
function nativeSnapshot(value: unknown): Json | null {
  try {
    const wire = JSON.stringify(value)
    if (wire === undefined) return null
    const snapshot: unknown = JSON.parse(wire)
    return json(snapshot) ? snapshot : null
  } catch {
    return null
  }
}

function relevantSubagentPayload(value: unknown): value is SubagentEventPayload {
  if (!object(value) || typeof value.id !== 'string' || !object(value.event) || typeof value.event.type !== 'string')
    return false
  const event = value.event
  if (event.type === 'message_start' || event.type === 'message_end') return true
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    return typeof event.toolName === 'string' && typeof event.toolCallId === 'string'
  }
  if (
    event.type !== 'message_update' ||
    !object(event.assistantMessageEvent) ||
    typeof event.assistantMessageEvent.type !== 'string'
  )
    return false
  const assistant = event.assistantMessageEvent
  if (assistant.type === 'text_delta') return typeof assistant.delta === 'string'
  if (assistant.type === 'toolcall_delta')
    return typeof assistant.contentIndex === 'number' && typeof assistant.delta === 'string'
  return (
    assistant.type === 'toolcall_end' &&
    typeof assistant.contentIndex === 'number' &&
    object(assistant.toolCall) &&
    typeof assistant.toolCall.id === 'string' &&
    typeof assistant.toolCall.name === 'string'
  )
}

function root(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}

function nativeTaskInput(batch: NativeBatch): NativeTaskWireInput {
  return {
    context: batch.tasks.context,
    tasks: batch.tasks.tasks.map(({ proofEvidence: _proofEvidence, ...task }) => task),
  }
}

function bashInput(value: unknown): value is BashToolInput {
  return object(value) && typeof value.command === 'string'
}

function bashDetails(value: unknown): value is BashToolDetails {
  return object(value) && (value.exitCode === undefined || typeof value.exitCode === 'number')
}

function bashExitCode(value: unknown, isError: unknown): number | null {
  if (!object(value) || !bashDetails(value.details)) return null
  if (typeof value.details.exitCode === 'number') return value.details.exitCode
  // Public Bash omits details.exitCode for a zero exit. Only a final foreground
  // completion proves that zero; async/service/live-terminal frames do not.
  if (
    isError !== false ||
    value.details.async !== undefined ||
    value.details.service !== undefined ||
    value.details.timedOut === true ||
    value.details.terminalId !== undefined
  )
    return null
  return 0
}

function rememberBashCall(
  completed: Map<string, NativeProofBashCall>,
  ambiguous: Set<string>,
  toolCallId: string,
  pending: { input: Json; effectiveCwd: string | null },
  event: { result: unknown; isError?: unknown },
  conflicts?: NativeProofBashCall[],
): void {
  const call: NativeProofBashCall = {
    toolCallId,
    input: pending.input,
    effectiveCwd: pending.effectiveCwd,
    result: nativeSnapshot(event.result),
    exitCode: bashExitCode(event.result, event.isError),
  }
  const existing = completed.get(toolCallId)
  if (existing !== undefined || ambiguous.has(toolCallId)) {
    if (conflicts !== undefined) {
      if (existing !== undefined) conflicts.push(existing)
      conflicts.push(call)
    }
    completed.delete(toolCallId)
    ambiguous.add(toolCallId)
    return
  }
  completed.set(toolCallId, call)
}

/** Preserve original public Bash arguments; resolution belongs in separate host metadata. */
function observedBashInput(value: unknown): Json | null {
  return bashInput(value) ? nativeSnapshot(value) : null
}

/** Mirrors the installed public Bash resolver's supported host-path cases without importing it at runtime. */
function effectiveBashCwd(value: unknown, sessionCwd: string | null): string | null {
  if (!bashInput(value) || typeof sessionCwd !== 'string' || (value.cwd !== undefined && typeof value.cwd !== 'string'))
    return null
  const requested = value.cwd ?? sessionCwd
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(requested)) return null
  const home = homedir()
  const expanded =
    requested === '~'
      ? home
      : requested.startsWith('~/') || requested.startsWith('~\\')
        ? home + requested.slice(1)
        : requested.startsWith('~')
          ? join(home, requested.slice(1))
          : requested
  if (/^\/+$/.test(expanded)) return sessionCwd
  return isAbsolute(expanded) ? expanded : resolve(sessionCwd, expanded)
}

function captureFor(active: ActiveBatch, childId: string): ChildCapture {
  let capture = active.captures.get(childId)
  if (!capture) {
    capture = {
      deltasByContentIndex: new Map(),
      textDeltas: [],
      pendingCalls: new Map(),
      pendingProofCalls: new Map(),
      completedProofCalls: new Map(),
      ambiguousProofCallIds: new Set(),
      pendingBashCalls: new Map(),
      completedBashCalls: new Map(),
      conflictingBashCalls: [],
      ambiguousBashCallIds: new Set(),
      submissions: [],
      partialText: null,
    }
    active.captures.set(childId, capture)
  }
  return capture
}

function assistantText(value: unknown): string | null {
  if (!object(value) || value.role !== 'assistant' || !Array.isArray(value.content)) return null
  const text = value.content
    .reduce<string[]>((parts, part) => {
      if (object(part) && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      return parts
    }, [])
    .join('')
  return text.length === 0 ? null : text
}

function rawYieldCall(
  toolCallId: string,
  contentIndex: number | null,
  argumentDeltas: readonly string[],
  toolCall: unknown,
): YieldRaw {
  const call = object(toolCall) ? toolCall : null
  return {
    toolCallId,
    contentIndex,
    argumentDeltas: [...argumentDeltas],
    argumentText: argumentDeltas.join(''),
    rawBlock: call !== null && typeof call.rawBlock === 'string' ? call.rawBlock : null,
    toolCallArguments: call !== null ? nativeSnapshot(call.arguments) : null,
    executionArguments: null,
  }
}

/** The only model-output parsing: the public native `yield` wrapper's real arguments. */
function yieldedData(args: unknown): Json | null {
  return object(args) && 'data' in args && json(args.data) ? args.data : null
}

function terminalStructured(value: Record<string, unknown>): Json | null {
  const output = value.structuredOutput
  return object(output) && output.status === 'valid' && json(output.data) ? output.data : null
}

type SelectedProofReference = {
  toolCallId: string
  guardId: string | null
}

function selectedProofReference(
  value: Json | null,
  directive: NativeProofDirective | null,
): SelectedProofReference | null {
  if (!object(value) || directive === null) return null
  if (directive.purpose !== 'fix-falsify') {
    return typeof value.proofToolCallId === 'string' && value.proofToolCallId.length > 0
      ? { toolCallId: value.proofToolCallId, guardId: null }
      : null
  }
  if (!Array.isArray(value.facts) || value.facts.length !== 1) return null
  const fact = value.facts[0]
  if (
    !object(fact) ||
    typeof fact.guardId !== 'string' ||
    typeof fact.proofToolCallId !== 'string' ||
    fact.proofToolCallId.length === 0
  )
    return null
  return { toolCallId: fact.proofToolCallId, guardId: fact.guardId }
}

function capturedChild(
  active: ActiveBatch,
  value: unknown,
  expectedId: string | null,
  captureId: string | null = null,
): NativeChildResult {
  const child = object(value) ? value : null
  const id = child !== null && typeof child.id === 'string' ? child.id : null
  const captureKey = id ?? captureId
  const capture = captureKey === null ? undefined : active.captures.get(captureKey)
  const submissions = capture?.submissions ?? []
  const task =
    expectedId === null ? undefined : active.batch.tasks.tasks.find((candidate) => candidate.name === expectedId)
  const directive = task?.proofEvidence ?? null
  const structured = child === null ? null : terminalStructured(child)
  const proofReference = selectedProofReference(structured, directive)
  let reason: string | null = null
  if (child === null) reason = expectedId === null ? 'malformed-child-result' : 'missing-required-child-result'
  else if (child.exitCode !== 0) reason = 'required-child-exit-code'
  else if (child.error !== undefined && child.error !== null) reason = 'required-child-error'
  else if (child.aborted === true) reason = 'required-child-aborted'
  else if (!object(child.structuredOutput)) reason = 'missing-structured-output'
  else if (child.structuredOutput.status !== 'valid') reason = 'structured-output-not-valid'
  else if (submissions.length === 0 || submissions.at(-1)?.data === null) reason = 'missing-captured-yield'
  else if (!isDeepStrictEqual(structured, submissions.at(-1)?.data)) reason = 'structured-output-yield-mismatch'
  return {
    id,
    expectedId,
    submissions,
    proofEvidence:
      directive === null
        ? null
        : {
            ...directive,
            guardId: proofReference?.guardId ?? null,
            call:
              proofReference === null || capture?.ambiguousProofCallIds.has(proofReference.toolCallId)
                ? null
                : (capture?.completedProofCalls.get(proofReference.toolCallId) ?? null),
          },
    bashCalls: referencedBashCalls(capture, structured),
    raw: nativeSnapshot(value),
    partialText: capture?.partialText ?? null,
    structured,
    usable: reason === null,
    reason,
  }
}

function referencedToolCallIds(structured: Json | null): Set<string> {
  if (!object(structured)) return new Set()
  const ids = new Set<string>()
  if (typeof structured.proofToolCallId === 'string' && structured.proofToolCallId.length > 0) {
    ids.add(structured.proofToolCallId)
  }
  if (!Array.isArray(structured.commands)) return ids
  for (const command of structured.commands) {
    if (object(command) && typeof command.toolCallId === 'string' && command.toolCallId.length > 0) {
      ids.add(command.toolCallId)
    }
  }
  return ids
}

/** Claimed IDs only, including every conflicting capture of those IDs. Unreferenced calls stay ephemeral. */
function referencedBashCalls(capture: ChildCapture | undefined, structured: Json | null): NativeProofBashCall[] {
  if (capture === undefined) return []
  const ids = referencedToolCallIds(structured)
  if (ids.size === 0) return []
  const selected: NativeProofBashCall[] = []
  for (const id of ids) {
    const completed = capture.completedBashCalls.get(id)
    if (completed !== undefined) selected.push(completed)
    for (const conflict of capture.conflictingBashCalls) {
      if (conflict.toolCallId === id) selected.push(conflict)
    }
  }
  return selected
}

function proofDirective(active: ActiveBatch, childId: string): NativeProofDirective | null {
  return active.batch.tasks.tasks.find((task) => task.name === childId)?.proofEvidence ?? null
}

/**
 * A short-lived native dispatch authority. It has no queue, retry, persistence,
 * or subprocess execution: Roxabi prepares each batch, while the model makes one
 * exact built-in `task` call guarded by this bridge.
 */
export class NativeBatchController {
  #active: ActiveBatch | null = null
  #terminalByBatch = new WeakMap<NativeBatch, Promise<void>>()
  #rootContext: ExtensionContext | null = null
  #featureBatches = new WeakSet<NativeBatch>()
  #featureContinuationInhibited = false

  activate(batch: NativeBatch, callbacks: NativeBatchCallbacks): void {
    if (!batch.operationId || batch.tasks.tasks.length === 0)
      throw new TypeError('native batch requires an operation and tasks')
    if (
      batch.tasks.tasks.some((task) => task.name.length === 0) ||
      new Set(batch.tasks.tasks.map((task) => task.name)).size !== batch.tasks.tasks.length
    )
      throw new TypeError('native batch task names must be non-empty and unique')
    if (this.#active) throw new Error('a native batch is already active')
    this.#active = {
      batch,
      wire: nativeTaskInput(batch),
      callbacks,
      defaultCwd: this.#rootContext?.cwd ?? null,
      admittedToolCallId: null,
      spawnedIndexes: new Set(),
      announced: false,
      announcementDispatched: false,
      settling: false,
      abortCleanup: null,
      captures: new Map(),
    }
  }

  inactive(): void {
    if (this.#active) this.#detach(this.#active)
  }

  /** Fence, conserve, and stop only the caller's current batch. */
  async stopOwned(batch: NativeBatch, reason: string): Promise<void> {
    const terminal = this.#terminalByBatch.get(batch)
    if (terminal !== undefined) return await terminal
    const active = this.#active
    if (!active || active.batch !== batch || active.settling) return
    await this.#stopActive(active, reason)
  }

  active(): NativeBatch | null {
    return this.#active?.batch ?? null
  }

  wire(batch: NativeBatch): NativeTaskWireInput | null {
    return this.#active?.batch === batch ? this.#active.wire : null
  }

  observeRootContext(ctx: ExtensionContext): void {
    if (!root(ctx)) return
    this.#rootContext = ctx
    if (this.#active) this.#active.defaultCwd = ctx.cwd
  }

  markFeatureBatch(batch: NativeBatch): void {
    this.#featureBatches.add(batch)
  }

  /** Drop an undelivered feature follow-up without claiming pause-confirmed. */
  inhibitFeatureContinuation(): void {
    this.#featureContinuationInhibited = true
    const active = this.#active
    if (
      active &&
      this.#featureBatches.has(active.batch) &&
      active.announced &&
      !active.announcementDispatched &&
      active.admittedToolCallId === null
    ) {
      active.announcementDispatched = true
    }
  }

  releaseFeatureContinuation(): void {
    this.#featureContinuationInhibited = false
  }

  featureContinuationInhibited(): boolean {
    return this.#featureContinuationInhibited
  }

  /** Mark a freshly prepared batch ready; return false only for a stale or repeated request. */
  announce(batch: NativeBatch): boolean {
    if (this.#featureContinuationInhibited && this.#featureBatches.has(batch)) return false
    if (!this.#active || this.#active.settling || this.#active.batch !== batch || this.#active.announced) return false
    this.#active.announced = true
    return true
  }

  /** An idle command handler must start the first model turn immediately. */
  takeIdleAnnouncement(batch: NativeBatch): NativeBatch | null {
    const active = this.#active
    if (
      !active ||
      (this.#featureContinuationInhibited && this.#featureBatches.has(active.batch)) ||
      active.settling ||
      active.batch !== batch ||
      !active.announced ||
      active.announcementDispatched ||
      !this.#rootContext?.isIdle()
    )
      return null
    active.announcementDispatched = true
    return active.batch
  }

  /** Internal bridge transition after exact `tool_call` equality and identity binding. */
  admit(batch: NativeBatch, toolCallId: string): boolean {
    if (
      !this.#active ||
      this.#active.settling ||
      this.#active.batch !== batch ||
      this.#active.admittedToolCallId !== null
    )
      return false
    this.#active.admittedToolCallId = toolCallId
    return true
  }
  allowSpawn(event: BeforeSubagentSpawnEvent): string | null {
    const active = this.#active
    if (!active) return null
    if (active.settling) return 'native batch is settling'
    if (active.admittedToolCallId === null) return 'native subagent spawn occurred before the host-authorized task call'
    if (event.invocationKind !== 'task') return 'native subagent spawn is outside the host-authorized task invocation'
    const spawnKey = event.spawnKey
    if (spawnKey === undefined) return 'native subagent spawn lacks its native task identity'
    const index = active.batch.tasks.tasks.findIndex((task) => task.name === spawnKey)
    if (index === -1) return 'native subagent spawn does not match one authorized native task identity'
    const expected = active.batch.tasks.tasks[index]
    if (expected.agent !== event.agent || active.spawnedIndexes.has(index)) {
      return 'native subagent spawn does not match an authorized native task identity'
    }
    active.spawnedIndexes.add(index)
    return null
  }

  captureSubagentEvent(payload: SubagentEventPayload): void {
    const active = this.#active
    if (!active || active.admittedToolCallId === null) return
    const event = payload.event
    const capture = captureFor(active, payload.id)
    if (event.type === 'message_start') {
      if (object(event.message) && event.message.role === 'assistant') capture.deltasByContentIndex.clear()
      return
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      capture.textDeltas.push(event.assistantMessageEvent.delta)
      capture.partialText = capture.textDeltas.join('')
      for (const submission of capture.submissions) submission.partialText = capture.partialText
      return
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'toolcall_delta') {
      const deltas = capture.deltasByContentIndex.get(event.assistantMessageEvent.contentIndex) ?? []
      deltas.push(event.assistantMessageEvent.delta)
      capture.deltasByContentIndex.set(event.assistantMessageEvent.contentIndex, deltas)
      return
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'toolcall_end') {
      const { contentIndex, toolCall } = event.assistantMessageEvent
      if (toolCall.name !== 'yield') return
      capture.pendingCalls.set(
        toolCall.id,
        rawYieldCall(toolCall.id, contentIndex, capture.deltasByContentIndex.get(contentIndex) ?? [], toolCall),
      )
      return
    }
    if (event.type === 'tool_execution_start' && event.toolName === 'yield') {
      const pending = capture.pendingCalls.get(event.toolCallId)
      const raw: YieldRaw = pending ?? {
        toolCallId: event.toolCallId,
        contentIndex: null,
        argumentDeltas: [],
        argumentText: '',
        rawBlock: null,
        toolCallArguments: null,
        executionArguments: null,
      }
      raw.executionArguments = nativeSnapshot(event.args)
      capture.pendingCalls.delete(event.toolCallId)
      capture.submissions.push({
        attemptIndex: capture.submissions.length,
        data: yieldedData(event.args),
        raw,
        partialText: capture.partialText,
      })
      return
    }
    if (event.type === 'tool_execution_start' && event.toolName === 'bash') {
      const input = observedBashInput(event.args)
      if (input !== null) {
        const pending = { input, effectiveCwd: effectiveBashCwd(event.args, active.defaultCwd) }
        if (proofDirective(active, payload.id) !== null) capture.pendingProofCalls.set(event.toolCallId, pending)
        if (this.#featureBatches.has(active.batch)) capture.pendingBashCalls.set(event.toolCallId, pending)
      }
      return
    }
    if (event.type === 'tool_execution_end' && event.toolName === 'bash') {
      const proofPending = capture.pendingProofCalls.get(event.toolCallId)
      if (proofPending !== undefined) {
        capture.pendingProofCalls.delete(event.toolCallId)
        rememberBashCall(
          capture.completedProofCalls,
          capture.ambiguousProofCallIds,
          event.toolCallId,
          proofPending,
          event,
        )
      }
      const bashPending = capture.pendingBashCalls.get(event.toolCallId)
      if (bashPending !== undefined) {
        capture.pendingBashCalls.delete(event.toolCallId)
        rememberBashCall(
          capture.completedBashCalls,
          capture.ambiguousBashCallIds,
          event.toolCallId,
          bashPending,
          event,
          capture.conflictingBashCalls,
        )
      }
      return
    }
    if (event.type === 'message_end') {
      const text = assistantText(event.message)
      if (text !== null) {
        capture.partialText = text
        for (const submission of capture.submissions) submission.partialText = text
      }
      capture.deltasByContentIndex.clear()
    }
  }

  #flushPendingYields(active: ActiveBatch): void {
    for (const capture of active.captures.values()) {
      for (const raw of capture.pendingCalls.values()) {
        const argumentsValue = object(raw) && 'toolCallArguments' in raw ? raw.toolCallArguments : undefined
        capture.submissions.push({
          attemptIndex: capture.submissions.length,
          data: yieldedData(argumentsValue),
          raw,
          partialText: capture.partialText,
        })
      }
      capture.pendingCalls.clear()
      capture.pendingProofCalls.clear()
    }
  }

  async receiveResult(event: ToolResultEvent): Promise<void> {
    const active = this.#active
    if (!active || active.admittedToolCallId !== event.toolCallId) return
    const terminal = this.#terminalByBatch.get(active.batch)
    if (terminal !== undefined) return await terminal
    if (active.settling) return
    active.settling = true
    this.#flushPendingYields(active)
    const values = object(event.details) && Array.isArray(event.details.results) ? event.details.results : []
    const terminalByTaskIndex = new Map<number, { terminalIndex: number; value: unknown }>()
    const terminalChildIds = new Set<string>()
    let exactAssociation = true
    for (const [terminalIndex, value] of values.entries()) {
      const childId = object(value) && typeof value.id === 'string' ? value.id : null
      if (
        !object(value) ||
        typeof value.index !== 'number' ||
        !Number.isInteger(value.index) ||
        value.index < 0 ||
        value.index >= active.batch.tasks.tasks.length ||
        terminalByTaskIndex.has(value.index) ||
        childId === null ||
        childId.length === 0 ||
        terminalChildIds.has(childId)
      ) {
        exactAssociation = false
        continue
      }
      terminalChildIds.add(childId)
      terminalByTaskIndex.set(value.index, { terminalIndex, value })
    }
    const consumed = new Set<number>()
    const children: NativeChildResult[] = []
    for (const [taskIndex, task] of active.batch.tasks.tasks.entries()) {
      const terminal = terminalByTaskIndex.get(taskIndex)
      if (terminal !== undefined) {
        consumed.add(terminal.terminalIndex)
        const child = capturedChild(active, terminal.value, task.name)
        const agent = object(terminal.value) && typeof terminal.value.agent === 'string' ? terminal.value.agent : null
        if (child.id === null || agent !== task.agent) exactAssociation = false
        children.push(child)
      } else {
        children.push(capturedChild(active, null, task.name))
      }
    }
    for (const [index, value] of values.entries()) {
      if (!consumed.has(index)) children.push(capturedChild(active, value, null))
    }
    const exactCount = values.length === active.batch.tasks.tasks.length
    const identitiesMatch =
      exactCount && exactAssociation && terminalByTaskIndex.size === active.batch.tasks.tasks.length
    const complete =
      event.isError !== true &&
      exactCount &&
      identitiesMatch &&
      children.length === active.batch.tasks.tasks.length &&
      children.every((child) => child.usable)
    const result: NativeBatchResult = {
      batch: active.batch,
      children,
      raw: nativeSnapshot({
        toolCallId: event.toolCallId,
        isError: event.isError,
        details: event.details,
        content: event.content,
      }),
      complete,
    }
    await this.#finishResult(active, event, result, complete, exactCount, identitiesMatch)
  }

  #finishResult(
    active: ActiveBatch,
    event: ToolResultEvent,
    result: NativeBatchResult,
    complete: boolean,
    exactCount: boolean,
    identitiesMatch: boolean,
  ): Promise<void> {
    const terminal = (async (): Promise<void> => {
      const publicationErrors = await this.#publishRaw(active, result.children)
      this.#detach(active)
      if (publicationErrors.length > 0) {
        await active.callbacks.onStop(`raw-publication-failed:${publicationErrors.join('; ')}`, result)
        return
      }
      if (!complete) {
        const reason = event.isError
          ? 'root-task-is-error'
          : !exactCount
            ? 'unexpected-required-child-count'
            : !identitiesMatch
              ? 'unexpected-required-child-id'
              : (result.children.find((child) => !child.usable)?.reason ?? 'required-child-invalid')
        await active.callbacks.onStop(reason, result)
        return
      }
      await active.callbacks.onComplete(result)
      await active.callbacks.onSettled?.(result)
    })()
    this.#rememberTerminal(active.batch, terminal)
    return terminal
  }

  async stop(reason: string): Promise<void> {
    const active = this.#active
    if (!active) return
    const terminal = this.#terminalByBatch.get(active.batch)
    if (terminal !== undefined) return await terminal
    if (active.settling) return
    await this.#stopActive(active, reason)
  }

  #stopActive(active: ActiveBatch, reason: string): Promise<void> {
    active.settling = true
    this.#detach(active)
    this.#flushPendingYields(active)
    const children = [
      ...active.batch.tasks.tasks.map((task) => capturedChild(active, null, task.name)),
      ...[...active.captures.keys()].map((childId) => capturedChild(active, null, null, childId)),
    ]
    const result: NativeBatchResult = { batch: active.batch, children, raw: null, complete: false }
    const terminal = (async (): Promise<void> => {
      const publicationErrors = await this.#publishRaw(active, children)
      const stopReason =
        publicationErrors.length === 0 ? reason : `raw-publication-failed:${publicationErrors.join('; ')}`
      await active.callbacks.onStop(stopReason, result)
    })()
    this.#rememberTerminal(active.batch, terminal)
    return terminal
  }

  #rememberTerminal(batch: NativeBatch, terminal: Promise<void>): void {
    this.#terminalByBatch.set(batch, terminal)
    void terminal.then(
      () => {
        if (this.#terminalByBatch.get(batch) === terminal) this.#terminalByBatch.delete(batch)
      },
      () => {
        if (this.#terminalByBatch.get(batch) === terminal) this.#terminalByBatch.delete(batch)
      },
    )
  }

  async settle(): Promise<void> {
    const active = this.#active
    if (active?.announced && !active.announcementDispatched && active.admittedToolCallId === null) return
    await this.stop('native-task-diverged-before-dispatch')
  }

  watchSettleAbort(signal: AbortSignal): void {
    const active = this.#active
    if (!active || active.settling) return
    active.abortCleanup?.()
    const onAbort = (): void => {
      void this.stop('session-settle-aborted').catch(() => undefined)
    }
    active.abortCleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
  }

  consumeFollowUp(): NativeBatch | null {
    const active = this.#active
    if (
      !active ||
      (this.#featureContinuationInhibited && this.#featureBatches.has(active.batch)) ||
      active.settling ||
      !active.announced ||
      active.announcementDispatched ||
      active.admittedToolCallId !== null
    )
      return null
    active.announcementDispatched = true
    return active.batch
  }

  #detach(active: ActiveBatch): void {
    active.abortCleanup?.()
    active.abortCleanup = null
    if (this.#active === active) this.#active = null
  }

  async #publishRaw(active: ActiveBatch, children: readonly NativeChildResult[]): Promise<string[]> {
    const errors: string[] = []
    for (const child of children) {
      try {
        await active.callbacks.onChildResult?.(child)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return errors
  }
}

function announceMessage(input: NativeTaskWireInput): string {
  // Model-facing wire only: SDK requires harness intent `i`; execution-authority admit keeps `input` without it.
  const modelFacing = { i: NATIVE_TASK_INTENT, ...input }
  return [
    'OMP_BUILD_NATIVE_BATCH:',
    JSON.stringify(modelFacing),
    'Invoke exactly this one prepared native task batch now. Do not alter its context, tasks, roles, names, or schema fields. If it cannot be invoked exactly, stop and report the divergence.',
  ].join('\n')
}

/** Port injected into Roxabi products; dispatch remains a model continuation, never direct task execution. */
export function createNativeReviewPort(
  pi: NativeExtension,
  controller: NativeBatchController,
): Pick<NativeBatchController, 'activate' | 'inactive' | 'stopOwned'> & {
  announce(batch: NativeBatch): Promise<void>
} {
  return {
    activate: controller.activate.bind(controller),
    inactive: controller.inactive.bind(controller),
    stopOwned: controller.stopOwned.bind(controller),
    async announce(batch): Promise<void> {
      if (!controller.announce(batch)) throw new Error('native batch is not the active batch ready for announcement')
      const immediate = controller.takeIdleAnnouncement(batch)
      const input = immediate === null ? null : controller.wire(immediate)
      if (input !== null) await pi.sendUserMessage(announceMessage(input))
    },
  }
}

/** Install the public-SDK native task bridge and raw-yield capture. */
export function installNativeBatchBridge(pi: NativeExtension, controller: NativeBatchController): void {
  pi.on('session_start', (_event, ctx) => {
    controller.observeRootContext(ctx)
  })

  pi.events.on('task:subagent:event', (value: unknown) => {
    if (!relevantSubagentPayload(value)) return
    controller.captureSubagentEvent(value)
  })

  pi.on('tool_call', (event: ToolCallEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (event.toolName !== 'task' || !root(ctx)) return
    const batch = controller.active()
    if (batch === null) return
    const input = controller.wire(batch)
    if (input === null) return
    if (!isDeepStrictEqual(event.input, input))
      return { block: true, reason: 'omp-build has a different host-authorized native task batch' }
    if (!controller.admit(batch, event.toolCallId))
      return { block: true, reason: 'native batch became inactive before dispatch' }
  })

  pi.on('before_subagent_spawn', (event: BeforeSubagentSpawnEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (!root(ctx)) return
    const reason = controller.allowSpawn(event)
    return reason === null ? undefined : { block: true, reason }
  })

  pi.on('tool_result', async (event: ToolResultEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (event.toolName === 'task' && root(ctx)) await controller.receiveResult(event)
  })

  pi.on('session_stop', async (event: SessionStopEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (!root(ctx)) return
    if (event.signal.aborted) {
      await controller.stop('session-settle-aborted')
      return
    }
    controller.watchSettleAbort(event.signal)
    await controller.settle()
  })

  pi.on('session_switch', async (_event: SessionSwitchEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) await controller.stop('session-switched')
  })

  pi.on('session_shutdown', async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) await controller.stop('session-shutdown')
  })

  pi.on('agent_end', async (event: AgentEndEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (!root(ctx) || event.willContinue) return
    const batch = controller.consumeFollowUp()
    const input = batch === null ? null : controller.wire(batch)
    if (input !== null) await pi.sendUserMessage(announceMessage(input), { deliverAs: 'followUp' })
  })
}
