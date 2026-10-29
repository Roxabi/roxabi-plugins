import type {
  BeforeSubagentSpawnEvent,
  ExtensionContext,
  SubagentEventPayload,
  ToolResultEvent,
} from '@oh-my-pi/pi-coding-agent'
import type { ActionCommunication } from '../action-communication.ts'
import { authorizedModelRoute } from './authorized-model-route.ts'
import { validateNativeBatch } from './batch-validation.ts'
import { captureSubagentEvent } from './capture'
import type { NativeBatch, NativeBatchCallbacks, NativeTaskWireInput } from './contracts'
import { indexAdmittedChildBatch, rootCurrent, unindexAdmittedChildBatch } from './executed-child-lifecycle.ts'
import { type HostGitObserver, observeHostGit } from './host-git-observation.ts'
import {
  type OwnedResultReplacement,
  replaceOwnedTaskResult,
  retainOwnedResult,
  unusableOwnedReplacement,
} from './result-replacement.ts'
import { isolatedReceivedSettlement, settleStoppedBatch } from './settlement'
import { type ActiveBatch, createActiveBatch, spawnRefusal } from './state'

/**
 * A short-lived native dispatch authority. It has no queue, retry, persistence,
 * or subprocess execution: Roxabi prepares each batch, while the model makes one
 * exact built-in `task` call guarded by this bridge.
 */
