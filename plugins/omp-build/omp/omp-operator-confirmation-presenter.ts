import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { type FramingOrigin, sameLocation, sameSession } from '../roxabi/feature-framing-controller-lease.ts'
import { nativeText } from './omp-operator-confirmation-field.ts'

const STATUS_KEY = 'omp-build-operator'

type SlotState = 'waiting' | 'visible' | 'hidden' | 'done'
export type FeedbackPhase = 'preparing' | 'queued' | 'visible' | 'held' | 'applying' | 'applying-after-stop'
export type StatusEntry = {
  generation: number
  origin: FramingOrigin
  phase: FeedbackPhase
  subject: string | null
}
type Ui = ExtensionContext['ui']

const PHASE_LABELS: Record<FeedbackPhase, string> = {
  preparing: 'Préparation en cours',
  queued: 'Confirmation en file',
  visible: 'Confirmation ouverte',
  held: 'Proposition conservée — Ctrl+Alt+U pour rouvrir',
  applying: 'Application en cours',
  'applying-after-stop': 'Arrêt reçu — action déjà commencée',
}

const PHASE_HELP: Record<FeedbackPhase, string> = {
  preparing: 'Lecture en cours ; aucune décision confirmée. La proposition ne peut pas encore être ouverte.',
  queued: 'Une autre confirmation est ouverte. Cette proposition attend son tour ; aucune décision prise.',
  visible: 'Examiner la proposition puis choisir Confirmer, Refuser, Plus tard ou Détails.',
  held: 'Aucune décision prise. Ctrl+Alt+U rouvre la même proposition.',
  applying: 'Choix confirmé, action commencée. Aucun retour arrière automatique ; ne pas relancer.',
  'applying-after-stop': 'Les effets commencés peuvent encore aboutir ; résultat non encore reçu. Ne pas relancer.',
}

function statusText(entry: StatusEntry): string {
  const label = PHASE_LABELS[entry.phase]
  return entry.subject === null ? label : `${label} — ${entry.subject}`
}

export function feedbackText(entry: StatusEntry): string {
  return `${statusText(entry)}. ${PHASE_HELP[entry.phase]}`
}

function notifyUi(ui: Ui, message: string, type: 'info' | 'warning' | 'error'): void {
  try {
    ui.notify?.(nativeText(message), type)
  } catch {
    // A presentation failure cannot interrupt an action or turn its publication into a failure.
  }
}

export function notifyOperator(
  ctx: ExtensionContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  if (!ctx.hasUI || ctx.mode !== 'tui' || ctx.agent?.kind !== 'main' || ctx.agent.depth !== 0 || ctx.ui == null) return
  notifyUi(ctx.ui, message, type)
}

function writeStatus(ui: Ui, text: string | undefined): void {
  try {
    ui.setStatus?.(STATUS_KEY, text === undefined ? undefined : nativeText(text))
  } catch {
    // Status is a projection, never a lifecycle gate; cleanup and exact confirmation still run.
  }
}

export type Slot = {
  port: object
  origin: FramingOrigin
  signal: AbortSignal
  state: SlotState
  grant: () => void
  granted: Promise<void>
  reopen: () => void
  reopened: Promise<void>
  armReopen: () => void
}

export type Presenter = {
  ui: Ui
  visible: Slot | null
  waiting: Slot[]
  hidden: Slot[]
  statuses: Map<object, StatusEntry>
  cancellers: Map<object, () => void>
  nextGeneration: number
}

/**
 * One presenter per live `ctx.sessionManager`. SDK 18.18.5 gives event handlers a fresh `ui` proxy
 * over the same context; command, tool and shortcut contexts share that session manager by identity.
 * No history or workflow registry.
 */
const presenters = new WeakMap<object, Presenter>()

function sessionKey(ctx: ExtensionContext): object | null {
  try {
    const session = ctx.sessionManager
    if (session == null || typeof session !== 'object') return null
    return session
  } catch {
    return null
  }
}

export function presenterFor(ctx: ExtensionContext): Presenter | null {
  const key = sessionKey(ctx)
  if (key === null || ctx.ui == null) return null
  let presenter = presenters.get(key)
  if (presenter === undefined) {
    presenter = {
      ui: ctx.ui,
      visible: null,
      waiting: [],
      hidden: [],
      statuses: new Map(),
      cancellers: new Map(),
      nextGeneration: 0,
    }
    presenters.set(key, presenter)
  }
  return presenter
}

export function sessionPresenter(ctx: ExtensionContext): Presenter | undefined {
  const key = sessionKey(ctx)
  return key === null ? undefined : presenters.get(key)
}

