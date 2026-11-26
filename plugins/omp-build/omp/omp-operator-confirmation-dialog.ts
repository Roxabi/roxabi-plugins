import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { KeyEvent } from '@oh-my-pi/pi-tui'
import { jsx } from '@oh-my-pi/pi-tui/element'
import { nativeRendering, nativeSupports } from '@oh-my-pi/pi-tui/host'
import { computed, onCleanup, signal as revisionSignal, structural } from '@oh-my-pi/pi-tui/reactive'
import type { PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { nativeText } from './omp-operator-confirmation-field.ts'
import { framingDetails } from './omp-operator-confirmation-framing.ts'
import {
  type ConfirmationMotion,
  commitDialogInput,
  type DialogInput,
  type OperatorChoice,
  operatorDialogInput,
} from './omp-operator-confirmation-input.ts'
import { operatorDialogLayout } from './omp-operator-confirmation-layout.ts'
import { proposalSummary } from './omp-operator-confirmation-summary.ts'

type NativeChoice = OperatorChoice | 'details'

function nativeButton(
  label: string | (() => string),
  act: NativeChoice,
  key: string,
  choose: (act: NativeChoice) => void,
) {
  const shared = {
    title: () => `${typeof label === 'function' ? label() : label}  ${key === 'escape' ? 'esc' : key}`,
    actions: { click: act },
    onAction: (action: string) => {
      if (action === act) choose(act)
    },
  }
  if (nativeSupports('button')) {
    return jsx(
      'button',
      {
        ...shared,
        role: 'omp.btn',
        text: label,
        keys: [key],
        ...(act === 'confirm' ? { tone: 'accent', variant: 'primary' } : {}),
        ...(act === 'refuse' ? { tone: 'error', variant: 'danger' } : {}),
      },
      act,
    )
  }
  return jsx(
    'row',
    {
      ...shared,
      role: 'omp.btn',
      gap: 'xs',
      align: 'center',
      children: [jsx('text', { text: label }), jsx('kbd', { keys: [key] })],
    },
    act,
  )
}

export async function showOperatorProposal(
  ctx: ExtensionContext,
  prepared: PreparedOperatorProposal,
  detailRef: string,
  signal: AbortSignal,
): Promise<OperatorChoice> {
  if (signal.aborted) throw new Error('Confirmation cancelled')
  const summary = proposalSummary(prepared)
  const proposal = prepared.proposal
  const details = ['Détails techniques', `Référence : ${detailRef}`, `Digest : ${prepared.digest}`]
  if (proposal.format === 'omp-build-uw-framing/1')
    details.push(...framingDetails(proposal), '', 'Proposition exacte (JSON)')
  details.push(JSON.stringify(proposal, null, 2))
  return ctx.ui.custom<OperatorChoice>(
    (ui, _theme, keys, done) => {
      const motion: ConfirmationMotion = {
        selected: 2,
        offset: 0,
        maxOffset: 0,
        height: 0,
        technical: false,
        scroll: undefined,
      }
      const revision = revisionSignal(0)
      const technical = computed(() => {
        revision()
        return motion.technical
      })
      const selected = (index: number, label: string) => () => {
        revision()
        return `${motion.selected === index ? '› ' : ''}${label}`
      }
      const body = summary.slice(1)
      let closed = false
      let pasted = false
      let renderedColumns: number | undefined
      let nativeRenderedColumns: number | undefined
      let actionable = false
      const finish = (choice: OperatorChoice) => {
        closed = true
        done(choice)
      }
      const ready = (native: boolean) => {
        const { columns, rows } = ui.size()
        if ((native ? nativeRenderedColumns : renderedColumns) !== columns) return false
        if (!native) return actionable && motion.height === rows
        motion.height = rows
        return operatorDialogLayout(columns, rows, motion.selected, 0, []).actionable
      }
      const input = (action: DialogInput, native: boolean) => {
        if (closed || signal.aborted || action === 'none') return
        if (action === 'cancel') finish('defer')
        else if (ready(native) && commitDialogInput(motion, action, finish)) revision.update((n) => n + 1)
      }
      const onKey = (key: KeyEvent) => {
        const action = operatorDialogInput(key, keys)
        // The decoder only marks the first key in the paste read; require an explicit other action to rearm.
        if (pasted && (action === 'confirm' || action === 'select')) return true
        if (action !== 'none') pasted = false
        input(action, nativeRendering())
        return true
      }
      const onPaste = () => {
        pasted = true
        return true
      }
      const onNativeAction = (action: NativeChoice) => {
        if (nativeRendering()) input(action === 'defer' ? 'cancel' : action, true)
      }
      const ansi = jsx('canvas', {
        onKey,
        onPaste,
        paint(columns: number) {
          revision()
          const { rows } = ui.size()
          renderedColumns = columns
          motion.height = rows
          const layout = operatorDialogLayout(
            columns,
            rows,
            motion.selected,
            motion.offset,
            technical() ? details : body,
          )
          actionable = layout.actionable
          motion.offset = layout.offset
          motion.maxOffset = layout.maxOffset
          return layout.lines
        },
      })
      if (!nativeRendering()) return ansi
      const content = jsx(
        'col',
        {
          role: 'omp.operator.confirmation.body',
          scroll: () => {
            if (!nativeRendering()) return undefined
            revision()
            return motion.scroll
          },
          children: () =>
            nativeRendering()
              ? (technical() ? details : body)
                  .flatMap((line) => line.split('\n'))
                  .map((line, index) => jsx('text', { text: nativeText(line), wrap: 'word' }, String(index)))
              : [ansi],
        },
        'body',
      )
      const title = nativeText(summary[0] ?? '')
      const dock = jsx(
        'col',
        {
          role: 'omp.editor.ask.confirmation',
          gap: 'sm',
          children: [
            jsx('text', { text: title, tone: 'accent', wrap: 'word' }, 'title'),
            jsx(
              'row',
              {
                role: 'omp.actions',
                gap: 'sm',
                align: 'center',
                wrap: true,
                children: [
                  nativeButton(selected(0, 'Confirmer'), 'confirm', 'c', onNativeAction),
                  nativeButton(selected(1, 'Refuser'), 'refuse', 'r', onNativeAction),
                  nativeButton(selected(2, 'Plus tard'), 'defer', 'escape', onNativeAction),
                  nativeButton('Détails', 'details', 'd', onNativeAction),
                ],
              },
              'actions',
            ),
          ],
        },
        'dock',
      )
      const viewportGeneration = revisionSignal(0)
      const viewport = structural(() => {
        const generation = viewportGeneration()
        let width: number | undefined
        return jsx(
          'canvas',
          {
            hidden: true,
            paint(columns: number) {
              if (generation !== viewportGeneration.peek()) return []
              if (width !== undefined && width !== columns) {
                // The old record repaints eagerly on resize. Only a new keyed record is
                // first painted as part of reconciliation and necessarily emits an add op.
                nativeRenderedColumns = undefined
                viewportGeneration.set(generation + 1)
              } else {
                width = columns
                nativeRenderedColumns = columns
                onCleanup(() => {
                  if (generation === viewportGeneration.peek()) nativeRenderedColumns = undefined
                })
              }
              return []
            },
          },
          `viewport-${generation}`,
        )
      })
      // The host must see the page node itself to dock the actions and route focus inside it.
      return jsx('overlay', {
        size: 'full',
        role: 'omp.sheet.bare',
        page: { role: 'omp.operator.confirmation', dock: 1 },
        onKey,
        onPaste,
        // Keep the focused body mounted when the optimistic Tern handshake falls back.
        children: () => (nativeRendering() ? [content, viewport(), dock] : [content]),
      })
    },
    { overlay: true, fullscreen: true, signal },
  )
}
