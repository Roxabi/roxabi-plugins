import { expect, it } from 'vitest'
import { wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { rawSource } from '../../adapters/github-native/uw-spec.ts'
import { resolveAcceptedSpec } from '../../dist/contracts.js'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import { closure, codes, effectGuard, installed, numberOf, prepare } from '../../testing/framing-runtime-fixture.ts'
import { seedHistoricalChild } from '../../testing/installed-parent-guard-history.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { createInput } from '../../testing/uw-operations-fixture.ts'

const issue = (number: number) => ({ repository: 'acme/app', number })

function request(kind: 'parent' | 'blocker', number: number) {
  const initial = createInput()
  return {
    ...initial,
    repository: 'acme/app',
    draft: {
      ...initial.draft,
      criteria: [{ kind: 'new' as const, draftKey: 'new-work', statement: 'Process the new request' }],
    },
    normalization: [
      { kind: 'new' as const, target: { kind: 'new' as const, draftKey: 'new-work' }, reason: 'Requested work' },
    ],
    writes: {
      labels: { add: [], remove: [] },
      relations: {
        addChildren: [],
        removeChildren: [],
        addBlockers: kind === 'blocker' ? [issue(number)] : [],
        removeBlockers: [],
        ...(kind === 'parent' ? { parent: issue(number) } : {}),
      },
    },
  }
}

it('creates under an ordinary inactive parent without reading historical descendant sources', async () => {
  const native = nativeGitHub({
    41: { title: 'Parent' },
    42: { title: 'Historical child', parent: 41 },
    43: { title: 'Unrelated child', parent: 41 },
  })
  seedHistoricalChild(native.issues, native.comments)
  const forbidden: string[] = []
  const gh: Gh = async (cwd, args) => {
    const endpoint = args.find((arg) => /issues\/(44|46)\/comments/.test(arg))
    if (endpoint) {
      forbidden.push(endpoint)
      throw new Error('Historical source is unavailable')
    }
    return native.gh(cwd, args)
  }
  const { operations, confirmations } = await installed({ ...native, gh })
  const result = await operations.create(request('parent', 41))
  expect(result.status, JSON.stringify(result)).toBe('created')
  if (result.status !== 'created') throw new Error('Expected confirmed creation')
  expect(confirmations()).toBe(1)
  expect(native.issues.get(numberOf(result.value.uw))?.parent).toBe(41)
  expect(native.issues.get(42)?.parent).toBe(41)
  expect(native.issues.get(43)?.parent).toBe(41)
  expect(
    native.comments.get(numberOf(result.value.uw))?.some((comment) => comment.body.includes('kind=spec-identity')),
  ).toBe(true)
  expect(forbidden).toEqual([])
})

it.each(['root', 'foundation'] as const)(
  'holds a bound %s with no final result before confirmation, creation or identity publication',
  async (key) => {
    const native = nativeGitHub()
    const { operations } = await installed(native)
    const guard = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(':result'))
    const framed = await operations.frame(await prepare(operations, closure()), guard.guard)
    if (framed.status !== 'partial' || framed.root === null)
      throw new Error(`Expected a partial aggregate: ${JSON.stringify(framed)}`)
    const endpoint =
      key === 'root'
        ? framed.root
        : framed.effects.find((effect) => effect.member === key && effect.kind === 'create')?.scope
    if (!endpoint) throw new Error('Expected a confirmed member scope')
    expect((await operations.readUw(endpoint)).admission.aggregate).toMatchObject({
      status: 'held',
      code: 'framing-aggregate-incomplete',
    })
    const next = await installed(native)
    const beforeWrites = native.writes.length
    const result = await next.operations.create(request(key === 'root' ? 'parent' : 'blocker', numberOf(endpoint)))
    expect(result.status, JSON.stringify(result)).toBe('refused')
    if (result.status !== 'refused') throw new Error('Expected endpoint hold')
    expect(codes(result.diagnostics)).toContain('framing-aggregate-incomplete')
    expect(next.confirmations()).toBe(0)
    expect(native.writes.slice(beforeWrites)).toEqual([])
  },
)