export class NativeBatchController {
  #active: ActiveBatch | null = null
  #lastActivated: NativeBatch | null = null
  #observeHostGit: HostGitObserver = observeHostGit
  #terminalByBatch = new WeakMap<NativeBatch, Promise<void>>()
  #live = new Set<ActiveBatch>()
  #ownedActive = new Map<string, ActiveBatch>()
  #ownedCalls = new Map<string, NativeBatch>()
  #rootContext: ExtensionContext | null = null
  #artifactsDir: string | null = null
  #communication: ActionCommunication | null = null
  #featureBatches = new WeakSet<NativeBatch>()
  #featureContinuationInhibited = false
  bindCommunication(communication: ActionCommunication): void {
    this.#communication = communication
    if (this.#active) this.#active.communication = communication
  }
  ownedSettlement(): Promise<void> {
    const active = this.#active
    if (active === null) return Promise.resolve()
    return this.#terminalByBatch.get(active.batch) ?? Promise.resolve()
  }
  bindHostGit(observer: HostGitObserver): void {
    this.#observeHostGit = observer
  }
  activate(batch: NativeBatch, callbacks: NativeBatchCallbacks): void {
    validateNativeBatch(batch)
    if (this.#active) throw new Error('a native batch is already active')
    this.#active = createActiveBatch(
      batch,
      callbacks,
      this.#rootContext?.cwd ?? null,
      this.#artifactsDir,
      this.#observeHostGit,
    )
    this.#active.communication = this.#communication
    this.#live.add(this.#active)
    this.#lastActivated = batch
    this.#communication?.status(`omp-build: native batch ${batch.operationId} active`)
  }
  inactive(): void {
    if (this.#active) this.#detach(this.#active)
  }
  /** Fence, conserve, and stop only the caller's current batch. */
  async stopOwned(batch: NativeBatch, reason: string): Promise<void> {
    const owned = [...this.#live].find((active) => active.batch === batch) ?? null
    if (owned) owned.contextPublicationOwned = false
    if (owned && owned.continuationClosed === null) owned.continuationClosed = reason
    const terminal = this.#terminalByBatch.get(batch)
    if (terminal !== undefined) return await terminal
    if (!owned || owned.settling) return
    await this.#stopActive(owned, reason)
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
    const artifacts = ctx.localProtocolOptions?.getArtifactsDir?.()
    if (typeof artifacts === 'string' && artifacts.length > 0) this.#artifactsDir = artifacts
    if (this.#active) {
      this.#active.defaultCwd = ctx.cwd
      if (this.#artifactsDir !== null) this.#active.artifactsDir = this.#artifactsDir
    }
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
    const ctx = this.#rootContext
    if (ctx?.agent.kind !== 'main' || ctx.agent.depth !== 0) return false
    indexAdmittedChildBatch(this, this.#active, ctx)
    this.#active.admittedToolCallId = toolCallId
    this.#ownedCalls.set(toolCallId, batch)
    this.#ownedActive.set(toolCallId, this.#active)
    return true
  }
  allowSpawn(event: BeforeSubagentSpawnEvent): string | null {
    const active = this.#active
    if (!active) return null
    const refusal = spawnRefusal(active, event)
    if (refusal !== null) return refusal
    const index = event.spawnKey === undefined ? undefined : active.childSlots.get(event.spawnKey)
    const task = index === undefined ? undefined : active.batch.tasks.tasks[index]
    const model = task && this.#rootContext ? authorizedModelRoute(this.#rootContext, task) : null
    if (index === undefined || !model) return 'native child model route unavailable'
    active.models[index] = model
    return null
  }
  executedChild(batch: NativeBatch, id: string, sessionId: string) {
    const active = this.#active
    if (
      !active ||
      active.settling ||
      active.batch !== batch ||
      active.admittedToolCallId === null ||
      !rootCurrent(active)
    )
      return null
    const guard = active.guardedChildren.get(id)
    return guard?.sessionId === sessionId ? guard : null
  }
  captureExecutedChild(batch: NativeBatch, id: string, sessionId: string, event: SubagentEventPayload['event']): void {
    const guard = this.executedChild(batch, id, sessionId)
    if (!guard?.valid || !this.#active) return
    captureSubagentEvent(this.#active, { id, event }, this.#featureBatches.has(batch))
  }
  noteRetentionFailure(toolCallId: string, reason: string): void {
    const active = this.#ownedActive.get(toolCallId) ?? this.#active
    if (active && active.retentionFailed === null) active.retentionFailed = reason
  }
  ownsTaskResult(toolCallId: string): boolean {
    return this.#active?.admittedToolCallId === toolCallId || this.#ownedCalls.has(toolCallId)
  }
  prepareOwnedResultReplacement(event: ToolResultEvent, ctx: ExtensionContext): OwnedResultReplacement | undefined {
    if (event.toolName !== 'task') return undefined
    const owned =
      this.#active?.admittedToolCallId === event.toolCallId
        ? this.#active.batch
        : this.#ownedCalls.get(event.toolCallId)
    if (owned === undefined) return undefined
    try {
      const replacement = replaceOwnedTaskResult(event, owned, (value) => retainOwnedResult(ctx, value))
      if (this.#active?.batch === owned && replacement.details.detailRef.startsWith('local://')) {
        this.#active.retainedResultRef = replacement.details.detailRef
      }
      return replacement
    } catch {
      return unusableOwnedReplacement('result-replacement-failed')
    }
  }
  queueOwnedSettlement(event: ToolResultEvent): void {
    const active = this.#active
    if (!active || event.toolName !== 'task' || active.admittedToolCallId !== event.toolCallId) return
    if (this.#terminalByBatch.has(active.batch) || active.settling) return
    this.#rememberTerminal(
      active.batch,
      isolatedReceivedSettlement(
        active,
        event,
        (current) => this.#detach(current),
        (batch) => this.#lastActivated === batch,
      ),
    )
  }
  async receiveResult(event: ToolResultEvent): Promise<void> {
    this.queueOwnedSettlement(event)
    await this.ownedSettlement()
  }
  async stop(reason: string): Promise<void> {
    const targets = new Set(this.#live)
    if (this.#active) targets.add(this.#active)
    for (const batch of targets) {
      batch.contextPublicationOwned = false
      if (batch.continuationClosed === null) batch.continuationClosed = reason
    }
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
      for (const active of this.#live) if (active.batch === batch) this.#live.delete(active)
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
    unindexAdmittedChildBatch(this, active)
    if (this.#active === active) this.#active = null
  }
}
