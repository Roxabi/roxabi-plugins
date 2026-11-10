import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { type FramingOrigin, sameLocation, sameSession } from '../roxabi/feature-framing-controller-lease.ts'

const STATUS_KEY = 'omp-build-operator'
const QUEUED_STATUS = 'Confirmation waiting'
const HELD_STATUS = 'Confirmation held — Ctrl+Alt+U to reopen'

type SlotState = 'waiting' | 'visible' | 'hidden' | 'done'
type StatusEntry = { generation: number; text: string }
type Ui = ExtensionContext['ui']

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
  preparing: Map<object, FramingOrigin>
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
      preparing: new Map(),
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
  for (const key of presenter.preparing.keys()) if (key !== port) return true
  for (const key of presenter.statuses.keys()) if (key !== port) return true
  return false
}

export function adoptWriter(presenter: Presenter, ctx: ExtensionContext, port: object): void {
  if (ctx.ui == null || presenter.ui === ctx.ui || hasForeignLive(presenter, port)) return
  presenter.ui.setStatus?.(STATUS_KEY, undefined)
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
  presenter.ui.setStatus?.(STATUS_KEY, best === null ? undefined : best.text)
}

export function setPortStatus(presenter: Presenter, port: object, text: string): void {
  const existing = presenter.statuses.get(port)
  if (existing === undefined) presenter.statuses.set(port, { generation: ++presenter.nextGeneration, text })
  else existing.text = text
  publishStatus(presenter)
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
  setPortStatus(presenter, slot.port, HELD_STATUS)
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
  setPortStatus(presenter, slot.port, QUEUED_STATUS)
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
    presenter.preparing.size > 0
  )
}
