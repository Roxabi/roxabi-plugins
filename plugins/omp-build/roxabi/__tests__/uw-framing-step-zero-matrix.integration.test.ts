import { expect, test } from 'vitest'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { pauseControls } from '../../engine/__tests__/workflow-test-support.ts'
import type { FramingAggregateInput } from '../../engine/uw-framing-schema.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import {
  bodySha,
  closure,
  codes,
  effectGuard,
  existingRootAggregate,
  installed,
  invocation,
  prepare,
  scope,
  uwMember,
} from '../../testing/framing-runtime-fixture.ts'
import { sisterSpecWorld } from '../../testing/multi-sister-spec-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { UwOperations } from '../uw-contract.ts'
import { ancestryDiagnostics } from '../uw-framing-executor-check.ts'
import { buildFramingSourceBinding } from '../uw-framing-prepare.ts'

function writeInput(input: FramingAggregateInput, number: number, sha: string) {
  const member = input.members[0]
  if (member.kind !== 'uw') throw new Error('Expected UW')
  return {
    uw: scope(number),
    sourceBodySha256: sha,
    title: member.title,
    draft: member.draft,
    factors: member.factors,
    tierOverride: member.tierOverride,
    writes: {
      labels: member.labels,
      relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
    },
    normalization: member.normalization.map((item) => item.decision),
  }
}

async function singleton(operations: UwOperations, number: number, parent: number | null, blockers: number[] = []) {
  const read = await operations.readUw(scope(number))
  const source = buildFramingSourceBinding(read, [])
  if (!source.ok) throw new Error(JSON.stringify(source.diagnostics))
  const input = closure()
  input.source = source.value
  input.members = [
    uwMember(
      {
        kind: 'existing',
        key: 'root',
        uw: scope(number),
        sourceBodySha256: bodySha(read, number),
        selection: { kind: 'command', reference: `#${number}` },
        observed: { nativeParent: parent === null ? null : scope(parent), children: [], blockers: blockers.map(scope) },
      },
      'Request queue',
      'works',
      'Requests are processed in order',
    ),
  ]
  input.edges = []
  input.coverage = []
  input.foundations = []
  return input
}

