import { afterEach, expect, it, vi } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import {
  bodySha,
  closure,
  effectGuard,
  installed,
  invocation,
  numberOf,
  uwMember,
} from '../../testing/framing-runtime-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { createInput } from '../../testing/uw-operations-fixture.ts'
import { loadContracts, publishRecord } from '../feature-engine.ts'
import type { UwOperationResult } from '../uw-contract.ts'
import { readCurrentFramingFacts } from '../uw-current-facts.ts'
import { buildFramingSourceBinding } from '../uw-framing-prepare.ts'
import { writtenBoundary } from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

function isMutation(args: string[]): boolean {
  const methodIndex = args.findIndex((arg) => arg === '--method' || arg === '-X')
  const method = methodIndex < 0 ? null : args[methodIndex + 1]?.toUpperCase()
  const graphql = args[0] === 'api' && args[1] === 'graphql'
  const graphMutation = graphql && args.some((arg) => /^query=\s*mutation\b/.test(arg))
  const implicitPost =
    args[0] === 'api' &&
    !graphql &&
    method === null &&
    args.some((arg) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(arg))
  return (
    (method !== null && method !== undefined && method !== 'GET' && method !== 'HEAD') ||
    graphMutation ||
    implicitPost ||
    (args[0] === 'issue' && ['create', 'edit', 'close', 'reopen', 'delete', 'comment'].includes(args[1]))
  )
}

