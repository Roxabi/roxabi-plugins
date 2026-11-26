import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { KeyEvent } from '@oh-my-pi/pi-tui'
import { bubbleEvent, bubbleKey, bubblePaste, keypathOf } from '@oh-my-pi/pi-tui/dispatch'
import { InputDecoder } from '@oh-my-pi/pi-tui/driver/input/decoder'
import { Reconciler } from '@oh-my-pi/pi-tui/native/reconcile'
import { isUiNode, type UiNode } from '@oh-my-pi/pi-tui/node'
import { computed, signal } from '@oh-my-pi/pi-tui/reactive'
import { createSurface } from '@oh-my-pi/pi-tui/surface'
import type { PageProps } from '@oh-my-pi/pi-tui/types'
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
  matches(key: KeyEvent, id: string): boolean {
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
    return bindings[id]?.includes(key.raw) ?? false
  },
}

export function dialogInputReader(view: UiNode): (data: string) => boolean {
  const path = [view]
  let handled = true
  const decoder = new InputDecoder({
    input(event) {
      if (event.type === 'key') handled = bubbleKey(path, event.key) && handled
      if (event.type === 'paste') handled = bubblePaste(path, event.paste) && handled
    },
    reply() {},
  })
  return (data) => {
    handled = true
    decoder.process(data)
    // Advance past the ambiguity timeout only for a standalone Escape, not an incomplete paste.
    if (data === '\u001b' && !decoder.inPaste) decoder.flush()
    return handled
  }
}

/** Reconcile against Tern's independent width signal without starting a terminal transport. */
export function nativeDialogFrames(page: UiNode, terminal: { columns: number; rows: number }) {
  const columns = signal(terminal.columns)
  const surface = createSurface(() => {
    const parts = computed(() => nativePageParts(page))
    return { main: () => parts().main, dock: () => parts().dock }
  })
  const reconciler = new Reconciler(
    surface,
    'test',
    { cols: columns, rows: () => terminal.rows, hasFeature: () => false },
    () => {},
  )
  surface.focus(page)
  return {
    columns,
    present: () => reconciler.reconcile(),
    dispose() {
      reconciler.dispose()
      surface.dispose()
    },
  }
}

function nativeActions(node: UiNode, ancestors: readonly UiNode[]): { node: UiNode; act: string; path: UiNode[] }[] {
  const props = node.props()
  if (props.hidden) return []
  const path = [...ancestors, node]
  const unavailable = ('disabled' in props && props.disabled) || ('busy' in props && props.busy)
  const act = props.actions?.click
  return [
    ...(act && !unavailable ? [{ node, act, path }] : []),
    ...node.children().flatMap((child) => nativeActions(child, path)),
  ]
}

function nativePageParts(root: UiNode) {
  const props = root.props() as { page?: PageProps; hidden?: boolean }
  if (root.kind !== 'overlay' || !props.page || props.hidden) throw new Error('Expected a visible fullscreen page')
  // NativeSurfaces splits the overlay's children into the page main and its trailing dock.
  const children = root.children()
  const dockAt = Math.max(0, children.length - (props.page.dock ?? 0))
  return { main: children.slice(0, dockAt), dock: children.slice(dockAt) }
}

export function renderNativePage(root: UiNode) {
  const { main, dock } = nativePageParts(root)
  const actions = dock.flatMap((child) => nativeActions(child, [root]))
  return {
    main: main.map(nativeText).join('\n'),
    actions,
    click(act: string): boolean {
      const target = actions.find((candidate) => candidate.act === act)
      if (!target) return false
      return bubbleEvent(target.path, { type: 'action', key: keypathOf(target.path), act, mods: [] })
    },
  }
}

function nativeText(node: UiNode | undefined): string {
  if (!node) return ''
  const props = node.props()
  return ['text' in props && typeof props.text === 'string' ? props.text : '', ...node.children().map(nativeText)].join(
    '\n',
  )
}

type CustomFactory = Parameters<ExtensionContext['ui']['custom']>[0]
type CustomOptions = Parameters<ExtensionContext['ui']['custom']>[1]

function mountTerminalDialog(
  factory: CustomFactory,
  options: CustomOptions,
  terminal: { columns: number; rows: number },
) {
  const result = Promise.withResolvers<unknown>()
  const signal = options?.signal
  const reject = (reason: unknown) => finish(() => result.reject(reason))
  const abort = () => reject(signal?.reason)
  const finish = (settle: () => void) => {
    if (canvas.disposed) return
    signal?.removeEventListener('abort', abort)
    canvas.dispose()
    settle()
  }
  const output = factory(
    { size: () => terminal, requestRender() {}, suspend: (run) => run() },
    {} as never,
    operatorDialogKeybindings as never,
    (value) => finish(() => result.resolve(value)),
  )
  if (!isUiNode(output) || output.kind !== 'canvas') throw new Error('Expected a terminal confirmation canvas')
  const canvas = output as UiNode<'canvas'>
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const read = dialogInputReader(canvas)
  const view: MountedOperatorDialog = {
    render: (width) => canvas.props().paint(width),
    handleInput: (data) => !canvas.disposed && read(data),
  }
  return { view, result: result.promise, reject }
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
  const custom = async (factory: CustomFactory, options: CustomOptions) => {
    const terminal = { rows: 18, columns: 80 }
    const { view: mounted, result, reject } = mountTerminalDialog(factory, options, terminal)
    if (onDisplay) onDisplay(readDialog(mounted, terminal.columns))
    else mounted.render(terminal.columns)
    if (onDetails) {
      mounted.handleInput?.('d')
      onDetails(readDialog(mounted, terminal.columns))
      mounted.handleInput?.('d')
      mounted.render(terminal.columns)
    }
    void Promise.try(decide)
      .then((choice) => {
        mounted.handleInput?.(choice === 'confirm' ? 'c' : choice === 'refuse' ? 'r' : '\u001b')
      })
      .catch(reject)
    return result
  }
  return { custom } as unknown as ExtensionContext['ui']
}

export type MountedOperatorDialog = {
  render(width: number): readonly string[]
  handleInput?(input: string): void
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
  const custom = async (factory: CustomFactory, options: CustomOptions) => {
    const { view: mounted, result } = mountTerminalDialog(factory, options, { rows: 18, columns: 80 })
    mounted.render(80)
    views.push(mounted)
    const waiter = waiters.shift()
    if (waiter) waiter(mounted)
    return result
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