async function acceptedParentFixture() {
  const example = sisterSpecWorld(true)
  if (!example.parentMandate) throw new Error('Missing parent fixture')
  const native = nativeGitHub({
    41: { title: 'Parent', body: example.parentBody, labels: ['size:F-lite'] },
    42: { title: 'Request queue' },
  })
  const subject = await installed(native)
  const input = await singleton(subject.operations, 42, null)
  const standalone = await prepare(subject.operations, input)
  const planned = standalone.proposal.members[0]
  if (!planned.allocation || !planned.tier) throw new Error('Missing planned child')
  const parsed = parseIssueSpecBody({
    uw: scope(42),
    raw: rawSource(scope(42).target, planned.renderedBody, '2026-10-27T12:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error('Expected conformant planned child')
  const fixtures = roxabiWorkflowFixtures()
  const ownSpec = example.parentMandate.payload.ownSpec
  const identityAllocations = ownSpec.identityAllocations.map((ref) => {
    if (ref.kind !== 'spec-identity') throw new Error('Expected identity reference')
    return { ...ref, kind: ref.kind }
  })
  // Fixture-constructed acceptance is input, not a claim of real operator acceptance.
  const parent = fixtures.epicMandate(
    scope(41),
    [
      {
        scope: scope(42),
        snapshot: parsed.snapshot,
        specVersion: parsed.snapshot.spec.version,
        tier: planned.tier,
      },
    ],
    {
      recordId: 'accepted-ancestor',
      operationId: 'accepted-ancestor-operation',
      ownSpec: { ...ownSpec, identityAllocations },
      body: example.parentBody,
      tier: 'F-lite',
    },
  )
  const publish = async (number: number, body: string) =>
    native.gh('/fixture', [
      'api',
      '--method',
      'POST',
      `repos/acme/app/issues/${number}/comments`,
      '--raw-field',
      `body=${body}`,
    ])
  for (const body of fixtures.framedBodies([parent], 'automation')) await publish(41, body)
  const identity = fixtures.identityAllocation(scope(42))
  const encoded = encodeParts(identity, identity.kind, 65_536)
  if (!encoded.ok) throw new Error('Cannot encode identity')
  for (const body of encoded.value) await publish(42, body)
  const child = native.issues.get(42)
  if (!child) throw new Error('Missing child')
  child.parent = 41
  child.body = planned.renderedBody
  child.labels = [`size:${planned.tier}`]
  const read = await subject.operations.readUw(scope(42))
  const source = buildFramingSourceBinding(read, [])
  if (!source.ok) throw new Error(JSON.stringify(source.diagnostics))
  input.source = source.value
  const member = input.members[0]
  if (member.kind !== 'uw' || member.slot.kind !== 'existing') throw new Error('Expected existing member')
  member.slot.observed.nativeParent = scope(41)
  member.slot.sourceBodySha256 = bodySha(read, 42)
  member.draft.criteria = [{ kind: 'existing', id: 'C1', statement: 'Requests are processed in order' }]
  member.normalization = [
    ...parsed.analysis.criterionSources.map((item) => ({
      origin: { kind: 'native' as const, member: 'root' },
      decision: { kind: 'kept' as const, source: item.span, target: { kind: 'existing' as const, id: 'C1' as const } },
    })),
    ...parsed.analysis.contentSources.map((item) => ({
      origin: { kind: 'native' as const, member: 'root' },
      decision: {
        kind: 'kept' as const,
        source: item.span,
        target: { ...item.target, range: { start: 0, end: item.statement.length } },
      },
    })),
  ]
  native.writes.length = 0
  return { native, input, parent, ...subject }
}

test('an accepted fixture ancestor refuses a different planned tier before confirmation', async () => {
  const { native, input, operations, confirmations } = await acceptedParentFixture()
  const member = input.members[0]
  if (member.kind !== 'uw') throw new Error('Expected UW')
  member.tierOverride = { tier: 'F-full', reason: 'Different planned commitment' }
  const refused = await operations.prepareFraming(input, invocation(input.source))
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(codes(refused.diagnostics)).toContain('framing-parent-commitment-mismatch')
  expect(confirmations()).toBe(0)
  expect(native.writes).toEqual([])
})

test('an accepted fixture ancestor admits the exact planned commitment and seals inherited authority', async () => {
  const { native, input, operations, parent } = await acceptedParentFixture()
  const prepared = await prepare(operations, input)
  expect(prepared.proposal.members[0].inherited).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        uw: scope(41),
        sourceAccepted: expect.objectContaining({ recordId: parent.recordId }),
      }),
    ]),
  )
  const result = await operations.frame(prepared, effectGuard().guard)
  expect(result.status).toBe('written')
  expect((await operations.readUw(scope(42))).admission.aggregate.status).toBe('complete')
  expect(native.issues.get(42)?.parent).toBe(41)
})

test('a paused fixture ancestor is unqualified with the exact inheritance reason', async () => {
  const { native, input, operations, confirmations, parent } = await acceptedParentFixture()
  const pause = pauseControls(parent, 'ancestor-pause')
  for (const record of [pause.requested, pause.confirmed]) {
    const encoded = encodeParts(record, record.kind, 65_536)
    if (!encoded.ok) throw new Error('Cannot encode pause control')
    for (const body of encoded.value)
      await native.gh('/fixture', [
        'api',
        '--method',
        'POST',
        'repos/acme/app/issues/41/comments',
        '--raw-field',
        `body=${body}`,
      ])
  }
  native.writes.length = 0
  const pausedRead = await operations.readUw(scope(42))
  const pausedSource = buildFramingSourceBinding(pausedRead, [])
  if (!pausedSource.ok) throw new Error(JSON.stringify(pausedSource.diagnostics))
  input.source = pausedSource.value
  const refused = await operations.prepareFraming(input, invocation(input.source))
  expect(refused.ok).toBe(false)
  if (!refused.ok)
    expect(refused.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'framing-ancestor-unqualified',
          message: expect.stringContaining('parent-anchor-ancestor-unconfirmed'),
        }),
      ]),
    )
  expect(confirmations()).toBe(0)
  expect(native.writes).toEqual([])
})