it('refuses an existing issue write to a partially framed blocker before allocating its new identity', async () => {
  const native = nativeGitHub({ 60: { title: 'Existing issue' } })
  const { operations } = await installed(native)
  const guard = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(':result'))
  const framed = await operations.frame(await prepare(operations, closure()), guard.guard)
  if (framed.status !== 'partial' || framed.root === null)
    throw new Error(`Expected a partial aggregate: ${JSON.stringify(framed)}`)
  const proposal = request('blocker', numberOf(framed.root))
  const { repository: _repository, ...write } = proposal
  const beforeWrites = native.writes.length
  const next = await installed(native)
  const result = await next.operations.write({
    ...write,
    uw: { repository: 'acme/app', target: 'acme/app#60' },
    sourceBodySha256: rawSource('acme/app#60', '', null).bodySha256,
  })
  expect(result.status, JSON.stringify(result)).toBe('refused')
  if (result.status !== 'refused') throw new Error('Expected endpoint hold')
  expect(codes(result.diagnostics)).toContain('framing-aggregate-incomplete')
  expect(next.confirmations()).toBe(0)
  expect(native.writes.slice(beforeWrites)).toEqual([])
  expect(native.comments.get(60)).toEqual([])
})

it('holds a framed blocker when its required root registry becomes unreadable', async () => {
  const native = nativeGitHub()
  let blockedRoot: number | null = null
  const gh: Gh = async (cwd, args) => {
    if (blockedRoot !== null && args.some((arg) => arg.includes(`/issues/${blockedRoot}/comments`)))
      throw new Error('Framing root history is unavailable')
    return native.gh(cwd, args)
  }
  const { operations } = await installed({ ...native, gh })
  const framed = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
  if (framed.status !== 'written') throw new Error(`Expected complete framing: ${JSON.stringify(framed)}`)
  const member = framed.value.members.find((item) => item.key === 'foundation')
  if (!member) throw new Error('Missing foundation member')
  blockedRoot = numberOf(framed.value.root)
  const beforeWrites = native.writes.length
  const next = await installed({ ...native, gh })
  const result = await next.operations.create(request('blocker', numberOf(member.scope)))
  expect(result.status, JSON.stringify(result)).toBe('refused')
  if (result.status !== 'refused') throw new Error('Expected unreadable aggregate hold')
  expect(codes(result.diagnostics)).toContain('framing-aggregate-unreadable')
  expect(next.confirmations()).toBe(0)
  expect(native.writes.slice(beforeWrites)).toEqual([])
})

it.each(['title', 'body', 'edge'] as const)(
  'refuses a complete unaccepted blocker after native %s drift',
  async (drift) => {
    const native = nativeGitHub()
    const { operations } = await installed(native)
    const framed = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
    if (framed.status !== 'written') throw new Error(`Expected complete framing: ${JSON.stringify(framed)}`)
    const member = framed.value.members.find((item) => item.key === 'dependent')
    if (!member) throw new Error('Missing dependent member')
    const before = await operations.readUw(member.scope)
    expect(before.accepted.status).toBe('absent')
    expect(before.admission.aggregate).toMatchObject({ status: 'complete' })
    const nativeMember = native.issues.get(numberOf(member.scope))
    if (!nativeMember) throw new Error('Missing native dependent')
    if (drift === 'title') nativeMember.title = 'Changed title'
    if (drift === 'body') {
      nativeMember.body = nativeMember.body.replace('Stored requests are drained', 'Stored requests are discarded')
      expect(nativeMember.body).toContain('Stored requests are discarded')
    }
    if (drift === 'edge') nativeMember.blockers = []
    const beforeWrites = native.writes.length
    const next = await installed(native)
    const result = await next.operations.create(request('blocker', numberOf(member.scope)))
    expect(result.status, JSON.stringify(result)).toBe('refused')
    if (result.status !== 'refused') throw new Error('Expected drift hold')
    expect(codes(result.diagnostics)).toContain('framing-result-drift')
    expect(next.confirmations()).toBe(0)
    expect(native.writes.slice(beforeWrites)).toEqual([])
  },
)

