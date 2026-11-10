import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Component } from '@oh-my-pi/pi-tui'
import type { DescribeContext } from '@oh-my-pi/pi-tui/native/node'
import { describe, expect, it } from 'vitest'
import type { PreparedOperatorProposal } from '../../roxabi/uw-contract.ts'
import { operatorDialogKeybindings } from '../../testing/operator-dialog-ui.ts'
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

type View = Pick<Component, 'render' | 'handleInput' | 'describe' | 'describeScreen' | 'handleNativeEvent'>
function mount(prepared: PreparedOperatorProposal = proposal) {
  let view!: View
  const terminal = { columns: 80, rows: 18 }
  const result = Promise.withResolvers<OperatorChoice>()
  const decisions: OperatorChoice[] = []
  const ui = {
    custom: (
      factory: (tui: unknown, theme: unknown, keys: unknown, done: (choice: OperatorChoice) => void) => View,
    ) => {
      view = factory({ terminal, requestRender() {} }, {}, operatorDialogKeybindings, (value) => {
        decisions.push(value)
        result.resolve(value)
      })
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
  return { view, terminal, choice, decisions }
}

type NativeAction = { view: View; act: string; key: string }

/** Consume the advertised actions, including component children in the fixed native surface. */
function nativeActions(view: View, node: unknown, cx?: DescribeContext): NativeAction[] {
  if (Array.isArray(node)) return node.flatMap((child) => nativeActions(view, child, cx))
  if (typeof node !== 'object' || node === null) return []
  const candidate = node as View & {
    key?: string
    p?: { disabled?: unknown; actions?: { click?: string } }
    c?: unknown[]
  }
  if (cx && typeof candidate.describe === 'function') return nativeActions(candidate, candidate.describe(cx), cx)
  const act = candidate.p?.actions?.click
  return [
    ...(act && !candidate.p?.disabled ? [{ view, act, key: candidate.key ?? '' }] : []),
    ...(candidate.c ?? []).flatMap((child) => nativeActions(view, child, cx)),
  ]
}

function clickNative(view: View, node: unknown, act: string): boolean {
  const action = nativeActions(view, node).find((candidate) => candidate.act === act)
  action?.view.handleNativeEvent?.({ type: 'action', key: action.key, act, mods: [] })
  return action !== undefined
}

function nativeText(node: unknown): string {
  if (Array.isArray(node)) return node.map(nativeText).join('\n')
  if (typeof node !== 'object' || node === null) return ''
  const candidate = node as { p?: { text?: unknown }; c?: unknown[] }
  return [typeof candidate.p?.text === 'string' ? candidate.p.text : '', nativeText(candidate.c)].join('\n')
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
  hostile.proposal.title = `${'x'.repeat(padding)}Périmètre : forged\u202e`
  const mounted = mount(hostile)
  mounted.terminal.columns = 40
  mounted.terminal.rows = 8
  let candidate: readonly string[] | undefined
  for (let index = 0; index < 30; index += 1) {
    const lines = mounted.view.render(40)
    if (
      lines.some((line) => /^(?:\| )?Périmètre : forged/.test(line)) &&
      !lines.join('\n').includes('Champ : "title')
    ) {
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
                invariants: [],
                exclusions: [],
                openQuestions: [],
                sections: { origin: '', context: '', change: '' },
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
              slot: { kind: 'new', key: 'child-b', repository: 'acme/app' },
              title: 'Queue worker',
              label: 'wayfinder:task',
              body: '',
            },
          ],
          edges: [],
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
              spec: { criteria: [{ id: 'C8', statement: 'Keep each change traceable' }], invariants: [] },
            },
            nativeAnalysis: {
              analysis: { criterionSources: [{ id: 'C7', statement: 'Old audit rule' }], invariantSources: [] },
            },
          },
        ],
      },
    } as unknown as PreparedOperatorProposal
    const summary = proposalSummary(framing)
    const text = summary.join('\n')
    const coverage = summary.find((line) => line.startsWith('Couverture :'))
    expect(coverage).toContain('C8')
    expect(coverage).toContain('Keep each change traceable')
    expect(coverage).toContain('Queue storage (acme/app)')
    expect(coverage).toContain('Queue worker (acme/app)')
    const foundation = summary.find((line) => line.startsWith('Fondation :'))
    expect(foundation).toContain('Protect audit history (acme/app)')
    expect(foundation).toContain('Queue storage (acme/app)')
    expect(text).toContain('Protect audit history')
    expect(text).toContain('Keep each change traceable')
    expect(text).toContain('acme/app')
    expect(text).toContain('audit')
    expect(text).toContain('C7')
    expect(text).toContain('Old audit rule')
    expect(text).toContain('C8')
    expect(text).toContain('Old entry')
    expect(text).toContain('New detail')
    expect(text).toContain('Fusion')
    expect(text).toContain('obsolete')
    expect(summary.find((line) => line.includes('evil/repo'))).toBe('  Contenu du repère : "  Périmètre : evil/repo"')
    expect(summary.some((line) => line.startsWith('  Périmètre : "evil/repo'))).toBe(false)
    expect(text).not.toContain('internal-operation')
    expect(text).not.toContain('internal-slot')
    if (framing.proposal.format !== 'omp-build-uw-framing/1') throw new Error('Expected framing')
    const material = framing.proposal.materials[0]
    if (!material) throw new Error('Expected framing material')
    for (const newline of ['\n', '\r\n', '\r']) {
      material.raw.body = `Old entry${newline}New detail`
      const rows = proposalSummary(framing)
      expect(rows.find((line) => line.includes('Conservé'))).toContain('Old entry')
      expect(rows.find((line) => line.includes('Retiré'))).toContain('New detail')
    }
    const member = framing.proposal.input.members[0]
    if (member?.kind !== 'uw') throw new Error('Expected framing draft')
    member.title = 'Harmless : injected\n  Périmètre : forged'
    member.draft.sections.context = 'Context\nCréer : forged'
    const safeRows = proposalSummary(framing)
    expect(safeRows.every((row) => !row.includes('\n') && !row.includes('\r'))).toBe(true)
    expect(safeRows.join('\n')).toContain('Harmless : injected\\n  Périmètre : forged')
    expect(safeRows.find((row) => row.startsWith('Couverture :'))).toContain('"Harmless : injected\\n')
    const criterion = member.draft.criteria[0]
    if (!criterion) throw new Error('Expected framing criterion')
    const statement = 'Keep "proof" ; motif : forged\n  Périmètre : forged'
    const reason = 'Real "reason"'
    criterion.statement = statement
    member.normalization.push({
      origin: null,
      decision: { kind: 'new', target: { kind: 'new', draftKey: 'draft' }, reason },
    })
    const added = proposalSummary(framing).find((row) => row.startsWith('  Ajouté'))
    expect(added).toContain(JSON.stringify(`C8 — ${statement}`))
    expect(added).toContain(JSON.stringify(reason))
    expect(added).not.toMatch(/[\r\n]/)
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
    expect(text).not.toContain('Champ : "title')
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
    mounted.view.handleInput?.('r')
    await expect(mounted.choice).resolves.toBe('refuse')
  })

  it('accepts the first native confirmation after a height-only reflow without a new description', async () => {
    const mounted = mount()
    mounted.view.describe?.({ cols: 80, supports: () => true } as unknown as DescribeContext)
    mounted.terminal.rows = 10
    mounted.view.handleNativeEvent?.({ type: 'action', key: 'actions/confirm', act: 'confirm', mods: [] })
    await expect(mounted.choice).resolves.toBe('confirm')
  })

  it.each([true, false])(
    'vetoes an unsafe native click and accepts the first click after height recovery (buttons=%s)',
    async (buttons) => {
      const mounted = mount()
      mounted.terminal.rows = 2
      const description = mounted.view.describe?.({
        cols: 80,
        supports: () => buttons,
      } as unknown as DescribeContext)
      let resolved: OperatorChoice | undefined
      void mounted.choice.then((choice) => {
        resolved = choice
      })
      expect(clickNative(mounted.view, description, 'confirm')).toBe(true)
      await Promise.resolve()
      expect(resolved).toBeUndefined()
      mounted.terminal.rows = 10
      expect(clickNative(mounted.view, description, 'refuse')).toBe(true)
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
    const cx = { cols: 39, supports: () => buttons } as unknown as DescribeContext
    const open = () => {
      const mounted = mount(longProposal())
      mounted.terminal.columns = 39
      mounted.terminal.rows = 11
      const screen = mounted.view.describeScreen?.(cx)
      return { ...mounted, screen, actions: nativeActions(mounted.view, screen?.dock, cx) }
    }
    const reference = open()
    const acts = reference.actions.map((action) => action.act)
    reference.view.handleInput?.('\u001b')
    await reference.choice
    const outcomes: OperatorChoice[] = []
    let toggles = 0
    for (const act of acts) {
      const mounted = open()
      const action = mounted.actions.find((candidate) => candidate.act === act)
      action?.view.handleNativeEvent?.({ type: 'action', key: action.key, act, mods: [] })
      if (mounted.decisions.length) {
        outcomes.push(...mounted.decisions)
      } else {
        expect(nativeText(mounted.view.describeScreen?.(cx)?.main)).toContain('local://exact')
        action?.view.handleNativeEvent?.({ type: 'action', key: action.key, act, mods: [] })
        expect(nativeText(mounted.view.describeScreen?.(cx)?.main)).toBe(nativeText(mounted.screen?.main))
        mounted.view.handleInput?.('\u001b')
        toggles += 1
      }
      await mounted.choice
    }
    expect(outcomes.sort()).toEqual(['confirm', 'defer', 'refuse'])
    expect(toggles).toBe(1)
  })
})