test('cross-repository parent is wrapped by the framing ancestry owner', async () => {
  const { input, operations } = await acceptedParentFixture()
  const prepared = await prepare(operations, input)
  const read = await operations.readUw(scope(42))
  // The fictional boundary hosts one repository only. Substitute the graph parent,
  // while retaining the authenticated observation, to exercise the cross-repo walk.
  const synthetic = {
    ...read,
    graph: {
      ...read.graph,
      nodes: read.graph.nodes.map((node) =>
        node.uw.target === scope(42).target
          ? { ...node, parent: { repository: 'foreign/app', target: 'foreign/app#41' } }
          : node,
      ),
    },
  }
  const diagnostics = await ancestryDiagnostics(prepared.proposal.members[0], 'sealed', scope(42), synthetic)
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'framing-ancestor-unqualified',
        message: expect.stringContaining('parent-anchor-ancestry-incomplete'),
      }),
    ]),
  )
})

test('an ancestor abandoned after confirmation holds before the first framing effect', async () => {
  const { native, input, operations, confirmations, parent } = await acceptedParentFixture()
  const concurrent = await installed(native)
  const prepared = await prepare(operations, input)
  const { guard: base } = effectGuard()
  let checks = 0
  let abandonment: unknown
  const guard: typeof base = {
    async check(point) {
      await base.check(point)
      if (point.at === 'confirmation' && ++checks === 2) {
        abandonment = await concurrent.operations.abandon(scope(41), {
          scope: scope(41),
          recordId: parent.recordId,
          kind: 'mandate',
        })
        native.writes.length = 0
      }
    },
  }
  const result = await operations.frame(prepared, guard)
  expect(abandonment).toMatchObject({ status: 'abandoned' })
  expect(confirmations()).toBe(1)
  expect(result.status).toBe('refused')
  expect(result.effects).toEqual([])
  expect(native.writes).toEqual([])
})

test('an own mandate omitting its listing parent is refused on the same cut', async () => {
  const { native, input, operations, confirmations } = await acceptedParentFixture()
  // Fixture-constructed record is input only; the installed decoder and selection owners run unchanged.
  const claim = roxabiWorkflowFixtures().featureMandate(scope(42), {
    recordId: 'unlisted-child-mandate',
    operationId: 'unlisted-child-operation',
  })
  const encoded = encodeParts(claim, claim.kind, 65_536)
  if (!encoded.ok) throw new Error('Cannot encode mandate fixture')
  for (const body of encoded.value)
    await native.gh('/fixture', [
      'api',
      '--method',
      'POST',
      'repos/acme/app/issues/42/comments',
      '--raw-field',
      `body=${body}`,
    ])
  native.writes.length = 0
  const refused = await operations.prepareFraming(input, invocation(input.source))
  expect(refused.ok).toBe(false)
  if (!refused.ok)
    expect(refused.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'framing-slot-authority', message: 'mandate-claim-present' }),
        expect.objectContaining({ code: 'framing-slot-authority', message: expect.stringMatching(/^accepted-/) }),
      ]),
    )
  expect(confirmations()).toBe(0)
  expect(native.writes).toEqual([])
})

test('a complete unaccepted framed member is pinned while an ordinary UW remains writable', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Ordinary' } })
  const { operations, confirmations } = await installed(native)
  const ordinary = await singleton(operations, 42, null)
  const ordinaryRead = await operations.readUw(scope(42))
  const ordinaryPrepared = await operations.prepare(writeInput(ordinary, 42, bodySha(ordinaryRead, 42)))
  expect(ordinaryPrepared.ok).toBe(true)
  const framed = await singleton(operations, 41, null)
  const result = await operations.frame(await prepare(operations, framed), effectGuard().guard)
  if (result.status !== 'written') throw new Error(JSON.stringify(result))
  const read = await operations.readUw(scope(41))
  expect(read.admission.aggregate.status).toBe('complete')
  expect(read.accepted.status).toBe('absent')
  const writesBefore = native.writes.length
  const confirmedBefore = confirmations()
  const pinned = await operations.prepare(writeInput(framed, 41, bodySha(read, 41)))
  expect(pinned.ok).toBe(false)
  if (!pinned.ok) expect(codes(pinned.diagnostics)).toContain('framing-result-pinned')
  expect(native.writes.length).toBe(writesBefore)
  expect(confirmations()).toBe(confirmedBefore)
})