it('holds framing when an accepted ancestor is abandoned before a deletion crosses its history page boundary', async () => {
  const boundary = writtenBoundary()
  const native = boundary.native
  async function create(title: string, statement: string, parent?: number) {
    const writer = await installed(native)
    const input = createInput()
    const sections = { origin: 'Origin', context: 'Context', change: 'Change' }
    const result = await writer.operations.create({
      ...input,
      repository: 'acme/app',
      title,
      draft: {
        ...input.draft,
        criteria: [{ kind: 'new', draftKey: 'work', statement }],
        sections,
      },
      normalization: [
        { kind: 'new', target: { kind: 'new', draftKey: 'work' }, reason: 'Initial work' },
        ...(['origin', 'context', 'change'] as const).map((section) => ({
          kind: 'new' as const,
          target: { kind: 'section' as const, section, range: { start: 0, end: sections[section].length } },
          reason: 'Initial context',
        })),
      ],
      writes: {
        labels: { add: [], remove: [] },
        relations: {
          addChildren: [],
          removeChildren: [],
          addBlockers: [],
          removeBlockers: [],
          ...(parent === undefined ? {} : { parent: { repository: 'acme/app', number: parent } }),
        },
      },
    })
    if (result.status !== 'created') throw new Error(`Cannot create ${title}: ${JSON.stringify(result)}`)
    return result.value.uw
  }
  const parent = await create('Parent request', 'Requests are processed in order')
  const child = await create('Child request', 'Requests are stored durably', numberOf(parent))
  const reader = await installed(native)
  const beforeParent = await reader.operations.readUw(parent)
  const facts = await readCurrentFramingFacts({ uw: parent, read: beforeParent })
  if (!facts.ok) throw new Error(JSON.stringify(facts.diagnostics))
  const { currentSpec, identityAllocations } = facts.value
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.epicMandate(parent, currentSpec.children, {
    ownSpec: {
      uw: parent,
      version: currentSpec.snapshot.spec.version,
      snapshot: currentSpec.snapshot,
      identityAllocations: identityAllocations.map((ref) => {
        if (ref.kind !== 'spec-identity') throw new Error('Expected parent identity')
        return { ...ref, kind: ref.kind }
      }),
    },
    tier: currentSpec.tier,
  })
  const gh: Gh = async (cwd, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    if (args[0] === 'pr' && args[1] === 'list') return '[]'
    return native.gh(cwd, args)
  }
  const engine = await loadContracts()
  if ('missing' in engine) throw new Error(engine.missing)
  const own = beforeParent.histories.find((history) => history.source.scope.target === parent.target)
  if (own === undefined) throw new Error('Missing Parent history')
  const { inputs: _inputs, ...draft } = mandate
  const published = await publishRecord(engine, draft, gh, boundary.principal)
  if (!published.ok) throw new Error(JSON.stringify(published))
  const accepted = await reader.operations.readUw(parent)
  if (accepted.accepted.status !== 'accepted')
    throw new Error(`Expected the seeded historical Parent mandate: ${JSON.stringify(accepted.accepted)}`)
  const parentRef = accepted.accepted.value.ref.sourceAccepted
  if (parentRef.kind !== 'mandate') throw new Error('Expected the exact accepted mandate reference')
  const mandateRef = { scope: parentRef.scope, recordId: parentRef.recordId, kind: 'mandate' as const }
  expect(accepted.accepted.value.children.map((entry) => entry.scope)).toContainEqual(child)

  const comments = native.comments.get(numberOf(parent))
  if (!comments) throw new Error('Missing Parent history')
  if (comments.length >= 100) throw new Error('Parent setup unexpectedly occupies a complete history page')
  while (comments.length < 100) {
    await native.gh('/fixture', [
      'api',
      '--method',
      'POST',
      `repos/acme/app/issues/${numberOf(parent)}/comments`,
      '--raw-field',
      `body=Unrelated padding ${comments.length}`,
    ])
  }
  const startIds = comments.map((comment) => comment.id)
  let race = false
  let revocationComment: number | null = null
  let firstPage: number[] | null = null
  let boundaryPage: { before: number[]; after: number[]; returned: number[] } | null = null
  const subjectWrites: string[][] = []
  const subjectGh: Gh = async (cwd, args) => {
    if (isMutation(args)) subjectWrites.push([...args])
    const endpoint = args[1]
    if (
      race &&
      endpoint === `repos/acme/app/issues/${numberOf(parent)}/comments?per_page=100&page=1` &&
      firstPage === null
    ) {
      const response = await native.gh(cwd, args)
      firstPage = (JSON.parse(response) as { id: number }[]).map((comment) => comment.id)
      return response
    }
    if (
      race &&
      endpoint === `repos/acme/app/issues/${numberOf(parent)}/comments?per_page=100&page=2` &&
      firstPage !== null &&
      boundaryPage === null
    ) {
      const before = comments.map((comment) => comment.id)
      expect(before.length).toBeGreaterThan(100)
      const padding = comments.findIndex((comment) => comment.body.startsWith('Unrelated padding'))
      if (padding < 0 || padding >= 100) throw new Error('Missing first-page padding')
      comments.splice(padding, 1)
      expect(comments).toHaveLength(before.length - 1)
      const response = await native.gh(cwd, args)
      const returned = (JSON.parse(response) as { id: number }[]).map((comment) => comment.id)
      expect(revocationComment).not.toBeNull()
      expect(before[100]).toBe(revocationComment)
      expect(returned).not.toContain(revocationComment)
      boundaryPage = {
        before,
        after: comments.map((comment) => comment.id),
        returned,
      }
      return response
    }
    return native.gh(cwd, args)
  }
  const subject = await installed({ ...native, gh: subjectGh })
  const actor = await installed(native)
  const childRead = await subject.operations.readUw(child)
  if (childRead.parsed.status !== 'conformant') throw new Error('Expected current child specification')
  const source = buildFramingSourceBinding(childRead, [])
  if (!source.ok) throw new Error(`Cannot bind the real child source: ${JSON.stringify(source.diagnostics)}`)
  const childSpec = childRead.parsed.snapshot.spec
  const item = childSpec.criteria[0]
  if (!item || childSpec.criteria.length !== 1) throw new Error('Expected one real child criterion')
  const member = uwMember(
    {
      kind: 'existing',
      key: 'root',
      uw: child,
      sourceBodySha256: bodySha(childRead, numberOf(child)),
      selection: { kind: 'command', reference: child.target },
      observed: { nativeParent: parent, children: [], blockers: [] },
    },
    'Child request',
    'unused',
    item.statement,
  )
  member.draft = {
    criteria: [{ kind: 'existing', id: item.id, statement: item.statement }],
    invariants: [],
    exclusions: childSpec.exclusions,
    openQuestions: childSpec.openQuestions,
    sections: childSpec.sections,
  }
  member.normalization = [
    ...childRead.parsed.analysis.criterionSources.map((sourceItem) => ({
      origin: { kind: 'native' as const, member: 'root' },
      decision: { kind: 'kept' as const, source: sourceItem.span, target: { kind: 'existing' as const, id: item.id } },
    })),
    ...childRead.parsed.analysis.contentSources.map((sourceItem) => ({
      origin: { kind: 'native' as const, member: 'root' },
      decision: {
        kind: 'kept' as const,
        source: sourceItem.span,
        target: { ...sourceItem.target, range: { start: 0, end: sourceItem.statement.length } },
      },
    })),
  ]
  const input = { ...closure(), source: source.value, members: [member], edges: [], coverage: [], foundations: [] }
  const prepared = await subject.operations.prepareFraming(input, invocation(input.source))
  if (!prepared.ok) throw new Error(`Cannot prepare the inherited child: ${JSON.stringify(prepared.diagnostics)}`)
  expect(prepared.value.proposal.members[0].inherited).toContainEqual(
    expect.objectContaining({
      uw: parent,
      sourceAccepted: parentRef,
    }),
  )
  const recorded = effectGuard()
  let confirmations = 0
  let abandonment: UwOperationResult | null = null
  const result = await subject.operations.frame(prepared.value, {
    async check(point) {
      await recorded.guard.check(point)
      if (point.at === 'confirmation' && ++confirmations === 2) {
        abandonment = await actor.operations.abandon(parent, mandateRef)
        revocationComment = comments[100]?.id ?? null
        race = true
      }
    },
  })
  expect(abandonment, JSON.stringify(abandonment)).toMatchObject({ status: 'abandoned' })
  expect(confirmations).toBe(2)
  expect(firstPage).toEqual(startIds)
  expect(boundaryPage).not.toBeNull()
  expect(subjectWrites).toEqual([])
  expect(result.status).toBe('refused')
  expect(result.effects).toEqual([])
  expect(recorded.points.filter((point) => point.at === 'before-effect')).toEqual([])
})
