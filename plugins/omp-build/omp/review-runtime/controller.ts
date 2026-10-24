import type {
  BeforeSubagentSpawnEvent,
  ExtensionContext,
  SubagentEventPayload,
  ToolResultEvent,
} from '@oh-my-pi/pi-coding-agent'
import { captureSubagentEvent } from './capture'
import type { NativeBatch, NativeBatchCallbacks, NativeTaskWireInput } from './contracts'
import { settleReceivedBatch, settleStoppedBatch } from './settlement'
import type { ActiveBatch } from './state'
import { createActiveBatch } from './state'
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
    if (!batch.operationId || batch.tasks.tasks.length === 0) {
      throw new TypeError('native batch requires an operation and tasks')
    }
    const names = batch.tasks.tasks.map((task) => task.name)
    if (names.some((name) => name.length === 0) || new Set(names).size !== names.length) {
      throw new TypeError('native batch task names must be non-empty and unique')
    }
    if (this.#active) throw new Error('a native batch is already active')
    this.#active = createActiveBatch(batch, callbacks, this.#rootContext?.cwd ?? null)
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
    if (ctx.agent.kind !== 'main' || ctx.agent.depth !== 0) return
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
    ) {
      return null
    }
    active.announcementDispatched = true
    return active.batch
  }
  /** Internal bridge transition after exact `tool_call` equality and identity binding. */
  admit(batch: NativeBatch, toolCallId: string): boolean {
    if (!this.#active || this.#active.settling || this.#active.batch !== batch) return false
    if (this.#active.admittedToolCallId !== null) return false
    this.#active.admittedToolCallId = toolCallId
    return true
  }
  allowSpawn(event: BeforeSubagentSpawnEvent): string | null {
    const active = this.#active
    if (!active) return null
    if (active.settling) return 'native batch is settling'
    if (active.admittedToolCallId === null) {
      return 'native subagent spawn occurred before the host-authorized task call'
    }
    if (event.invocationKind !== 'task') {
      return 'native subagent spawn is outside the host-authorized task invocation'
    }
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
    captureSubagentEvent(active, payload, this.#featureBatches.has(active.batch))
  }
  async receiveResult(event: ToolResultEvent): Promise<void> {
    const active = this.#active
    if (!active || active.admittedToolCallId !== event.toolCallId) return
    const terminal = this.#terminalByBatch.get(active.batch)
    if (terminal !== undefined) return await terminal
    if (active.settling) return
    active.settling = true
    const settled = settleReceivedBatch(active, event, (current) => this.#detach(current))
    this.#rememberTerminal(active.batch, settled)
    await settled
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
    const terminal = settleStoppedBatch(active, reason, (current) => this.#detach(current))
    this.#rememberTerminal(active.batch, terminal)
    return terminal
  }
  #rememberTerminal(batch: NativeBatch, terminal: Promise<void>): void {
    this.#terminalByBatch.set(batch, terminal)
    const forget = (): void => {
      if (this.#terminalByBatch.get(batch) === terminal) this.#terminalByBatch.delete(batch)
    }
    void terminal.then(forget, forget)
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
    ) {
      return null
    }
    active.announcementDispatched = true
    return active.batch
  }
  #detach(active: ActiveBatch): void {
    active.abortCleanup?.()
    active.abortCleanup = null
    if (this.#active === active) this.#active = null
  }
}
