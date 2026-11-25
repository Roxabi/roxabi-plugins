import { afterEach, expect, it, vi } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { admitFeature as continueFeature } from '../../omp/omp-feature-admission.ts'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import {
  closure,
  effectGuard,
  installed,
  invocation,
  numberOf,
  prepare,
  uwMember,
} from '../../testing/framing-runtime-fixture.ts'
import { createInput } from '../../testing/uw-operations-fixture.ts'
import { buildFramingSourceBinding } from '../uw-framing-prepare.ts'
import { writtenBoundary } from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

it.each(['changed-spec', 'before-claim'] as const)(
  'holds the first-Mandate publishing run when concurrent framing stops at %s',
  async (variant) => {
    const boundary = writtenBoundary()
    const native = boundary.native
    const creator = await installed(native)
    const sections = { origin: 'Origin', context: 'Context', change: 'Change' }
    const base = createInput()
    const created = await creator.operations.create({
      ...base,
      repository: 'acme/app',
      title: 'Process requests',
      draft: {
        ...base.draft,
        criteria: [{ kind: 'new', draftKey: 'works', statement: 'Requests are processed in order' }],
        sections,
      },
      normalization: [],
    })
    if (created.status !== 'created') throw new Error(`Expected actual creation: ${JSON.stringify(created)}`)
    const root = created.value.uw
    const framing = await installed(native)
    const before = await framing.operations.readUw(root)
    if (before.parsed.status !== 'conformant') throw new Error('Expected conformant native Spec')
    const source = buildFramingSourceBinding(before, [])
    if (!source.ok) throw new Error(`Cannot capture source: ${JSON.stringify(source.diagnostics)}`)
    const spec = before.parsed.snapshot.spec
    const criterion = spec.criteria[0]
    if (!criterion || spec.criteria.length !== 1) throw new Error('Expected one native criterion')
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
    const changed = variant === 'changed-spec'
    member.draft = {
      criteria: [
        {
          kind: 'existing',
          id: criterion.id,
          statement: changed ? 'Requests are processed in reverse order' : criterion.statement,
        },
      ],
      invariants: [],
      exclusions: spec.exclusions,
      openQuestions: spec.openQuestions,
      sections: spec.sections,
    }
    member.normalization = [
      ...before.parsed.analysis.criterionSources.map((item) => ({
        origin: { kind: 'native' as const, member: 'root' },
        decision: changed
          ? {
              kind: 'reworded' as const,
              source: item.span,
              target: { kind: 'existing' as const, id: criterion.id },
              reason: 'The operator revised ordering',
            }
          : { kind: 'kept' as const, source: item.span, target: { kind: 'existing' as const, id: criterion.id } },
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
    const aggregate = {
      ...closure(),
      source: source.value,
      members: [member],
      edges: [],
      coverage: [],
      foundations: [],
    }
    const prepared = await framing.operations.prepareFraming(aggregate, invocation(aggregate.source))
    if (!prepared.ok) throw new Error(`Cannot seal aggregate: ${JSON.stringify(prepared.diagnostics)}`)
    const sealed = prepared.value
    expect(sealed.proposal.members[0].allocation?.spec.version === spec.version).toBe(!changed)
    let intercepted = false
    let heldCode: string | null = null
    async function interruptMandate() {
      intercepted = true
      const suffix = changed ? ':result' : ':claim'
      const guard = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(suffix))
      const partial = await framing.operations.frame(sealed, guard.guard)
      if (partial.status !== 'partial') throw new Error(`Expected partial framing: ${JSON.stringify(partial)}`)
      if (changed) expect(partial.effects.find((effect) => effect.kind === 'patch')?.status).toBe('confirmed')
      const observed = await framing.operations.readUw(root)
      if (observed.admission.aggregate.status !== 'held') throw new Error('Expected a real aggregate hold')
      heldCode = observed.admission.aggregate.code
    }
    const gh: Gh = async (cwd, args) => {
      if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
      if (args[0] === 'pr' && args[1] === 'list') return '[]'
      if (!intercepted && args.includes('POST') && args.some((arg) => arg.includes('kind=mandate')))
        await interruptMandate()
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
    if (move.kind !== 'session-cwd') throw new Error(`Expected checkout handoff: ${JSON.stringify(move)}`)
    const result = await continueFeature({ ...input, cwd: move.path, principal: false })
    expect(intercepted).toBe(true)
    expect(heldCode).not.toBeNull()
    const after = await continuation.operations.readUw(root)
    expect(after.admission.aggregate).toMatchObject({ status: 'held', code: heldCode })
    if (changed) {
      expect(after.accepted.status).toBe('accepted')
      if (after.accepted.status !== 'accepted' || !after.proposed.ok)
        throw new Error('Expected accepted and proposed Specs')
      expect(after.proposed.snapshot.spec.version).not.toBe(after.accepted.value.snapshot.spec.version)
    }
    expect(result).toMatchObject({ kind: 'blocked', reason: heldCode })
    expect(native.comments.get(numberOf(root))?.some((comment) => comment.body.includes('kind=action-receipt'))).toBe(
      false,
    )
    const repeated = await continueFeature({ ...input, cwd: move.path, principal: false })
    expect(repeated).toMatchObject({ kind: 'blocked', reason: heldCode })
  },
)

it.each(['root', 'foundation'] as const)(
  'a complete %s member reaches feature composition after its own first Mandate',
  async (key) => {
    const boundary = writtenBoundary()
    const native = boundary.native
    const framing = await installed(native)
    const aggregate = closure()
    aggregate.members = aggregate.members.slice(0, 2)
    aggregate.edges = []
    aggregate.coverage = []
    aggregate.foundations = []
    const framed = await framing.operations.frame(await prepare(framing.operations, aggregate), effectGuard().guard)
    if (framed.status !== 'written') throw new Error(`Expected complete aggregate: ${JSON.stringify(framed)}`)
    const member = framed.value.members.find((entry) => entry.key === key)
    if (!member) throw new Error('Missing member')
    const nativeMember = native.issues.get(numberOf(member.scope))
    if (!nativeMember) throw new Error('Missing native member')
    expect(nativeMember.parent).toBeNull()
    expect(nativeMember.blockers).toEqual([])
    const continuation = await installed(native)
    const before = await continuation.operations.readUw(member.scope)
    expect(before.accepted.status).toBe('absent')
    expect(before.admission.aggregate).toMatchObject({ status: 'complete', member: key })
    const gh: Gh = async (cwd, args) => {
      if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
      if (args[0] === 'pr' && args[1] === 'list') return '[]'
      return native.gh(cwd, args)
    }
    const input = {
      cwd: boundary.principal,
      reference: member.scope.target,
      control: 'select' as const,
      principal: true,
      gh,
      git: boundary.git,
      uw: continuation.operations,
    }
    const move = await continueFeature(input)
    if (move.kind !== 'session-cwd') throw new Error(`Expected checkout handoff: ${JSON.stringify(move)}`)
    const result = await continueFeature({ ...input, control: 'continue', cwd: move.path, principal: false })
    const after = await continuation.operations.readUw(member.scope)
    expect(after.accepted.status).toBe('accepted')
    expect(after.admission.aggregate).toMatchObject({ status: 'complete', member: key })
    expect(result).toMatchObject({ kind: 'ready', worktree: move.path })
  },
)
