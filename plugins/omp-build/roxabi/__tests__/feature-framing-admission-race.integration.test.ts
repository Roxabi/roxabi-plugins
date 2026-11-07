import { afterEach, expect, it, vi } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import type { FramingAggregateInput } from '../../engine/uw-framing-schema.ts'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import {
  closure,
  effectGuard,
  installed,
  invocation,
  numberOf,
  uwMember,
} from '../../testing/framing-runtime-fixture.ts'
import { createInput } from '../../testing/uw-operations-fixture.ts'
import { buildFramingSourceBinding } from '../uw-framing-prepare.ts'
import { continueFeature } from '../workflow.ts'
import { writtenBoundary } from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

it('holds the current feature continuation when framing becomes incomplete immediately before its first Mandate POST', async () => {
  const boundary = writtenBoundary()
  const native = boundary.native
  const creator = await installed(native)
  const base = createInput()
  const sections = { origin: 'Origin', context: 'Context', change: 'Change' }
  const created = await creator.operations.create({
    ...base,
    repository: 'acme/app',
    title: 'Process requests',
    draft: {
      ...base.draft,
      criteria: [{ kind: 'new', draftKey: 'works', statement: 'Requests are processed in order' }],
      sections,
    },
    normalization: [
      { kind: 'new', target: { kind: 'new', draftKey: 'works' }, reason: 'Requested work' },
      ...(['origin', 'context', 'change'] as const).map((section) => ({
        kind: 'new' as const,
        target: { kind: 'section' as const, section, range: { start: 0, end: sections[section].length } },
        reason: 'Requested context',
      })),
    ],
  })
  if (created.status !== 'created') throw new Error(`Expected actual created UW: ${JSON.stringify(created)}`)
  expect(creator.confirmations()).toBe(1)
  const root = created.value.uw
  const framing = await installed(native)
  const before = await framing.operations.readUw(root)
  if (before.parsed.status !== 'conformant' || !before.identity.ok || before.identity.value.head === null)
    throw new Error('Created UW must have a conformant Spec and published identity')
  expect(before.accepted.status).toBe('absent')
  const source = buildFramingSourceBinding(before, [])
  if (!source.ok) throw new Error(`Cannot capture actual source: ${JSON.stringify(source.diagnostics)}`)
  const spec = before.parsed.snapshot.spec
  const criterion = spec.criteria[0]
  if (!criterion || spec.criteria.length !== 1 || spec.invariants.length !== 0)
    throw new Error('Expected one existing criterion in the actual created Spec')
  const member = uwMember(
    {
      kind: 'existing',
      key: 'root',
      uw: root,
      sourceBodySha256: before.parsed.snapshot.raw.bodySha256,
      selection: { kind: 'command', reference: `#${numberOf(root)}` },
      observed: { nativeParent: null, children: [], blockers: [] },
    },
    'Process requests',
    'unused',
    criterion.statement,
  )
  member.draft = {
    criteria: [{ kind: 'existing', id: criterion.id, statement: criterion.statement }],
    invariants: [],
    exclusions: spec.exclusions,
    openQuestions: spec.openQuestions,
    sections: spec.sections,
  }
  member.normalization = [
    ...before.parsed.analysis.criterionSources.map((item) => ({
      origin: { kind: 'native' as const, member: 'root' },
      decision: { kind: 'kept' as const, source: item.span, target: { kind: 'existing' as const, id: criterion.id } },
    })),
    ...before.parsed.analysis.contentSources.map((item) => ({
      origin: { kind: 'native' as const, member: 'root' },
      decision: {
        kind: 'kept' as const,
        source: item.span,
        target: { ...item.target, range: { start: 0, end: item.statement.length } },
      },
    })),
  ]
  const aggregate: FramingAggregateInput = {
    ...closure(),
    source: source.value,
    members: [member],
    edges: [],
    coverage: [],
    foundations: [],
  }
  const prepared = await framing.operations.prepareFraming(aggregate, invocation(aggregate.source))
  if (!prepared.ok) throw new Error(`Cannot seal unchanged framing: ${JSON.stringify(prepared.diagnostics)}`)
  const sealed = prepared.value
  expect(sealed.proposal.members[0].allocation?.spec.version).toBe(spec.version)
  expect(sealed.proposal.members[0].allocation?.assignments).toEqual([])
  expect(sealed.proposal.members[0].renderedBody).toBe(before.parsed.snapshot.raw.body)
  let intercepted = false
  let heldBeforePost = false
  const gh: Gh = async (cwd, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    if (
      args.join('\0') ===
      [
        'pr',
        'list',
        '--head',
        `feat/${numberOf(root)}-process-requests`,
        '--base',
        'main',
        '--state',
        'all',
        '--limit',
        '30',
        '--json',
        'number,isCrossRepository,state',
      ].join('\0')
    )
      return '[]'
    if (!intercepted && args.includes('POST') && args.some((arg) => arg.includes('kind=mandate'))) {
      intercepted = true
      const guard = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(':result'))
      const partial = await framing.operations.frame(sealed, guard.guard)
      if (partial.status !== 'partial' || partial.root === null)
        throw new Error(`Expected a real incomplete framing: ${JSON.stringify(partial)}`)
      expect(partial.root).toEqual(root)
      expect(partial.effects.find((effect) => effect.kind === 'publish-result')?.status).toBe('failed-before-effect')
      const observed = await framing.operations.readUw(root)
      heldBeforePost =
        observed.accepted.status === 'absent' &&
        observed.admission.aggregate?.status === 'held' &&
        observed.admission.aggregate.code === 'framing-aggregate-incomplete'
    }
    return native.gh(cwd, args)
  }
  const continuation = await installed(native)
  const input = {
    cwd: boundary.principal,
    reference: root.target,
    control: 'continue' as const,
    principal: true,
    gh,
    git: boundary.git,
    uw: continuation.operations,
  }
  const move = await continueFeature(input)
  if (move.kind !== 'session-cwd') throw new Error(`Expected real checkout handoff: ${JSON.stringify(move)}`)
  expect(intercepted).toBe(false)
  const outcome = await continueFeature({ ...input, cwd: move.path, principal: false })
  expect(intercepted).toBe(true)
  expect(heldBeforePost).toBe(true)
  const after = await continuation.operations.readUw(root)
  expect(after.admission.aggregate).toMatchObject({ status: 'held', code: 'framing-aggregate-incomplete' })
  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'framing-aggregate-incomplete' })
  expect(native.comments.get(numberOf(root))?.some((comment) => comment.body.includes('kind=action-receipt'))).toBe(
    false,
  )
})
