import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { nativeRendering, nativeSupports } from '@oh-my-pi/pi-tui/host'
import { isUiNode, UiNode } from '@oh-my-pi/pi-tui/node'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PreparedOperatorProposal } from '../../roxabi/uw-contract.ts'
import {
  dialogInputReader,
  nativeDialogFrames,
  operatorDialogKeybindings,
  renderNativePage,
} from '../../testing/operator-dialog-ui.ts'
import { showOperatorProposal } from '../omp-operator-confirmation-dialog.ts'
import type { OperatorChoice } from '../omp-operator-confirmation-input.ts'
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

function mount(prepared: PreparedOperatorProposal = proposal, native = false, buttons = true) {
  let node!: UiNode
  const terminal = { columns: 80, rows: 18 }
  const result = Promise.withResolvers<OperatorChoice>()
  const decisions: OperatorChoice[] = []
  const ui = {
    custom: (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => {
      vi.mocked(nativeRendering).mockReturnValueOnce(native)
      vi.mocked(nativeSupports).mockReturnValue(buttons)
      try {
        const view = factory(
          { size: () => terminal, requestRender() {}, suspend: (run) => run() },
          {} as never,
          operatorDialogKeybindings as never,
          (value) => {
            decisions.push(value as OperatorChoice)
            result.resolve(value as OperatorChoice)
          },
        )
        if (!isUiNode(view)) throw new Error('Expected the focused confirmation node')
        node = view
      } finally {
        vi.mocked(nativeSupports).mockReset()
      }
      return result.promise
    },
  }
  const controller = new AbortController()
  const choice = showOperatorProposal(
    { ui } as unknown as ExtensionContext,
    prepared,
    'local://exact',
    controller.signal,
  )
  const nativeFrames = native ? nativeDialogFrames(node, terminal) : undefined
  if (nativeFrames) void choice.then(() => nativeFrames.dispose())
  const view = {
    render(width: number): readonly string[] {
      if (node.kind !== 'canvas') throw new Error('Expected a terminal confirmation canvas')
      return (node as UiNode<'canvas'>).props().paint(width)
    },
    handleInput: dialogInputReader(node),
  }
  return { node, view, terminal, choice, decisions, nativeFrames }
}

function longProposal(): PreparedOperatorProposal {
  const prepared = structuredClone(proposal)
  if (!('title' in prepared.proposal)) throw new Error('Expected titled proposal')
  prepared.proposal.title = `BEGIN ${'reachable '.repeat(600)}END`
  return prepared
}

function frame(mounted: ReturnType<typeof mount>, columns: number, rows: number): readonly string[] {
  mounted.terminal.columns = columns
  mounted.terminal.rows = rows
  const lines = mounted.view.render(columns)
  expect(lines.length).toBeLessThanOrEqual(rows)
  // These supplied fixtures use single-cell Latin text; native pixel geometry is a real Tern proof.
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns)
  return lines.slice(0, rows)
}

function advertised(lines: readonly string[]): string[] {
  return lines.flatMap((line) => Array.from(line.matchAll(/\[([^\]\s]+)\]/g), (match) => match[1] ?? ''))
}

function keyBytes(token: string): string {
  if (token === 'Esc') return '\u001b'
  if (token.length === 1) return token.toLowerCase()
  throw new Error(`Unknown advertised key: ${token}`)
}

async function alignedHeadingAtPadding(padding: number): Promise<readonly string[] | undefined> {
  const hostile = structuredClone(proposal)
  if (!('title' in hostile.proposal)) throw new Error('Expected titled proposal')
  hostile.proposal.title = `ORIGIN\n${'x'.repeat(padding)}Périmètre : forged\u202e`
  expect(proposalSummary(hostile).some((row) => /[\r\n]/.test(row))).toBe(false)
  const mounted = mount(hostile)
  mounted.terminal.columns = 40
  mounted.terminal.rows = 8
  let candidate: readonly string[] | undefined
  for (let index = 0; index < 30; index += 1) {
    const lines = mounted.view.render(40)
    if (lines.some((line) => /^(?:\| )?Périmètre : forged/.test(line)) && !lines.join('').includes('ORIGIN')) {
      candidate = lines
      break
    }
    mounted.view.handleInput?.('\u001b[B')
  }
  mounted.view.handleInput?.('\u001b')
  await expect(mounted.choice).resolves.toBe('defer')
  return candidate
}