it.each(['parent', 'blocker'] as const)(
  'admits an unchanged complete unaccepted member as a %s through its native rules',
  async (relation) => {
    const native = nativeGitHub()
    const { operations } = await installed(native)
    const framed = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
    if (framed.status !== 'written') throw new Error(`Expected complete framing: ${JSON.stringify(framed)}`)
    const member = framed.value.members.find((item) => item.key === 'foundation')
    if (!member) throw new Error('Missing foundation member')
    const before = await operations.readUw(member.scope)
    expect(before.accepted.status).toBe('absent')
    expect(before.admission.aggregate).toMatchObject({ status: 'complete' })
    const next = await installed(native)
    const result = await next.operations.create(request(relation, numberOf(member.scope)))
    expect(result.status, JSON.stringify(result)).toBe('created')
    if (result.status !== 'created') throw new Error('Expected confirmed creation')
    expect(next.confirmations()).toBe(1)
    const created = native.issues.get(numberOf(result.value.uw))
    if (relation === 'parent') expect(created?.parent).toBe(numberOf(member.scope))
    else expect(created?.blockers).toContain(numberOf(member.scope))
  },
)

it('permits a historically accepted paused member as blocker after a title amendment, but not as parent', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const input = closure()
  input.members = [input.members[0]]
  input.edges = []
  input.coverage = []
  input.foundations = []
  const framed = await operations.frame(await prepare(operations, input), effectGuard().guard)
  if (framed.status !== 'written') throw new Error(`Expected complete framing: ${JSON.stringify(framed)}`)
  const root = framed.value.root
  const before = await operations.readUw(root)
  if (
    before.parsed.status !== 'conformant' ||
    !before.identity.ok ||
    before.identity.value.head?.kind !== 'spec-identity'
  )
    throw new Error('Expected the framed native snapshot and published identity')
  const fixtures = roxabiWorkflowFixtures()
  const ownSpec = {
    ...fixtures.ownSpecFromSnapshot(root, before.parsed.snapshot),
    identityAllocations: [{ ...before.identity.value.head, kind: 'spec-identity' as const }],
  }
  const mandate = fixtures.featureMandate(root, {
    recordId: 'endpoint-accepted-mandate',
    operationId: 'endpoint-accepted-operation',
    body: before.parsed.snapshot.raw.body,
    ownSpec,
  })
  async function publish(records: readonly CanonicalRecord[]) {
    const current = await operations.readUw(root)
    const own = current.histories.find((history) => history.source.scope.target === root.target)
    if (!own) throw new Error('Missing framed root history')
    const external = current.histories.filter((history) => history.source.scope.target !== root.target)
    const encoded = encodeCriterionRecords(
      records,
      root,
      roxabiRecordFixtures().projection,
      'automation',
      external,
      own,
    )
    for (const comment of encoded.comments) {
      await native.gh('/fixture', [
        'api',
        '--method',
        'POST',
        `repos/acme/app/issues/${numberOf(root)}/comments`,
        '--raw-field',
        `body=${comment.body}`,
      ])
    }
  }
  await publish([mandate])
  const accepted = await operations.readUw(root)
  if (accepted.accepted.status !== 'accepted')
    throw new Error(`Expected actual accepted authority: ${JSON.stringify(accepted.accepted)}`)
  const source = accepted.accepted.value.ref.sourceAccepted
  expect(source).toEqual({ scope: root, recordId: mandate.recordId, kind: 'mandate' })
  await native.gh('/fixture', [
    'api',
    '--method',
    'PATCH',
    `repos/acme/app/issues/${numberOf(root)}`,
    '--raw-field',
    'title=Renamed after acceptance',
  ])
  const amended = await operations.readUw(root)
  expect(amended.accepted.status).toBe('accepted')
  if (amended.accepted.status !== 'accepted') throw new Error('Amendment lost accepted authority')
  expect(amended.accepted.value.ref.sourceAccepted).toEqual(source)
  expect(amended.admission.aggregate).toMatchObject({ status: 'complete' })
  const pause = fixtures.pauseRequested(mandate)
  await publish([pause, fixtures.pauseConfirmed(mandate, pause)])
  const paused = await operations.readUw(root)
  expect(paused.accepted.status).toBe('refused')
  expect(resolveAcceptedSpec(mandate, paused.histories).ok).toBe(true)
  expect(paused.admission.aggregate).toMatchObject({ status: 'complete' })
  const next = await installed(native)
  const created = await next.operations.create(request('blocker', numberOf(root)))
  expect(created.status, JSON.stringify(created)).toBe('created')
  if (created.status !== 'created') throw new Error('Expected a confirmed blocker relation')
  expect(next.confirmations()).toBe(1)
  expect(native.issues.get(numberOf(created.value.uw))?.blockers).toContain(numberOf(root))
  const beforeWrites = native.writes.length
  const parentCommand = await installed(native)
  const parent = await parentCommand.operations.create(request('parent', numberOf(root)))
  expect(parent.status, JSON.stringify(parent)).toBe('refused')
  if (parent.status !== 'refused') throw new Error('Expected parent engagement hold')
  expect(codes(parent.diagnostics)).toContain('cause-parent-guard')
  expect(parentCommand.confirmations()).toBe(0)
  expect(native.writes.slice(beforeWrites)).toEqual([])
})

