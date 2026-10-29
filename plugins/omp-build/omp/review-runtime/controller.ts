import type { BeforeSubagentSpawnEvent, ExtensionContext, SubagentEventPayload } from '@oh-my-pi/pi-coding-agent'
import type { ActionCommunication } from '../action-communication.ts'
import { NativeAnnouncements } from './announcements'
import { admitNativeBatch } from './batch-admission.ts'
import { validateNativeBatch } from './batch-validation.ts'
import { captureSubagentEvent } from './capture'
import type { NativeBatch, NativeBatchCallbacks, NativeExecutionObservation, NativeTaskWireInput } from './contracts'
import { rootCurrent, unindexAdmittedChildBatch } from './executed-child-lifecycle.ts'
import { type HostGitObserver, observeHostGit } from './host-git-observation.ts'
import {
  type OwnedResultReplacement,
  retainNativeObservation,
  retainOwnedResult,
  unusableOwnedReplacement,
} from './result-replacement.ts'
import { isolatedReceivedSettlement, ownsBatchPresentation, settleStoppedBatch } from './settlement'
import {
  type ActiveBatch,
  clearBatchSettleAbort,
  createActiveBatch,
  rememberBatchTerminal,
  spawnRefusal,
  watchBatchSettleAbort,
} from './state'
import { releaseTaskMask } from './task-mask-lease'
/** Short-lived authority for one sealed, plugin-owned native batch. */
export class NativeBatchController {
  #active: ActiveBatch | null = null
  #lastActivated: ActiveBatch | null = null
  #lastActivatedSessionId: string | null = null
  #observeHostGit: HostGitObserver = observeHostGit
  #terminalByBatch = new WeakMap<NativeBatch, Promise<void>>()
  #live = new Set<ActiveBatch>()
  #ownedActive = new Map<string, ActiveBatch>()
  #rootContext: ExtensionContext | null = null
  #artifactsDir: string | null = null
  #communication: ActionCommunication | null = null
  #announcements = new NativeAnnouncements()
  rootContext(): ExtensionContext | null {
    return this.#rootContext
  }
  status(message: string): void {
    this.#communication?.status(`omp-build: ${message}`)
  }
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
    this.#lastActivated = this.#active
    this.#lastActivatedSessionId = this.#rootContext?.sessionManager.getSessionId() ?? null
    this.#communication?.status(`omp-build: native batch ${batch.operationId} active`)
  }
  inactive(): void {
    if (this.#active) {
      const batch = this.#active.batch
      this.#detach(this.#active)
      void releaseTaskMask(this, false, batch).catch((error) => {
        this.status(`native task mask restoration failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
  /** Fence, conserve, and stop only the caller's current batch. */
  async stopOwned(batch: NativeBatch, reason: string): Promise<void> {
    const owned = [...this.#live].find((active) => active.batch === batch) ?? null
    if (owned) owned.contextPublicationOwned = false
    if (owned && owned.continuationClosed === null) owned.continuationClosed = reason
    owned?.executionAbort?.abort(reason)
    try {
      await releaseTaskMask(this, false, batch)
    } catch (error) {
      this.status(`native task mask restoration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (owned !== null && owned.executionDone !== null) {
      await owned.executionDone
      const finished = this.#terminalByBatch.get(batch)
      if (finished !== undefined) await finished
      return
    }
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
    if (this.#active !== null && this.#active === this.#lastActivated && this.#lastActivatedSessionId === null) {
      this.#lastActivatedSessionId = ctx.sessionManager.getSessionId()
    }
    const artifacts = ctx.localProtocolOptions?.getArtifactsDir?.()
    if (typeof artifacts === 'string' && artifacts.length > 0) this.#artifactsDir = artifacts
    if (this.#active) {
      this.#active.defaultCwd = ctx.cwd
      if (this.#artifactsDir !== null) this.#active.artifactsDir = this.#artifactsDir
    }
  }
  markFeatureBatch(batch: NativeBatch): void {
    this.#announcements.markFeature(batch)
  }
  inhibitFeatureContinuation(): void {
    this.#announcements.inhibit(this.#active)
  }
  releaseFeatureContinuation(): void {
    this.#announcements.release()
  }
  featureContinuationInhibited(): boolean {
    return this.#announcements.isInhibited()
  }
  announce(batch: NativeBatch): boolean {
    return this.#announcements.announce(this.#active, batch)
  }
  takeIdleAnnouncement(batch: NativeBatch): NativeBatch | null {
    return this.#announcements.takeIdle(this.#active, batch, this.#rootContext?.isIdle() ?? false)
  }
  /** Bind the genuine owned-tool call to the announced action and root generation. */
  admit(batch: NativeBatch, toolCallId: string, ctx: ExtensionContext, current: () => boolean): boolean {
    return admitNativeBatch(this, this.#active, this.#ownedActive, batch, toolCallId, ctx, current)
  }
  executionSignal(batch: NativeBatch): AbortSignal | null {
    return this.#active?.batch === batch ? (this.#active.executionAbort?.signal ?? null) : null
  }
  current(batch: NativeBatch): boolean {
    return (
      this.#active?.batch === batch &&
      !this.#active.settling &&
      this.#active.continuationClosed === null &&
      rootCurrent(this.#active)
    )
  }
  bindChild(id: string, index: number, model: { provider: string; id: string }): boolean {
    const active = this.#active
    if (
      !active ||
      !this.current(active.batch) ||
      !active.batch.tasks.tasks[index] ||
      active.childSlots.has(id) ||
      [...active.childSlots.values()].includes(index)
    )
      return false
    active.childSlots.set(id, index)
    active.models[index] = model
    return true
  }
  finishExecution(batch: NativeBatch): void {
    const active = [...this.#live].find((item) => item.batch === batch)
    if (!active) return
    const finish = active.finishExecution
    active.finishExecution = null
    active.executionDone = null
    finish?.()
  }
  allowSpawn(event: BeforeSubagentSpawnEvent): string | null {
    const active = this.#active
    if (!active) return null
    if (event.spawnKey === undefined || !active.childSlots.has(event.spawnKey)) return null
    const refusal = spawnRefusal(active, event)
    if (refusal !== null) return refusal
    const index = event.spawnKey === undefined ? undefined : active.childSlots.get(event.spawnKey)
    if (index === undefined || !active.models[index]) return 'native child model route unavailable'
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
    captureSubagentEvent(this.#active, { id, event }, this.#announcements.isFeature(batch))
  }
  noteRetentionFailure(toolCallId: string, reason: string): void {
    const active = this.#ownedActive.get(toolCallId) ?? this.#active
    if (active && active.retentionFailed === null) active.retentionFailed = reason
  }
  prepareOwnedResult(observation: NativeExecutionObservation, ctx: ExtensionContext): OwnedResultReplacement {
    const active = this.#ownedActive.get(observation.toolCallId)
    if (!active) return unusableOwnedReplacement('unknown-owned-call')
    const replacement = retainNativeObservation(observation, active.batch, (value) => retainOwnedResult(ctx, value))
    if (replacement.details.detailRef.startsWith('local://')) active.retainedResultRef = replacement.details.detailRef
    else this.noteRetentionFailure(observation.toolCallId, replacement.details.summary)
    return replacement
  }
  queueOwnedSettlement(event: NativeExecutionObservation): void {
    const active = this.#active
    if (!active || active.admittedToolCallId !== event.toolCallId) return
    if (this.#terminalByBatch.has(active.batch) || active.settling) return
    rememberBatchTerminal(
      this.#terminalByBatch,
      this.#live,
      active.batch,
      isolatedReceivedSettlement(
        active,
        event,
        (current) => this.#detach(current),
        () => ownsBatchPresentation(active, this.#lastActivated, this.#lastActivatedSessionId, this.#rootContext),
      ),
    )
  }
  async receiveResult(event: NativeExecutionObservation): Promise<void> {
    this.queueOwnedSettlement(event)
    await this.ownedSettlement()
  }
  async stop(reason: string): Promise<void> {
    const targets = new Set(this.#live)
    if (this.#active) targets.add(this.#active)
    for (const batch of targets) {
      batch.contextPublicationOwned = false
      if (batch.continuationClosed === null) batch.continuationClosed = reason
      batch.executionAbort?.abort(reason)
    }
    try {
      await releaseTaskMask(this)
    } catch (error) {
      this.status(`native task mask restoration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const active = this.#active
    if (!active) return
    if (active.executionDone !== null) {
      await active.executionDone
      const finished = this.#terminalByBatch.get(active.batch)
      if (finished !== undefined) await finished
      return
    }
    const terminal = this.#terminalByBatch.get(active.batch)
    if (terminal !== undefined) return await terminal
    if (active.settling) return
    await this.#stopActive(active, reason)
  }
  #stopActive(active: ActiveBatch, reason: string): Promise<void> {
    const terminal = settleStoppedBatch(
      active,
      reason,
      (current) => this.#detach(current),
      () => ownsBatchPresentation(active, this.#lastActivated, this.#lastActivatedSessionId, this.#rootContext),
    )
    rememberBatchTerminal(this.#terminalByBatch, this.#live, active.batch, terminal)
    return terminal
  }
  async settle(): Promise<void> {
    const active = this.#active
    // A received result owns its asynchronous settlement independently of this
    // SDK stop hook. Joining it here can deadlock its callbacks.
    if (active === null || active.settling) return
    if (active?.announced && !active.announcementDispatched && active.admittedToolCallId === null) return
    await this.stop('native-task-diverged-before-dispatch')
  }
  watchSettleAbort(signal: AbortSignal): void {
    for (const active of this.#live) {
      watchBatchSettleAbort(active, signal, () => {
        void this.stopOwned(active.batch, 'session-settle-aborted').catch(() => undefined)
      })
    }
  }
  consumeFollowUp(): NativeBatch | null {
    return this.#announcements.consume(this.#active)
  }
  #detach(active: ActiveBatch): void {
    if (!active.settling) clearBatchSettleAbort(active)
    unindexAdmittedChildBatch(this, active)
    if (active.admittedToolCallId !== null) this.#ownedActive.delete(active.admittedToolCallId)
    if (this.#active === active) this.#active = null
  }
}
