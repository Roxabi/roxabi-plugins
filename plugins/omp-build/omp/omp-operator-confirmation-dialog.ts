import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { operatorDialogInput } from './omp-operator-confirmation-input.ts'
import { operatorDialogLayout } from './omp-operator-confirmation-layout.ts'
import { proposalSummary } from './omp-operator-confirmation-summary.ts'

export type OperatorChoice = 'confirm' | 'refuse' | 'defer'

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
          let selected = 2
          let offset = 0
          let technical = false
          let width = 0
          let height = 0
          let terminalColumns = 0
          let maxOffset = 0
          let actionable = false
          const choices: OperatorChoice[] = ['confirm', 'refuse', 'defer']
          const redraw = () => tui.requestRender()
          abort = () => done('refuse')
          signal.addEventListener('abort', abort, { once: true })
          return {
            render(columns: number) {
              width = columns
              height = tui.terminal.rows
              terminalColumns = tui.terminal.columns
              const layout = operatorDialogLayout(
                width,
                height,
                selected,
                offset,
                technical ? details : summary.slice(1),
              )
              actionable = layout.actionable
              offset = layout.offset
              maxOffset = layout.maxOffset
              return layout.lines
            },
            handleInput(data: string) {
              if (signal.aborted) return
              const input = operatorDialogInput(data, keys)
              if (input === 'cancel') return done('defer')
              if (!actionable || terminalColumns !== tui.terminal.columns || height !== tui.terminal.rows) return
              switch (input) {
                case 'confirm':
                  return done('confirm')
                case 'refuse':
                  return done('refuse')
                case 'select':
                  return done(choices[selected] ?? 'defer')
                case 'details':
                  technical = !technical
                  offset = 0
                  break
                case 'next':
                  selected = (selected + 1) % 3
                  break
                case 'previous':
                  selected = (selected + 2) % 3
                  break
                case 'up':
                  offset = Math.max(0, offset - 1)
                  break
                case 'down':
                  offset = Math.min(maxOffset, offset + 1)
                  break
                case 'pageUp':
                  offset = Math.max(0, offset - Math.max(1, height - 4))
                  break
                case 'pageDown':
                  offset = Math.min(maxOffset, offset + Math.max(1, height - 4))
                  break
              }
              redraw()
            },
            invalidate() {},
            dispose() {
              if (abort) signal.removeEventListener('abort', abort)
            },
          }
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
