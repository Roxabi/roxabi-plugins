import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { captureOrigin } from '../roxabi/feature-framing-controller-lease.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { retainActionRecordSync } from './action-communication.ts'
import { driveConfirmation, type EscapeMode, stillRoot, unavailable } from './omp-operator-confirmation-drive.ts'
import {
  adoptWriter,
  clearPortStatus,
  drop,
  here,
  knownRequest,
  latestMatching,
  type Presenter,
  presenterFor,
  retire,
  type Slot,
  sessionPresenter,
  setPortStatus,
} from './omp-operator-confirmation-presenter.ts'

/** Per-command capability. Composition cancels it on command/session liveness loss. */
export type CommandOperatorPort = OperatorPort & {
  cancel(): void
  progress(text: string): void
  /** Resolves only when the operator hides a proposal, not on cancellation or owner handoff. */
  readonly held: Promise<void>
}

export type OperatorReopen = 'reopened' | 'visible' | 'none' | 'other-origin' | 'preparing' | 'pending'

function interactive(ctx: ExtensionContext): boolean {
  return ctx.agent?.kind === 'main' && ctx.agent.depth === 0 && ctx.hasUI && ctx.mode === 'tui' && ctx.ui != null
}

/**
 * Releases the SDK command handler when the proposal is first held, without cancelling `work`.
 * A later rejection is reported only by `report` and never left unhandled.
 */
export async function raceOperatorHold(
  work: Promise<void>,
  held: Promise<void>,
  report: (error: unknown) => void,
): Promise<void> {
  let released = false
  const gate = held.then(() => {
    released = true
  })
  const guarded = work.then(
    () => undefined,
    (error: unknown) => {
      if (!released) throw error
      try {
        report(error)
      } catch {
        // A stale reporter must not become an unhandled rejection.
      }
    },
  )
  await Promise.race([guarded, gate])
}

export type OperatorConfirmationOptions = {
  escape?: EscapeMode
  /** Registered SDK execution signal. Abort calls the existing port cancel. */
  signal?: AbortSignal
}

function interactiveRoot(ctx: ExtensionContext, live: boolean, consumed: boolean): boolean {
  return !consumed && stillRoot(ctx, live) && ctx.ui != null
}

function bindExternalAbort(signal: AbortSignal | undefined, cancel: () => void): () => void {
  if (signal === undefined) return () => undefined
  const onAbort = (): void => {
    signal.removeEventListener('abort', onAbort)
    cancel()
  }
  if (signal.aborted) {
    cancel()
    return () => undefined
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

/** Captures the actual root command context; argv and child output cannot mint its confirmation. */
export function createOperatorConfirmation(
  ctx: ExtensionContext,
  options?: OperatorConfirmationOptions,
): CommandOperatorPort {
  const escapeMode = options?.escape ?? 'hold'
  let live = true
  let consumed = false
  const cancellation = new AbortController()
  let active: Slot | null = null
  let bound: Presenter | null = null
  const heldGate = Promise.withResolvers<void>()
  const resolveHeld = (): void => {
    heldGate.resolve()
  }
  const held = heldGate.promise
  const clearOwn = (): void => {
    if (bound === null) return
    bound.preparing.delete(port)
    bound.cancellers.delete(port)
    clearPortStatus(bound, port)
    if (active !== null) retire(bound, active)
    active = null
  }
  let detachExternal = (): void => {}
  const port: CommandOperatorPort = {
    cancel() {
      detachExternal()
      live = false
      cancellation.abort()
      clearOwn()
    },
    progress(text) {
      if (!live || !interactive(ctx)) return
      const presenter = presenterFor(ctx)
      if (presenter === null) return
      const origin = captureOrigin(ctx)
      adoptWriter(presenter, ctx, port)
      bound = presenter
      presenter.cancellers.set(port, () => port.cancel())
      presenter.preparing.set(port, origin)
      setPortStatus(presenter, port, text)
    },
    held,
    async executeConfirmed(proposal, action) {
      if (!interactiveRoot(ctx, live, consumed)) return unavailable(proposal)
      const presenter = presenterFor(ctx)
      if (presenter === null) return unavailable(proposal)
      consumed = true
      const displayedDigest = proposal.digest
      const displayedProposal = JSON.stringify(proposal.proposal, null, 2)
      const detail = retainActionRecordSync(ctx, 'proposal', proposal.proposal)
      adoptWriter(presenter, ctx, port)
      bound = presenter
      presenter.cancellers.set(port, () => port.cancel())
      presenter.preparing.delete(port)
      const cancelled = new Promise<void>((resolve) => {
        if (cancellation.signal.aborted) resolve()
        else cancellation.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      try {
        return await driveConfirmation({
          ctx,
          port,
          proposal,
          action,
          presenter,
          detail,
          escapeMode,
          displayedDigest,
          displayedProposal,
          cancelled,
          signal: cancellation.signal,
          unavailable,
          live: () => live,
          failShow: () => {
            live = false
          },
          bindSlot: (slot) => {
            active = slot
          },
          releaseSlot: (slot) => {
            retire(presenter, slot)
            active = null
          },
          resolveHeld,
        })
      } finally {
        detachExternal()
        clearOwn()
      }
    },
  }
  detachExternal = bindExternalAbort(options?.signal, () => port.cancel())
  return port
}

/** Redraws the latest hidden same-origin proposal. Does not prepare, read or write. */
export function reopenOperatorConfirmation(ctx: ExtensionContext): OperatorReopen {
  if (!interactive(ctx)) return 'none'
  const presenter = sessionPresenter(ctx)
  if (presenter === undefined || !knownRequest(presenter)) return 'none'
  if (presenter.visible !== null) return 'visible'
  const hidden = latestMatching(presenter.hidden, ctx, 'hidden')
  if (hidden !== null) {
    drop(presenter.hidden, hidden)
    presenter.visible = hidden
    hidden.state = 'visible'
    hidden.reopen()
    return 'reopened'
  }
  if (presenter.waiting.some((slot) => slot.state === 'waiting' && here(slot.origin, ctx))) return 'pending'
  for (const prepared of presenter.preparing.values()) {
    if (here(prepared, ctx)) return 'preparing'
  }
  return 'other-origin'
}

/** Cancels visible, waiting, held and preparing frames for this session. Does not touch workflow leases. */
export function cancelOperatorConfirmations(ctx: ExtensionContext, reason: string): void {
  void reason
  const presenter = sessionPresenter(ctx)
  if (presenter === undefined) return
  const cancel = [...presenter.cancellers.values()]
  presenter.visible = null
  presenter.waiting = []
  presenter.hidden = []
  presenter.preparing.clear()
  presenter.cancellers.clear()
  for (const cancelOne of cancel) cancelOne()
}
