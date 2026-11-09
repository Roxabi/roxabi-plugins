import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'

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

export function operatorDialogInput(data: string, keys: Bindings): DialogInput {
  if (data.startsWith('\u001b[200~')) return 'none'
  if (keys.matches(data, 'tui.select.cancel')) return 'cancel'
  if (Object.hasOwn(shortcuts, data)) return shortcuts[data] ?? 'none'
  for (const [binding, action] of bindings) {
    if (keys.matches(data, binding)) return action
  }
  return 'none'
}
