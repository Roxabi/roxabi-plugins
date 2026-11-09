import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import type { PreparedOperatorProposal } from '../../roxabi/uw-contract.ts'
import { operatorDialogKeybindings } from '../../testing/operator-dialog-ui.ts'
import { type OperatorChoice, showOperatorProposal } from '../omp-operator-confirmation-dialog.ts'
import { proposalSummary } from '../omp-operator-confirmation-summary.ts'

const proposal = {
  digest: 'digest-1',
  proposal: {
    format: 'omp-build-uw-proposal/1',
    operationId: 'op-1',
    operation: 'create',
    title: 'A useful title',
    target: { kind: 'create', repository: 'acme/app' },
  },
} as unknown as PreparedOperatorProposal

type View = { render(width: number): readonly string[]; handleInput?(input: string): void }
function mount() {
  let view!: View
  const terminal = { columns: 80, rows: 18 }
  const result = Promise.withResolvers<OperatorChoice>()
  const ui = {
    custom: (
      factory: (tui: unknown, theme: unknown, keys: unknown, done: (choice: OperatorChoice) => void) => View,
    ) => {
      view = factory({ terminal, requestRender() {} }, {}, operatorDialogKeybindings, result.resolve)
      return result.promise
    },
  }
  const controller = new AbortController()
  const choice = showOperatorProposal(
    { ui } as unknown as ExtensionContext,
    proposal,
    'local://exact',
    controller.signal,
  )
  return { view, terminal, choice }
}

describe('operator dialog input and viewport', () => {
  it('presents framing titles, criteria and concrete effects without internal machinery', () => {
    const framing = {
      digest: 'digest',
      proposal: {
        format: 'omp-build-uw-framing/1',
        operationId: 'internal-operation',
        input: {
          members: [
            {
              kind: 'uw',
              slot: { kind: 'new', key: 'internal-slot', repository: 'acme/app' },
              title: 'Protect audit history',
              labels: { add: ['audit'], remove: [] },
              draft: {
                criteria: [{ kind: 'new', draftKey: 'draft', statement: 'Keep each change traceable' }],
                invariants: [],
                exclusions: [],
                openQuestions: [],
                sections: { origin: '', context: '', change: '' },
              },
            },
          ],
          edges: [],
        },
        members: [
          {
            key: 'internal-slot',
            tier: 'F-lite',
            allocation: {
              retirements: ['C7'],
              assignments: [{ draftKey: 'draft', id: 'C8' }],
              spec: { criteria: [{ id: 'C8', statement: 'Keep each change traceable' }], invariants: [] },
            },
            nativeAnalysis: {
              analysis: { criterionSources: [{ id: 'C7', statement: 'Old audit rule' }], invariantSources: [] },
            },
          },
        ],
      },
    } as unknown as PreparedOperatorProposal
    const text = proposalSummary(framing).join('\n')
    expect(text).toContain('Protect audit history')
    expect(text).toContain('Keep each change traceable')
    expect(text).toContain('acme/app')
    expect(text).toContain('audit')
    expect(text).toContain('C7')
    expect(text).toContain('Old audit rule')
    expect(text).toContain('C8')
    expect(text).not.toContain('internal-operation')
    expect(text).not.toContain('internal-slot')
  })

  it('keeps all actions visible at normal, narrow and resized heights', async () => {
    const mounted = mount()
    for (const [width, rows] of [
      [80, 18],
      [40, 12],
      [40, 8],
    ] as const) {
      mounted.terminal.columns = width
      mounted.terminal.rows = rows
      const lines = mounted.view.render(width)
      expect(lines.length).toBeLessThanOrEqual(rows)
      const text = lines.join('\n')
      expect(text).toContain('[C] Confirmer')
      expect(text).toContain('[R] Refuser')
      expect(text).toContain('[Esc] Plus tard')
      expect(text).toContain('[D] Détails')
    }
    mounted.view.handleInput?.('\u001b')
    await expect(mounted.choice).resolves.toBe('defer')
  })

  it('starts on defer, ignores pre-render and pasted input, and never implicitly confirms', async () => {
    const mounted = mount()
    mounted.view.handleInput?.('c')
    mounted.view.render(80)
    mounted.view.handleInput?.('\u001b[200~c\u001b[201~')
    mounted.view.handleInput?.('\r')
    await expect(mounted.choice).resolves.toBe('defer')
  })

  it('separates captured exact details from the human summary', async () => {
    const mounted = mount()
    const summary = mounted.view.render(80).join('\n')
    expect(summary).toContain('A useful title')
    expect(summary).not.toContain('"operationId"')
    mounted.view.handleInput?.('d')
    const details = mounted.view.render(80).join('\n')
    expect(details).toContain('local://exact')
    expect(details).toContain('"operationId"')
    expect(details).toContain('[C] Confirmer')
    mounted.view.handleInput?.('r')
    await expect(mounted.choice).resolves.toBe('refuse')
  })

  it('prevents acceptance in an impossible viewport even after resizing', async () => {
    const mounted = mount()
    mounted.view.render(80)
    mounted.terminal.rows = 2
    mounted.view.handleInput?.('c')
    mounted.view.render(80)
    mounted.view.handleInput?.('c')
    mounted.view.handleInput?.('\u001b')
    await expect(mounted.choice).resolves.toBe('defer')
  })
})
