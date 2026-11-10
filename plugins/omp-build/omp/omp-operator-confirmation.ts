import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { captureOrigin, type FramingOrigin } from '../roxabi/feature-framing-controller-lease.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { retainActionRecordSync } from './action-communication.ts'
import { driveConfirmation, type EscapeMode, stillRoot, unavailable } from './omp-operator-confirmation-drive.ts'
import {
  adoptWriter,
  clearPortStatus,
  drop,
  feedbackText,
  here,
  knownRequest,
  latestMatching,
  notifyOperator,
  type Presenter,
  presenterFor,
  retire,
  type Slot,
  type StatusEntry,
  sessionPresenter,
  setPortStatus,
  stopPortStatus,
} from './omp-operator-confirmation-presenter.ts'

/** Per-command capability. Composition cancels it on command/session liveness loss. */
export type CommandOperatorPort = OperatorPort & {
  cancel(): void
  progress(text: string | null): void
  /** Resolves only when the operator hides a proposal, not on cancellation or owner handoff. */
  readonly held: Promise<void>
}

export type OperatorReopen = 'reopened' | 'visible' | 'none' | 'other-origin' | 'preparing' | 'pending' | 'applying'

function interactive(ctx: ExtensionContext): boolean {
  return ctx.agent?.kind === 'main' && ctx.agent.depth === 0 && ctx.hasUI && ctx.mode === 'tui' && ctx.ui != null
}

function actionInFlight(entry: StatusEntry | null | undefined): entry is StatusEntry {
  return entry?.phase === 'applying' || entry?.phase === 'applying-after-stop'
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
  let origin: FramingOrigin | null = null
  const heldGate = Promise.withResolvers<void>()
  const resolveHeld = (): void => {
    heldGate.resolve()
  }
  const held = heldGate.promise
  const clearOwn = (settled = false): void => {
    if (bound === null) return
    bound.cancellers.delete(port)
    if (settled || !stopPortStatus(bound, port)) clearPortStatus(bound, port)
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
      if (text === null) {
        if (bound !== null && !actionInFlight(bound.statuses.get(port))) clearPortStatus(bound, port)
        return
      }
      if (!live || !interactive(ctx)) return
      if (actionInFlight(bound?.statuses.get(port))) return
      const presenter = presenterFor(ctx)
      if (presenter === null) return
      origin ??= captureOrigin(ctx)
      if (!here(origin, ctx)) return
      adoptWriter(presenter, ctx, port)
      bound = presenter
      presenter.cancellers.set(port, () => port.cancel())
      setPortStatus(presenter, port, origin, 'preparing', text)
    },
    held,
    async executeConfirmed(proposal, action) {
      if (!interactiveRoot(ctx, live, consumed)) return unavailable(proposal)
      const presenter = presenterFor(ctx)
      if (presenter === null) return unavailable(proposal)
      consumed = true
      adoptWriter(presenter, ctx, port)
      bound = presenter
      presenter.cancellers.set(port, () => port.cancel())
      try {
        origin ??= captureOrigin(ctx)
        if (!here(origin, ctx)) return unavailable(proposal)
        const displayedDigest = proposal.digest
        const displayedProposal = JSON.stringify(proposal.proposal, null, 2)
        const detail = retainActionRecordSync(ctx, 'proposal', proposal.proposal)
        const cancelled = new Promise<void>((resolve) => {
          if (cancellation.signal.aborted) resolve()
          else cancellation.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return await driveConfirmation({
          ctx,
          origin,
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
        clearOwn(true)
      }
    },
  }
  detachExternal = bindExternalAbort(options?.signal, () => port.cancel())
  return port
}

function explain(ctx: ExtensionContext, state: OperatorReopen, message: string): OperatorReopen {
  notifyOperator(ctx, message)
  return state
}

const OTHER_ORIGIN = 'Une opération existe dans un autre contexte ; aucune confirmation ouverte ici.'

/** Redraws the latest hidden same-origin proposal. Does not prepare, read or write. */
export function reopenOperatorConfirmation(ctx: ExtensionContext): OperatorReopen {
  if (!interactive(ctx)) return 'none'
  const presenter = sessionPresenter(ctx)
  if (presenter === undefined || !knownRequest(presenter)) return 'none'
  if (presenter.visible !== null) {
    return here(presenter.visible.origin, ctx)
      ? explain(ctx, 'visible', 'La confirmation est déjà ouverte ; choisir une action dans la fenêtre.')
      : explain(ctx, 'other-origin', OTHER_ORIGIN)
  }
  const hidden = latestMatching(presenter.hidden, ctx, 'hidden')
  if (hidden !== null) {
    drop(presenter.hidden, hidden)
    presenter.visible = hidden
    hidden.state = 'visible'
    hidden.reopen()
    return explain(ctx, 'reopened', 'Proposition conservée rouverte ; aucune décision confirmée par ce raccourci.')
  }
  if (presenter.waiting.some((slot) => slot.state === 'waiting' && here(slot.origin, ctx)))
    return explain(
      ctx,
      'pending',
      'La proposition attend son tour derrière une autre confirmation ; aucune décision prise.',
    )
  let current: StatusEntry | null = null
  for (const entry of presenter.statuses.values()) {
    if (here(entry.origin, ctx) && (current === null || entry.generation > current.generation)) current = entry
  }
  if (current?.phase === 'preparing') return explain(ctx, 'preparing', feedbackText(current))
  if (actionInFlight(current)) return explain(ctx, 'applying', feedbackText(current))
  return explain(ctx, 'other-origin', OTHER_ORIGIN)
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
  presenter.cancellers.clear()
  for (const cancelOne of cancel) cancelOne()
}
