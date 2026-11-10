import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Component } from '@oh-my-pi/pi-tui'
import type { DescribeContext, NativeNode, NativeScreen, NativeUiEvent } from '@oh-my-pi/pi-tui/native/node'
import type { PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { nativeText } from './omp-operator-confirmation-field.ts'
import {
  type ConfirmationMotion,
  commitDialogInput,
  commitNativeAct,
  type OperatorChoice,
  operatorDialogInput,
  resetDetails,
} from './omp-operator-confirmation-input.ts'
import { operatorDialogLayout } from './omp-operator-confirmation-layout.ts'
import { proposalSummary } from './omp-operator-confirmation-summary.ts'

function nativeButton(label: string, act: string, key: string, buttons: boolean): NativeNode {
  const title = `${label}  ${key === 'escape' ? 'esc' : key}`
  if (buttons) {
    // The locked 18.13 SDK predates the button kind; this is the 18.18 actionButton shape.
    return {
      k: 'button',
      key: act,
      p: {
        role: 'omp.btn',
        text: label,
        title,
        keys: [key],
        actions: { click: act },
        ...(act === 'confirm' ? { tone: 'accent', variant: 'primary' } : {}),
        ...(act === 'refuse' ? { tone: 'error', variant: 'danger' } : {}),
      },
    } as unknown as NativeNode
  }
  return {
    k: 'row',
    key: act,
    p: {
      role: 'omp.btn',
      gap: 'xs',
      align: 'center',
      title,
      actions: { click: act },
    },
    c: [
      { k: 'text', p: { text: label } },
      { k: 'kbd', p: { keys: [key] } },
    ],
  }
}

export async function showOperatorProposal(
  ctx: ExtensionContext,
  prepared: PreparedOperatorProposal,
  detailRef: string,
  signal: AbortSignal,
): Promise<OperatorChoice> {
  if (signal.aborted) throw new Error('Confirmation cancelled')
  const summary = proposalSummary(prepared)
  const details = [
    'Détails techniques',
    `Référence : ${detailRef}`,
    `Digest : ${prepared.digest}`,
    JSON.stringify(prepared.proposal, null, 2),
  ]
  let abort: (() => void) | undefined
  const cancelled = Promise.withResolvers<never>()
  const rejectOnAbort = () => cancelled.reject(new Error('Confirmation cancelled'))
  signal.addEventListener('abort', rejectOnAbort, { once: true })
  try {
    return await Promise.race([
      ctx.ui.custom<OperatorChoice>(
        (tui, _theme, keys, done) => {
          if (signal.aborted) throw new Error('Confirmation cancelled')
          const motion: ConfirmationMotion = {
            selected: 2,
            offset: 0,
            maxOffset: 0,
            height: 0,
            technical: false,
            scroll: undefined,
          }
          let width = 0
          let terminalColumns = 0
          let actionable = false
          let closed = false
          let nativeDescribed = false
          let nativeColumns = 0
          let nativeRows = 0
          let nativeReady = false
          const redraw = () => tui.requestRender()
          const finish = (choice: OperatorChoice, cancelling = false) => {
            if (closed || (signal.aborted && !cancelling)) return
            closed = true
            done(choice)
          }
          abort = () => finish('refuse', true)
          signal.addEventListener('abort', abort, { once: true })
          const nativeSizeReady = () => {
            if (nativeColumns !== tui.terminal.columns) return false
            if (nativeRows !== tui.terminal.rows) {
              nativeRows = tui.terminal.rows
              nativeReady = operatorDialogLayout(nativeColumns, nativeRows, motion.selected, 0, []).actionable
            }
            return nativeReady
          }
          const ready = () =>
            !closed &&
            !signal.aborted &&
            (nativeDescribed
              ? nativeSizeReady()
              : actionable && terminalColumns === tui.terminal.columns && motion.height === tui.terminal.rows)
          const toggleDetails = () => resetDetails(motion)
          const noteNative = (cx: DescribeContext) => {
            nativeDescribed = true
            nativeColumns = cx.cols
            nativeRows = tui.terminal.rows
            nativeReady =
              nativeColumns === tui.terminal.columns &&
              operatorDialogLayout(nativeColumns, nativeRows, motion.selected, 0, []).actionable
          }
          const component: Component = {
            render(columns: number) {
              nativeDescribed = false
              width = columns
              motion.height = tui.terminal.rows
              terminalColumns = tui.terminal.columns
              const layout = operatorDialogLayout(
                width,
                motion.height,
                motion.selected,
                motion.offset,
                motion.technical ? details : summary.slice(1),
              )
              actionable = layout.actionable
              motion.offset = layout.offset
              motion.maxOffset = layout.maxOffset
              return layout.lines
            },
            describeScreen(cx: DescribeContext): NativeScreen {
              noteNative(cx)
              const body = (motion.technical ? details : summary.slice(1)).flatMap((line) => line.split('\n'))
              const node: NativeNode = {
                k: 'col',
                key: 'body',
                p: { role: 'omp.operator.confirmation.body' },
                c: body.map((line, index) => ({
                  k: 'text',
                  key: String(index),
                  p: { text: nativeText(line), wrap: 'word' },
                })),
                ...(motion.scroll ? { scroll: motion.scroll } : {}),
              }
              return { role: 'omp.operator.confirmation', main: [node], dock: [component] }
            },
            describe(cx: DescribeContext): NativeNode {
              noteNative(cx)
              // The running SDK supports button; the older locked types do not name it.
              const buttons = (cx.supports as (kind: string) => boolean)('button')
              return {
                k: 'col',
                p: { role: 'omp.editor.ask.confirmation', gap: 'sm' },
                c: [
                  { k: 'text', key: 'title', p: { text: nativeText(summary[0] ?? ''), tone: 'accent', wrap: 'word' } },
                  {
                    k: 'row',
                    key: 'actions',
                    p: { role: 'omp.actions', gap: 'sm', align: 'center', wrap: true },
                    c: [
                      nativeButton(`${motion.selected === 0 ? '› ' : ''}Confirmer`, 'confirm', 'c', buttons),
                      nativeButton(`${motion.selected === 1 ? '› ' : ''}Refuser`, 'refuse', 'r', buttons),
                      nativeButton(`${motion.selected === 2 ? '› ' : ''}Plus tard`, 'defer', 'escape', buttons),
                      nativeButton('Détails', 'details', 'd', buttons),
                    ],
                  },
                ],
              }
            },
            handleNativeEvent(event: NativeUiEvent) {
              if (event.type !== 'action' || !nativeDescribed || closed || signal.aborted) return
              if (commitNativeAct(event.act, ready(), finish)) {
                toggleDetails()
                redraw()
              }
            },
            handleInput(data: string) {
              if (closed || signal.aborted) return
              const input = operatorDialogInput(data, keys)
              if (input === 'cancel') return finish('defer')
              if (ready() && commitDialogInput(motion, input, finish)) redraw()
            },
            invalidate() {},
            dispose() {
              closed = true
              if (abort) signal.removeEventListener('abort', abort)
            },
          }
          return component
        },
        { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0, fullscreen: true } },
      ),
      cancelled.promise,
    ])
  } finally {
    signal.removeEventListener('abort', rejectOnAbort)
    if (abort) signal.removeEventListener('abort', abort)
  }
}