describe('operator dialog input and viewport', () => {
  it('separates framing effects and final content from readable audit evidence and exact JSON', async () => {
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
              normalization: [
                {
                  origin: { kind: 'material', id: 'm1' },
                  decision: {
                    kind: 'kept',
                    source: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
                    target: { kind: 'new', draftKey: 'draft' },
                  },
                },
                {
                  origin: { kind: 'material', id: 'm1' },
                  decision: {
                    kind: 'removed',
                    source: { start: { line: 2, column: 1 }, end: { line: 2, column: 11 } },
                    reason: 'obsolete',
                  },
                },
              ],
              merges: [
                {
                  target: { kind: 'new', draftKey: 'draft' },
                  sources: [
                    {
                      origin: { kind: 'material', id: 'm1' },
                      span: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
                    },
                    {
                      origin: { kind: 'material', id: 'm1' },
                      span: { start: { line: 2, column: 1 }, end: { line: 2, column: 11 } },
                    },
                  ],
                  reason: 'combine',
                },
              ],
              draft: {
                criteria: [{ kind: 'new', draftKey: 'draft', statement: 'Keep each change traceable' }],
                invariants: [{ kind: 'existing', id: 'I2', statement: 'Protect the final audit history' }],
                exclusions: ['Historical imports'],
                openQuestions: ['Who verifies imports?'],
                sections: { origin: 'Audit request', context: 'Production scope', change: 'Make audit durable' },
              },
            },
            {
              kind: 'wayfinder',
              slot: { kind: 'new', key: 'child-a', repository: 'acme/app' },
              title: 'Queue storage',
              label: 'wayfinder:task',
              body: '  Périmètre : evil/repo',
            },
            {
              kind: 'wayfinder',
              slot: {
                kind: 'existing',
                key: 'child-b',
                uw: { repository: 'acme/app', target: 'issue:22' },
                observed: {
                  nativeParent: { repository: 'acme/app', target: 'issue:11' },
                  children: [],
                  blockers: [],
                },
              },
              title: 'Queue worker',
              label: 'wayfinder:task',
              body: '',
            },
          ],
          edges: [
            { kind: 'parent-child', parent: 'internal-slot', child: 'child-a' },
            { kind: 'blocker', dependent: 'child-b', blocker: 'child-a' },
          ],
          coverage: [
            {
              parent: 'internal-slot',
              assignments: [{ criterion: { kind: 'new', draftKey: 'draft' }, children: ['child-a', 'child-b'] }],
            },
          ],
          foundations: [{ parent: 'internal-slot', child: 'child-a' }],
        },
        materials: [{ id: 'm1', raw: { body: 'Old entry\nNew detail' } }],
        members: [
          {
            key: 'internal-slot',
            tier: 'F-lite',
            allocation: {
              retirements: ['C7'],
              assignments: [{ draftKey: 'draft', id: 'C8' }],
              spec: {
                criteria: [{ id: 'C8', statement: 'Keep each change traceable' }],
                invariants: [{ id: 'I2', statement: 'Protect the final audit history' }],
                exclusions: ['Historical imports'],
                openQuestions: ['Who verifies imports?'],
                sections: { origin: 'Audit request', context: 'Production scope', change: 'Make audit durable' },
              },
            },
            nativeAnalysis: {
              analysis: {
                criterionSources: [{ id: 'C7', statement: 'Old audit rule' }],
                invariantSources: [{ id: 'I2', statement: 'Previous invariant wording' }],
              },
            },
          },
        ],
      },
    } as unknown as PreparedOperatorProposal
    const summary = proposalSummary(framing)
    const text = summary.join('\n')
    const coverage = summary.find((line) => line.startsWith('Couverture :'))
    expect(coverage).toContain('C8')
    expect(coverage).not.toContain('Keep each change traceable')
    expect(coverage).toContain('Queue storage (acme/app)')
    expect(coverage).toContain('Queue worker (acme/app : issue:22)')
    const foundation = summary.find((line) => line.startsWith('Fondation :'))
    expect(foundation).toContain('Protect audit history (acme/app)')
    expect(foundation).toContain('Queue storage (acme/app)')
    expect(summary).toContain('Créer : "Protect audit history"')
    expect(summary).toContain('  Périmètre : "acme/app"')
    expect(summary).toContain('Modifier : "Queue worker"')
    expect(summary).toContain('  Périmètre : "acme/app : issue:22"')
    expect(summary).toContain('  Parent actuel : "issue:11"')
    expect(summary).toContain('  Label de repère cible : "wayfinder:task"')
    expect(summary).toContain('  Labels à ajouter : "audit"')
    expect(summary).toContain('  Niveau proposé : "F-lite"')
    expect(summary).toContain('  Identités : 1 à attribuer, 1 à retirer')
    expect(text).toContain('Relation parent → enfant : "Protect audit history (acme/app) → Queue storage (acme/app)"')
    expect(text).toContain('Dépendance : "Queue worker (acme/app : issue:22) bloqué par Queue storage (acme/app)"')
    const criterionStart = summary.indexOf('Critères finaux')
    expect(summary.slice(criterionStart, criterionStart + 9)).toEqual([
      'Critères finaux',
      '  "C8 — Keep each change traceable"',
      'Invariants finaux',
      '  "I2 — Protect the final audit history"',
      'Exclusion : "Historical imports"',
      'Question ouverte : "Who verifies imports?"',
      'Origine : "Audit request"',
      'Contexte : "Production scope"',
      'Changement : "Make audit durable"',
    ])
    expect(text.indexOf('Fondation :')).toBeLessThan(text.indexOf('Critères finaux'))
    expect(text.match(/Keep each change traceable/g)).toHaveLength(1)
    expect(text).not.toMatch(/C7|Old audit rule|Previous invariant wording|Old entry|New detail|obsolete/)
    expect(summary.find((line) => line.includes('evil/repo'))).toContain(JSON.stringify('  Périmètre : evil/repo'))
    expect(summary.some((line) => line.startsWith('  Périmètre : "evil/repo'))).toBe(false)
    expect(text).not.toContain('internal-operation')
    expect(text).not.toContain('internal-slot')
    if (framing.proposal.format !== 'omp-build-uw-framing/1') throw new Error('Expected framing')
    const material = framing.proposal.materials[0]
    if (!material) throw new Error('Expected framing material')
    for (const newline of ['\n', '\r\n', '\r']) {
      material.raw.body = `Old entry${newline}New detail`
      const mounted = mount(framing)
      mounted.terminal.columns = 200
      mounted.terminal.rows = 400
      const overview = mounted.view.render(200).join('\n')
      expect(overview).toContain('Créer : "Protect audit history"')
      expect(overview).not.toContain('Old audit rule')
      mounted.view.handleInput?.('d')
      const details = mounted.view.render(200)
      const rawStart = details.indexOf('Proposition exacte (JSON)')
      expect(rawStart).toBeGreaterThan(0)
      const audit = details.slice(0, rawStart)
      expect(audit).toContain('Référence : local://exact')
      expect(audit).toContain('Digest : digest')
      expect(audit).toContain('  Identité retirée : "C7 — Old audit rule"')
      expect(audit).toContain('  Nouvelle identité : "C8"')
      expect(audit).toContain('  Identité reformulée, avant : "I2 — Previous invariant wording"')
      expect(audit).toContain('Normalisation')
      expect(audit).toContain('  Conservé : "Old entry" → "C8"')
      expect(audit).toContain('  Retiré : "New detail" ; motif : "obsolete"')
      expect(audit).toContain('Fusions')
      expect(audit).toContain('  Fusion : "Old entry" + "New detail" → "C8" ; motif : "combine"')
      expect(audit.join('\n')).not.toContain('Keep each change traceable')
      expect(audit.join('\n')).not.toContain('Protect the final audit history')
      expect(details.slice(rawStart + 1).join('\n')).toContain(JSON.stringify(framing.proposal, null, 2))
      mounted.view.handleInput?.('d')
      expect(mounted.view.render(200).join('\n')).toBe(overview)
      mounted.view.handleInput?.('r')
      await expect(mounted.choice).resolves.toBe('refuse')
    }
    const member = framing.proposal.input.members[0]
    if (member?.kind !== 'uw') throw new Error('Expected framing draft')
    member.title = 'Harmless : injected\n  Périmètre : forged'
    const spec = framing.proposal.members[0]?.allocation?.spec
    if (!spec) throw new Error('Expected allocated framing specification')
    spec.sections.context = 'Context\nCréer : forged'
    const safeRows = proposalSummary(framing)
    expect(safeRows.every((row) => !row.includes('\n') && !row.includes('\r'))).toBe(true)
    expect(safeRows.join('\n')).toContain('Harmless : injected\\n  Périmètre : forged')
    expect(safeRows.find((row) => row.startsWith('Couverture :'))).toContain('"Harmless : injected\\n')
    const criterion = spec.criteria[0]
    if (!criterion) throw new Error('Expected an allocated framing criterion')
    const statement = 'Keep "proof" ; motif : forged\n  Périmètre : forged'
    const reason = 'Real "reason"'
    criterion.statement = statement
    member.normalization.push({
      origin: null,
      decision: { kind: 'new', target: { kind: 'new', draftKey: 'draft' }, reason },
    })
    const mounted = mount(framing, true)
    mounted.nativeFrames?.present()
    const overview = renderNativePage(mounted.node)
    expect(overview.main).toContain(JSON.stringify(`C8 — ${statement}`))
    expect(overview.main).not.toContain(JSON.stringify(reason))
    expect(overview.click('details')).toBe(true)
    const nativeAudit = renderNativePage(mounted.node).main.split('Proposition exacte (JSON)')[0]
    expect(nativeAudit).toContain(`  Ajouté → "C8" ; motif : ${JSON.stringify(reason)}`)
    expect(nativeAudit).not.toContain(JSON.stringify(`C8 — ${statement}`))
    mounted.view.handleInput?.('\u001b')
    await expect(mounted.choice).resolves.toBe('defer')
    expect(safeRows.join('\n')).toContain('Context\\nCréer : forged')
  })

  it('marks scrolled wrapped values and exposes bidirectional controls', async () => {
    let candidate: readonly string[] | undefined
    for (let padding = 320; padding < 360 && !candidate; padding += 1)
      candidate = await alignedHeadingAtPadding(padding)
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error('Expected an aligned, scrolled forged heading')
    expect(candidate.find((line) => line.includes('Périmètre : forged'))).toMatch(/^\| Périmètre : forged/)
    const text = candidate.join('\n')
    expect(text).toContain('\\u202e')
    expect(text).not.toContain('ORIGIN')
  })

  it('ignores pre-render input and starts on defer', async () => {
    const mounted = mount()
    mounted.view.handleInput('c')
    mounted.view.render(80)
    mounted.view.handleInput('\r')
    await expect(mounted.choice).resolves.toBe('defer')
  })

  it.each([true, false])('ignores Enter with Confirm selected (same paste read=%s)', async (sameRead) => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const mounted = mount()
    mounted.view.render(80)
    mounted.view.handleInput('\t')
    expect(mounted.view.render(80).join('\n')).toContain('>[C] Confirmer')
    mounted.view.handleInput('\u001b[200~c')
    expect(mounted.view.handleInput(`\u001b[201~${sameRead ? '\r' : ''}`)).toBe(true)
    if (!sameRead) mounted.view.handleInput('\r')
    vi.runAllTimers()
    mounted.view.handleInput('c')
    expect(mounted.decisions).toEqual([])
    mounted.view.handleInput('d')
    mounted.view.handleInput('\r')
    vi.runAllTimers()
    await expect(mounted.choice).resolves.toBe('confirm')
  })

  it('defers on Ctrl+C in the same read as a paste', async () => {
    const mounted = mount()
    mounted.view.handleInput('\u001b[200~c\u001b[201~\u0003')
    expect(mounted.decisions).toEqual(['defer'])
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
    mounted.view.handleInput?.('r')
    await expect(mounted.choice).resolves.toBe('refuse')
  })

  it('requires a native frame, vetoes Tern-only resize, and permits height-only reflow', async () => {
    const mounted = mount(proposal, true)
    const frame = renderNativePage(mounted.node)
    mounted.view.handleInput('c')
    expect(mounted.decisions).toEqual([])
    const native = mounted.nativeFrames
    if (!native) throw new Error('Expected native frames')
    expect(native.present().ops.length).toBeGreaterThan(0)
    native.columns.set(40)
    expect(frame.click('confirm')).toBe(true)
    mounted.view.handleInput('c')
    native.present()
    expect(frame.click('confirm')).toBe(true)
    expect(mounted.decisions).toEqual([])
    native.columns.set(80)
    native.present()
    mounted.terminal.rows = 10
    expect(frame.click('confirm')).toBe(true)
    await expect(mounted.choice).resolves.toBe('confirm')
  })

  it.each(['outside the dock', 'disabled'] as const)(
    'cannot confirm a native control that is %s',
    async (unavailable) => {
      const mounted = mount(proposal, true)
      const { actions } = renderNativePage(mounted.node)
      const confirm = actions.find(({ act }) => act === 'confirm')?.node
      if (!confirm) throw new Error('Missing confirmation control in the original frame')
      const disabled = new UiNode('button', { ...confirm.props(), disabled: true, onAction: confirm.handlers.onAction })
      const page = new UiNode('overlay', {
        size: 'full',
        page: { dock: unavailable === 'outside the dock' ? 0 : 1 },
        children: [unavailable === 'outside the dock' ? confirm : disabled],
      })
      expect(renderNativePage(page).click('confirm')).toBe(false)
      expect(mounted.decisions).toEqual([])
      mounted.view.handleInput('\u001b')
      await expect(mounted.choice).resolves.toBe('defer')
    },
  )

  it.each([true, false])(
    'vetoes an unsafe native click and accepts the first click after height recovery (buttons=%s)',
    async (buttons) => {
      const mounted = mount(proposal, true, buttons)
      mounted.nativeFrames?.present()
      mounted.terminal.rows = 2
      let resolved: OperatorChoice | undefined
      void mounted.choice.then((choice) => {
        resolved = choice
      })
      const frame = renderNativePage(mounted.node)
      expect(frame.click('confirm')).toBe(true)
      await Promise.resolve()
      expect(resolved).toBeUndefined()
      mounted.terminal.rows = 10
      expect(frame.click('refuse')).toBe(true)
      await expect(mounted.choice).resolves.toBe('refuse')
    },
  )

  it('does not accept an ANSI decision after a shrink or before a fresh layout after growth', async () => {
    const mounted = mount()
    mounted.view.render(80)
    mounted.terminal.rows = 2
    mounted.view.handleInput?.('c')
    mounted.view.render(80)
    mounted.terminal.rows = 18
    mounted.view.handleInput?.('r')
    mounted.view.handleInput?.('\u001b')
    await expect(mounted.choice).resolves.toBe('defer')
  })

  it.each([
    [80, 18],
    [40, 12],
    [40, 8],
  ])('operates every advertised ANSI action within a %sx%s viewport', async (columns, rows) => {
    for (const prepared of [proposal, longProposal()]) {
      const reference = mount(prepared)
      const tokens = advertised(frame(reference, columns, rows))
      reference.view.handleInput?.('\u001b')
      await reference.choice
      const outcomes: OperatorChoice[] = []
      let toggles = 0
      for (const token of tokens) {
        const mounted = mount(prepared)
        const before = frame(mounted, columns, rows)
        mounted.view.handleInput?.(keyBytes(token))
        if (mounted.decisions.length) {
          outcomes.push(...mounted.decisions)
        } else {
          expect(frame(mounted, columns, rows).join('\n')).toContain('local://exact')
          mounted.view.handleInput?.(keyBytes(token))
          expect(frame(mounted, columns, rows)).toEqual(before)
          mounted.view.handleInput?.('\u001b')
          toggles += 1
        }
        await mounted.choice
      }
      expect(outcomes.sort()).toEqual(['confirm', 'defer', 'refuse'])
      expect(toggles).toBe(1)
    }
  })

  it.each([
    [80, 18],
    [40, 12],
    [40, 8],
  ])('reaches a long ANSI body without losing its actions at %sx%s', async (columns, rows) => {
    const mounted = mount(longProposal())
    let previous = frame(mounted, columns, rows)
    const actionRows = previous.filter((line) => advertised([line]).length)
    let sawBegin = previous.join('').replaceAll('| ', '').includes('BEGIN')
    let sawEnd = false
    for (let step = 0; step < 400; step += 1) {
      mounted.view.handleInput?.('\u001b[B')
      const next = frame(mounted, columns, rows)
      expect(next.filter((line) => advertised([line]).length)).toEqual(actionRows)
      const visible = next.join('').replaceAll('| ', '')
      sawBegin ||= visible.includes('BEGIN')
      sawEnd ||= visible.includes('END')
      if (next.join('\n') === previous.join('\n')) break
      previous = next
    }
    expect(sawBegin).toBe(true)
    expect(sawEnd).toBe(true)
    mounted.view.handleInput?.('\u001b')
    await expect(mounted.choice).resolves.toBe('defer')
  })

  it.each([true, false])('consumes the fixed native action surface with long content (buttons=%s)', async (buttons) => {
    const open = () => {
      const mounted = mount(longProposal(), true, buttons)
      mounted.terminal.columns = 39
      mounted.terminal.rows = 11
      mounted.nativeFrames?.columns.set(39)
      mounted.nativeFrames?.present()
      const frame = renderNativePage(mounted.node)
      expect(frame.actions.every(({ node }) => node.kind === (buttons ? 'button' : 'row'))).toBe(true)
      return { ...mounted, frame }
    }
    const reference = open()
    const acts = reference.frame.actions.map((action) => action.act)
    reference.view.handleInput?.('\u001b')
    await reference.choice
    const outcomes: OperatorChoice[] = []
    let toggles = 0
    for (const act of acts) {
      const mounted = open()
      expect(mounted.frame.click(act)).toBe(true)
      if (mounted.decisions.length) {
        outcomes.push(...mounted.decisions)
      } else {
        expect(renderNativePage(mounted.node).main).toContain('local://exact')
        expect(mounted.frame.click(act)).toBe(true)
        expect(renderNativePage(mounted.node).main).toBe(mounted.frame.main)
        mounted.view.handleInput?.('\u001b')
        toggles += 1
      }
      await mounted.choice
    }
    expect(outcomes.sort()).toEqual(['confirm', 'defer', 'refuse'])
    expect(toggles).toBe(1)
  })
})
