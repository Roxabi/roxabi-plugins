import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { OperatorChoice } from '../omp/omp-operator-confirmation-input.ts'

/** One fictional root identity with the stable live mappings required by the real confirmation port. */
export function operatorRootContext(cwd: string, protocol: { getArtifactsDir(): string }) {
  const artifactsDir = protocol.getArtifactsDir()
  return {
    agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 } as const,
    cwd,
    sessionManager: {
      getSessionId: () => `${cwd}:${artifactsDir}`,
      getCwd: () => cwd,
      getSessionFile: () => undefined,
      getArtifactsDir: () => artifactsDir,
    },
    localProtocolOptions: { getArtifactsDir: () => artifactsDir },
  }
}

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

function readDialog(view: MountedOperatorDialog, width: number): string {
  const display: string[] = []
  for (let i = 0; i < 2000; i++) {
    const rendered = view.render(width).join('\n')
    if (display.at(-1) === rendered) break
    display.push(rendered)
    view.handleInput?.('\u001b[B')
  }
  return display.join('\n')
}

/** Mount the real dialog and send its normal keyboard input. */
export function operatorDialogUi(
  decide: () => Promise<OperatorChoice>,
  onDisplay?: (text: string) => void,
  onDetails?: (text: string) => void,
): ExtensionContext['ui'] {
  const custom = async (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
    const result = Promise.withResolvers<unknown>()
    const terminal = { rows: 18, columns: 80 }
    const tui = { terminal, requestRender: () => undefined }
    let mounted: MountedOperatorDialog | undefined
    const finish = (value: unknown) => {
      mounted?.dispose?.()
      result.resolve(value)
    }
    mounted = await factory(tui as never, {} as never, operatorDialogKeybindings as never, finish)
    if (onDisplay) onDisplay(readDialog(mounted, terminal.columns))
    else mounted.render(terminal.columns)
    if (onDetails) {
      mounted.handleInput?.('d')
      onDetails(readDialog(mounted, terminal.columns))
      mounted.handleInput?.('d')
      mounted.render(terminal.columns)
    }
    const choice = await decide()
    mounted.handleInput?.(choice === 'confirm' ? 'c' : choice === 'refuse' ? 'r' : '\u001b')
    return result.promise
  }
  return { custom } as unknown as ExtensionContext['ui']
}

export type MountedOperatorDialog = {
  render(width: number): readonly string[]
  handleInput?(input: string): void
  dispose?(): void
}

/** Mount each real dialog and leave input to the test. No auto key, no viewport claim. */
export function manualOperatorDialog(): {
  ui: ExtensionContext['ui']
  views: MountedOperatorDialog[]
  nextMount(): Promise<MountedOperatorDialog>
} {
  const views: MountedOperatorDialog[] = []
  const waiters: Array<(view: MountedOperatorDialog) => void> = []
  let delivered = 0
  const custom = async (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
    const result = Promise.withResolvers<unknown>()
    const terminal = { rows: 18, columns: 80 }
    let mounted: MountedOperatorDialog | undefined
    const finish = (value: unknown) => {
      mounted?.dispose?.()
      result.resolve(value)
    }
    mounted = await factory(
      { terminal, requestRender: () => undefined } as never,
      {} as never,
      operatorDialogKeybindings as never,
      finish,
    )
    mounted.render(80)
    views.push(mounted)
    const waiter = waiters.shift()
    if (waiter) waiter(mounted)
    return result.promise
  }
  return {
    ui: { custom } as unknown as ExtensionContext['ui'],
    views,
    nextMount() {
      const existing = views[delivered]
      if (existing) {
        delivered += 1
        return Promise.resolve(existing)
      }
      const pending = Promise.withResolvers<MountedOperatorDialog>()
      waiters.push((view) => {
        delivered += 1
        pending.resolve(view)
      })
      return pending.promise
    },
  }
}
