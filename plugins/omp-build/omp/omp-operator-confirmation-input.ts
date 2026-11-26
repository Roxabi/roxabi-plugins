import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { KeyEvent } from '@oh-my-pi/pi-tui'

export type OperatorChoice = 'confirm' | 'refuse' | 'defer'

type Bindings = Parameters<Parameters<ExtensionContext['ui']['custom']>[0]>[2]
export type DialogInput =
  | 'cancel'
  | 'confirm'
  | 'refuse'
  | 'details'
  | 'next'
  | 'previous'
  | 'select'
  | 'up'
  | 'down'
  | 'pageUp'
  | 'pageDown'
  | 'none'
const shortcuts: Record<string, DialogInput> = {
  c: 'confirm',
  C: 'confirm',
  r: 'refuse',
  R: 'refuse',
  d: 'details',
  D: 'details',
}
const bindings: ReadonlyArray<readonly [Parameters<Bindings['matches']>[1], DialogInput]> = [
  ['tui.input.tab', 'next'],
  ['tui.editor.cursorRight', 'next'],
  ['tui.editor.cursorLeft', 'previous'],
  ['tui.select.confirm', 'select'],
  ['tui.select.up', 'up'],
  ['tui.select.down', 'down'],
  ['tui.select.pageUp', 'pageUp'],
  ['tui.select.pageDown', 'pageDown'],
]

export function operatorDialogInput(key: KeyEvent, keys: Bindings): DialogInput {
  if (key.kind === 'release') return 'none'
  if (keys.matches(key, 'tui.select.cancel')) return 'cancel'
  if (key.afterPaste) return 'none'
  if (key.text && Object.hasOwn(shortcuts, key.text)) return shortcuts[key.text] ?? 'none'
  for (const [binding, action] of bindings) {
    if (keys.matches(key, binding)) return action
  }
  return 'none'
}

type ConfirmationScroll = { by: 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'start'; n: number }
export type ConfirmationMotion = {
  selected: number
  offset: number
  maxOffset: number
  height: number
  technical: boolean
  scroll: ConfirmationScroll | undefined
}

function resetDetails(state: ConfirmationMotion): void {
  state.technical = !state.technical
  state.offset = 0
  state.scroll = { by: 'start', n: (state.scroll?.n ?? 0) + 1 }
}

function bumpScroll(
  state: ConfirmationMotion,
  by: 'line-up' | 'line-down' | 'page-up' | 'page-down',
  delta: number,
): void {
  state.offset = Math.min(state.maxOffset, Math.max(0, state.offset + delta))
  state.scroll = { by, n: (state.scroll?.n ?? 0) + 1 }
}

function applyDialogInput(state: ConfirmationMotion, input: DialogInput): OperatorChoice | undefined {
  const page = Math.max(1, state.height - 4)
  switch (input) {
    case 'confirm':
    case 'refuse':
      return input
    case 'select':
      return state.selected === 1 ? 'refuse' : state.selected === 0 ? 'confirm' : 'defer'
    case 'next':
      state.selected = (state.selected + 1) % 3
      return undefined
    case 'previous':
      state.selected = (state.selected + 2) % 3
      return undefined
    case 'details':
      resetDetails(state)
      return undefined
    case 'up':
      bumpScroll(state, 'line-up', -1)
      return undefined
    case 'down':
      bumpScroll(state, 'line-down', 1)
      return undefined
    case 'pageUp':
      bumpScroll(state, 'page-up', -page)
      return undefined
    case 'pageDown':
      bumpScroll(state, 'page-down', page)
      return undefined
    default:
      return undefined
  }
}

export function commitDialogInput(
  state: ConfirmationMotion,
  input: DialogInput,
  finish: (choice: OperatorChoice) => void,
): boolean {
  const choice = applyDialogInput(state, input)
  if (choice) finish(choice)
  return choice === undefined
}
