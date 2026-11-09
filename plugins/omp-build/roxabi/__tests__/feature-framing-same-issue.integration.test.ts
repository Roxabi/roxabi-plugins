import { afterEach, expect, it, vi } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { installed, numberOf } from '../../testing/framing-runtime-fixture.ts'
import { operatorDialogUi } from '../../testing/operator-dialog-ui.ts'
import { createInput } from '../../testing/uw-operations-fixture.ts'
import { continueFeature } from '../workflow.ts'
import { answeredQuestion, begun, codes, submit } from './feature-framing-controller-drivers.ts'
import { world, writtenBoundary } from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

async function conversion(mode: 'accept' | 'decline' | 'stale') {
  const boundary = writtenBoundary()
  const creator = await installed(boundary.native)
  const initial = createInput()
  const criteria = [
    { kind: 'new' as const, draftKey: 'keep', statement: 'Keep export' },
    { kind: 'new' as const, draftKey: 'retry', statement: 'Retry export' },
    { kind: 'new' as const, draftKey: 'obsolete', statement: 'Remove obsolete format' },
  ]
  const created = await creator.operations.create({
    ...initial,
    repository: 'acme/app',
    title: 'Export requests',
    draft: { ...initial.draft, criteria },
    normalization: criteria.map((criterion) => ({
      kind: 'new' as const,
      target: { kind: 'new' as const, draftKey: criterion.draftKey },
      reason: 'Initial request',
    })),
    writes: {
      labels: { add: [], remove: [] },
      relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
    },
  })
  if (created.status !== 'created') throw new Error(`Cannot create source issue: ${JSON.stringify(created)}`)
  const root = created.value.uw
  const number = numberOf(root)
  const nativeBody = '# Acceptance Criteria\n- C1: Keep export\n- C2: Retry export\n- C3: Remove obsolete format'
  await boundary.native.gh('/fixture', [
    'api',
    '--method',
    'PATCH',
    `repos/acme/app/issues/${number}`,
    '--raw-field',
    `body=${nativeBody}`,
  ])
  const source = await creator.operations.readUw(root)
  expect(source.parsed.status).not.toBe('conformant')
  if (!source.identity.ok) throw new Error('The real source ledger must be readable')
  expect(source.identity.value.allocations.has('C1')).toBe(true)
  expect(source.identity.value.allocations.has('C2')).toBe(true)
  expect(source.identity.value.allocations.has('C3')).toBe(true)
  const gh: Gh = async (cwd, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    return boundary.native.gh(cwd, args)
  }
  const selection = await continueFeature({
    cwd: boundary.principal,
    reference: root.target,
    control: 'select',
    principal: true,
    gh,
    git: boundary.git,
    uw: creator.operations,
  })
  expect(selection).toEqual({ kind: 'framing', source: { kind: 'issue', uw: root } })
  const [kept, reworded, removed] = source.parsed.analysis.criterionSources
  if (!kept || !reworded || !removed) throw new Error('Expected three source obligation spans')
  const sectionText = { origin: 'Origin', context: 'Context', change: 'Change' }
  const nativeOrigin = { kind: 'native' as const, member: 'root' }
  const decisions = [
    {
      origin: nativeOrigin,
      decision: { kind: 'kept' as const, source: kept.span, target: { kind: 'existing' as const, id: 'C1' as const } },
    },
    {
      origin: nativeOrigin,
      decision: {
        kind: 'reworded' as const,
        source: reworded.span,
        target: { kind: 'existing' as const, id: 'C2' as const },
        reason: 'Bound the retry behavior',
      },
    },
    {
      origin: nativeOrigin,
      decision: { kind: 'removed' as const, source: removed.span, reason: 'The obsolete format is out of scope' },
    },
    {
      origin: null,
      decision: {
        kind: 'new' as const,
        target: { kind: 'new' as const, draftKey: 'audit' },
        reason: 'Audit the new delivery behavior',
      },
    },
    ...(['origin', 'context', 'change'] as const).map((section) => ({
      origin: null,
      decision: {
        kind: 'new' as const,
        target: { kind: 'section' as const, section, range: { start: 0, end: sectionText[section].length } },
        reason: 'Interview context',
      },
    })),
  ]
  const w = world({ written: boundary })
  await begun(w, { kind: 'issue', uw: root })
  const interview = await answeredQuestion(w, 'same-issue')
  expect(
    (
      await submit(w, {
        kind: 'grilling',
        shape: 'leaf',
        unresolved: [],
        decisions: [interview],
        terms: [],
      })
    ).status,
  ).toBe('accepted')
  const proposal = {
    kind: 'proposal',
    decisions: [],
    modules: [],
    vocabulary: [],
    aggregate: {
      kind: 'uw',
      root: 'root',
      edges: [],
      coverage: [],
      foundations: [],
      members: [
        {
          kind: 'uw',
          slot: { kind: 'selected', key: 'root' },
          title: 'Export requests',
          draft: {
            criteria: [
              { kind: 'existing', id: 'C1', statement: 'Keep export' },
              { kind: 'existing', id: 'C2', statement: 'Retry failed exports once' },
              { kind: 'new', draftKey: 'audit', statement: 'Record export outcome' },
            ],
            invariants: [],
            exclusions: [],
            openQuestions: [],
            sections: sectionText,
          },
          factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
          tierOverride: null,
          labels: { add: [], remove: [] },
          merges: [],
          normalization: decisions,
        },
      ],
    },
  }
  expect(codes(await submit(w, proposal))).toEqual(['framing-proposal-staged'])
  if (mode === 'stale') {
    const issue = boundary.native.issues.get(number)
    if (!issue) throw new Error('Missing selected native issue')
    issue.body += '\nA concurrent edit after proposal staging'
  }
  const beforeCommit = boundary.native.writes.length
  const display: string[] = []
  const context = w.ctx()
  const capturing = {
    ...context,
    ui: {
      ...context.ui,
      ...operatorDialogUi(
        async () => {
          w.runtime.confirms += 1
          return mode === 'decline' ? 'refuse' : 'confirm'
        },
        (text) => display.push(text),
      ),
    },
  }
  w.runtime.idle = true
  await w.controller.act(capturing)
  if (mode !== 'accept') {
    expect(boundary.native.writes.slice(beforeCommit)).toEqual([])
    expect(boundary.native.count('create')).toBe(1)
    expect(w.controller.view()?.pendingMove).toBeFalsy()
    expect(w.continued).toEqual([])
    if (mode === 'decline') expect(display.length).toBeGreaterThan(0)
    return
  }
  const pending = w.controller.view()?.pendingMove
  if (!pending) throw new Error(`Expected same-issue handoff: ${w.statuses.at(-1)}`)
  expect(pending.root).toEqual(root)
  expect(display.length).toBeGreaterThan(0)
  expect(boundary.native.count('create')).toBe(1)
  expect(
    boundary.native.writes.slice(beforeCommit).some((write) => write.kind === 'patch' && write.issue === number),
  ).toBe(true)
  const written = await creator.operations.readUw(root)
  expect(written.admission.aggregate).toMatchObject({ status: 'complete' })
  if (written.parsed.status !== 'conformant' || !written.identity.ok)
    throw new Error(`Expected rewritten specification and ledger: ${JSON.stringify(written.admission)}`)
  expect(written.parsed.snapshot.spec.criteria).toEqual([
    { id: 'C1', statement: 'Keep export' },
    { id: 'C2', statement: 'Retry failed exports once' },
    { id: 'C4', statement: 'Record export outcome' },
  ])
  expect(written.identity.value.retired.has('C3')).toBe(true)
  expect(written.identity.value.allocations.has('C4')).toBe(true)
  w.location.cwd = pending.destination
  w.runtime.answers.push(true)
  await w.controller.act(w.ctx())
  expect(w.continued).toEqual([
    expect.objectContaining({ reference: root.target, cwd: pending.destination, control: 'continue' }),
  ])
  expect((await creator.operations.readUw(root)).accepted.status).toBe('accepted')
  expect(boundary.native.count('create')).toBe(1)
}

it.each(['accept', 'decline', 'stale'] as const)('%s: accounts for all four decisions on the same issue', conversion)
