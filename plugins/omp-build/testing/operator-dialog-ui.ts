import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { OperatorChoice } from '../omp/omp-operator-confirmation-dialog.ts'

/** Default host keybindings used by the custom UI test seam. */
export const operatorDialogKeybindings = {
  matches(data: string, id: string): boolean {
    const bindings: Record<string, string[]> = {
      'tui.select.cancel': ['\u001b', '\u0003'],
      'tui.select.confirm': ['\r', '\n'],
      'tui.input.tab': ['\t'],
      'tui.editor.cursorLeft': ['\u001b[D'],
      'tui.editor.cursorRight': ['\u001b[C'],
      'tui.select.up': ['\u001b[A'],
      'tui.select.down': ['\u001b[B'],
      'tui.select.pageUp': ['\u001b[5~'],
      'tui.select.pageDown': ['\u001b[6~'],
    }
    return bindings[id]?.includes(data) ?? false
  },
}

/** Mount the real dialog and send its normal keyboard input. */
export function operatorDialogUi(
  decide: () => Promise<OperatorChoice>,
  onDisplay?: (text: string) => void,
): ExtensionContext['ui'] {
  const custom = async (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
    const result = Promise.withResolvers<unknown>()
    const terminal = { rows: 18, columns: 80 }
    const tui = { terminal, requestRender: () => undefined }
    const component = await factory(tui as never, {} as never, operatorDialogKeybindings as never, result.resolve)
    const display: string[] = []
    for (let i = 0; i < 2000; i++) {
      const lines = component.render(80)
      const rendered = lines.join('\n')
      if (display.at(-1) === rendered) break
      display.push(rendered)
      component.handleInput?.('\u001b[B')
    }
    onDisplay?.(display.join('\n'))
    const choice = await decide()
    component.handleInput?.(choice === 'confirm' ? 'c' : choice === 'refuse' ? 'r' : '\u001b')
    return result.promise
  }
  return { custom } as unknown as ExtensionContext['ui']
}