test('an unmandated ancestor refuses the child, then the parent frames the native child', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Queue storage', parent: 41 } })
  const { operations, confirmations } = await installed(native)
  const input = await singleton(operations, 42, 41)
  const refused = await operations.prepareFraming(input, invocation(input.source))
  expect(refused.ok).toBe(false)
  if (!refused.ok)
    expect(refused.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'framing-ancestor-unqualified',
          message: expect.stringContaining('current-inheritance-unavailable'),
        }),
      ]),
    )
  expect(confirmations()).toBe(0)
  expect(native.writes).toEqual([])
  const result = await operations.frame(
    await prepare(operations, await existingRootAggregate(operations)),
    effectGuard().guard,
  )
  expect(result.status).toBe('written')
  expect((await operations.readUw(scope(41))).admission.aggregate.status).toBe('complete')
  expect((await operations.readUw(scope(42))).admission.aggregate.status).toBe('complete')
})

test('duplicate resolved scopes stop before confirmation or writes', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' } })
  const { operations, confirmations } = await installed(native)
  const input = await singleton(operations, 41, null)
  const copy = structuredClone(input.members[0])
  if (copy.slot.kind !== 'existing') throw new Error('Expected existing member')
  copy.slot.key = 'duplicate'
  copy.slot.selection = {
    kind: 'operator-reference',
    text: { sessionId: 'session', entryId: 'entry' },
    reference: '#41',
  }
  input.members.push(copy)
  const refused = await operations.prepareFraming(input, invocation(input.source))
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(codes(refused.diagnostics)).toContain('framing-slot-duplicate')
  expect(confirmations()).toBe(0)
  expect(native.writes).toEqual([])
})

test('an observed blocker plus an opposite planned blocker is a cycle', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Other', blockers: [41] } })
  const { operations, confirmations } = await installed(native)
  const input = await singleton(operations, 41, null)
  const read = await operations.readUw(scope(42))
  input.members.push(
    uwMember(
      {
        kind: 'existing',
        key: 'other',
        uw: scope(42),
        sourceBodySha256: bodySha(read, 42),
        selection: { kind: 'operator-reference', text: { sessionId: 'session', entryId: 'entry' }, reference: '#42' },
        observed: { nativeParent: null, children: [], blockers: [scope(41)] },
      },
      'Other',
      'other',
      'Another request is processed',
    ),
  )
  input.edges.push({ kind: 'blocker', dependent: 'root', blocker: 'other' })
  const refused = await operations.prepareFraming(input, invocation(input.source))
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(codes(refused.diagnostics)).toContain('framing-graph-cycle')
  expect(confirmations()).toBe(0)
  expect(native.writes).toEqual([])
})

test('a foreign blocker that closes no cycle remains outside the aggregate', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue', blockers: [42] }, 42: { title: 'Foreign blocker' } })
  const { operations } = await installed(native)
  const input = await singleton(operations, 41, null, [42])
  const result = await operations.frame(await prepare(operations, input), effectGuard().guard)
  expect(result.status).toBe('written')
  if (result.status === 'written') expect(result.value.members.map((member) => member.scope)).toEqual([scope(41)])
  expect(native.issues.get(41)?.blockers).toEqual([42])
})

test('a planned native reparent is refused before confirmation and writes', async () => {
  const native = nativeGitHub({
    41: { title: 'Request queue' },
    42: { title: 'Queue storage', parent: 43 },
    43: { title: 'Foreign parent' },
  })
  const { operations, confirmations } = await installed(native)
  const input = await existingRootAggregate(operations)
  const root = input.members[0].slot
  const child = input.members[1].slot
  if (root.kind !== 'existing' || child.kind !== 'existing') throw new Error('Expected existing slots')
  root.observed.children = []
  child.observed.nativeParent = scope(43)
  const refused = await operations.prepareFraming(input, invocation(input.source))
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(codes(refused.diagnostics)).toContain('framing-native-parent-conflict')
  expect(confirmations()).toBe(0)
  expect(native.writes).toEqual([])
})