it('holds a framed blocker with an unresolvable mandate rather than inventing past acceptance', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const input = closure()
  input.members = [input.members[0]]
  input.edges = []
  input.coverage = []
  input.foundations = []
  const framed = await operations.frame(await prepare(operations, input), effectGuard().guard)
  if (framed.status !== 'written') throw new Error(`Expected complete framing: ${JSON.stringify(framed)}`)
  const root = framed.value.root
  const before = await operations.readUw(root)
  if (before.parsed.status !== 'conformant') throw new Error('Expected the framed native snapshot')
  const fixtures = roxabiWorkflowFixtures()
  const ownSpec = fixtures.ownSpecFromSnapshot(root, before.parsed.snapshot)
  const mandate = fixtures.featureMandate(root, {
    recordId: 'unresolvable-endpoint-mandate',
    operationId: 'unresolvable-endpoint-operation',
    body: before.parsed.snapshot.raw.body,
    ownSpec,
    inheritedOwnSpecRefs: [
      {
        uw: root,
        version: 'c'.repeat(64),
        sourceAccepted: { scope: root, recordId: 'missing-parent', kind: 'mandate' },
      },
    ],
  })
  await native.gh('/fixture', [
    'api',
    '--method',
    'POST',
    `repos/acme/app/issues/${numberOf(root)}/comments`,
    '--raw-field',
    `body=${wire(mandate)}`,
  ])
  const observed = await operations.readUw(root)
  expect(observed.accepted.status).toBe('refused')
  expect(resolveAcceptedSpec(mandate, observed.histories).ok).toBe(false)
  const beforeWrites = native.writes.length
  const next = await installed(native)
  const result = await next.operations.create(request('blocker', numberOf(root)))
  expect(result.status, JSON.stringify(result)).toBe('refused')
  if (result.status !== 'refused') throw new Error('Expected unreadable aggregate hold')
  expect(codes(result.diagnostics)).toContain('framing-aggregate-unreadable')
  expect(next.confirmations()).toBe(0)
  expect(native.writes.slice(beforeWrites)).toEqual([])
})