function hasForeignLive(presenter: Presenter, port: object): boolean {
  if (presenter.visible !== null && presenter.visible.port !== port) return true
  if (presenter.waiting.some((slot) => slot.port !== port)) return true
  if (presenter.hidden.some((slot) => slot.port !== port)) return true
  for (const key of presenter.statuses.keys()) if (key !== port) return true
  return false
}

export function adoptWriter(presenter: Presenter, ctx: ExtensionContext, port: object): void {
  if (ctx.ui == null || presenter.ui === ctx.ui || hasForeignLive(presenter, port)) return
  writeStatus(presenter.ui, undefined)
  presenter.ui = ctx.ui
  publishStatus(presenter)
}

export function here(origin: FramingOrigin, ctx: ExtensionContext): boolean {
  return sameSession(origin, ctx) && sameLocation(origin, ctx)
}

function publishStatus(presenter: Presenter): void {
  let best: StatusEntry | null = null
  for (const entry of presenter.statuses.values()) {
    if (best === null || entry.generation > best.generation) best = entry
  }
  writeStatus(presenter.ui, best === null ? undefined : statusText(best))
}

export function setPortStatus(
  presenter: Presenter,
  port: object,
  origin: FramingOrigin,
  phase: FeedbackPhase,
  subject?: string,
): void {
  let entry = presenter.statuses.get(port)
  const changed = entry?.phase !== phase
  if (entry === undefined) {
    entry = { generation: ++presenter.nextGeneration, origin, phase, subject: subject ?? null }
    presenter.statuses.set(port, entry)
  } else {
    entry.phase = phase
    if (subject !== undefined) entry.subject = subject
  }
  publishStatus(presenter)
  if (changed) {
    const receipt = phase === 'preparing' ? 'Commande reçue. ' : ''
    notifyUi(presenter.ui, `${receipt}${feedbackText(entry)}`, 'info')
  }
}

/** Cancelling the capability cannot roll back an action already awaiting its external result. */
export function stopPortStatus(presenter: Presenter, port: object): boolean {
  const entry = presenter.statuses.get(port)
  if (entry?.phase !== 'applying' && entry?.phase !== 'applying-after-stop') return false
  if (entry.phase === 'applying') {
    entry.phase = 'applying-after-stop'
    publishStatus(presenter)
  }
  return true
}

export function clearPortStatus(presenter: Presenter, port: object): void {
  if (!presenter.statuses.delete(port)) return
  publishStatus(presenter)
}

function promote(presenter: Presenter): void {
  if (presenter.visible !== null) return
  const next = presenter.waiting.shift()
  if (next === undefined) return
  presenter.visible = next
  next.state = 'visible'
  next.grant()
}

export function drop(list: Slot[], slot: Slot): void {
  const index = list.indexOf(slot)
  if (index >= 0) list.splice(index, 1)
}

export function retire(presenter: Presenter, slot: Slot): void {
  if (slot.state === 'done') return
  const wasVisible = presenter.visible === slot
  drop(presenter.waiting, slot)
  drop(presenter.hidden, slot)
  if (wasVisible) presenter.visible = null
  slot.state = 'done'
  if (presenter.visible === null) promote(presenter)
}

export function hide(presenter: Presenter, slot: Slot): void {
  if (presenter.visible === slot) presenter.visible = null
  if (!presenter.hidden.includes(slot)) presenter.hidden.push(slot)
  slot.state = 'hidden'
  setPortStatus(presenter, slot.port, slot.origin, 'held')
  promote(presenter)
}

function arm(slot: Slot): void {
  const gate = Promise.withResolvers<void>()
  slot.reopened = gate.promise
  slot.reopen = () => gate.resolve()
}

export function createSlot(port: object, origin: FramingOrigin, signal: AbortSignal): Slot {
  const gate = Promise.withResolvers<void>()
  const slot: Slot = {
    port,
    origin,
    signal,
    state: 'waiting',
    grant: () => gate.resolve(),
    granted: gate.promise,
    reopen: () => undefined,
    reopened: Promise.resolve(),
    armReopen() {
      arm(slot)
    },
  }
  arm(slot)
  return slot
}

export function enqueue(presenter: Presenter, slot: Slot): void {
  if (presenter.visible === null) {
    presenter.visible = slot
    slot.state = 'visible'
    slot.grant()
    return
  }
  presenter.waiting.push(slot)
  slot.state = 'waiting'
  setPortStatus(presenter, slot.port, slot.origin, 'queued')
}

export function latestMatching(slots: readonly Slot[], ctx: ExtensionContext, state: SlotState): Slot | null {
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const slot = slots[index]
    if (slot !== undefined && slot.state === state && here(slot.origin, ctx)) return slot
  }
  return null
}

export function knownRequest(presenter: Presenter): boolean {
  return (
    presenter.visible !== null ||
    presenter.waiting.length > 0 ||
    presenter.hidden.length > 0 ||
    presenter.statuses.size > 0
  )
}
