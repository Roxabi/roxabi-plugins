import { expect, test } from 'vitest'
import type { FramingAggregateInput } from '../../engine/uw-framing-schema.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import {
  bodySha,
  closure,
  codes,
  effectGuard,
  existingRootAggregate,
  installed,
  numberOf,
  prepare,
  scope,
} from '../../testing/framing-runtime-fixture.ts'
import { buildFramingSourceBinding } from '../uw-framing-prepare.ts'

test('frames a new UW closure once through the installed backend and leaves every member complete', async () => {
  const native = nativeGitHub()
  const { operations, confirmations } = await installed(native)
  const { guard, points } = effectGuard()
  const result = await operations.frame(await prepare(operations, closure()), guard)
  if (result.status !== 'written') throw new Error(`Expected a written aggregate: ${JSON.stringify(result)}`)
  expect(confirmations()).toBe(1)
  const member = ['create', 'publish-binding', 'publish-claim', 'publish-identity', 'labels']
  expect(result.effects.map((effect) => effect.kind)).toEqual([
    'create',
    'publish-intent',
    'publish-claim',
    'publish-identity',
    'labels',
    ...member,
    ...member,
    'parent-child',
    'parent-child',
    'blocker',
    'publish-result',
  ])
  expect(result.effects.every((effect) => effect.status === 'confirmed')).toBe(true)
  for (const effect of result.effects) {
    expect(points.some((point) => point.effectId === effect.effectId && point.at === 'before-effect')).toBe(true)
    expect(points.some((point) => point.effectId === effect.effectId && point.at === 'after-readback')).toBe(true)
  }
  // New members are created with their final body: no metadata PATCH, one create per member, no retry.
  expect([
    native.count('create'),
    native.count('patch'),
    native.count('labels'),
    native.count('sub-issue'),
    native.count('blocked-by'),
  ]).toEqual([3, 0, 3, 2, 1])
  const byKey = new Map(result.value.members.map((item) => [item.key, item.scope]))
  const [root, foundation, dependent] = ['root', 'foundation', 'dependent'].map((key) => {
    const value = byKey.get(key)
    if (!value) throw new Error(`Missing framed member ${key}`)
    return value
  })
  expect(result.value.root).toEqual(root)
  expect(native.issues.get(numberOf(foundation))?.parent).toBe(numberOf(root))
  expect(native.issues.get(numberOf(dependent))?.parent).toBe(numberOf(root))
  expect(native.issues.get(numberOf(dependent))?.blockers).toEqual([numberOf(foundation)])
  expect(native.issues.get(numberOf(root))?.labels.some((label) => label.startsWith('size:'))).toBe(true)
  expect(result.value.coverageIntents).toHaveLength(1)
  expect(result.value.coverageIntents[0]).toMatchObject({ parent: root, aggregateResult: result.value.result })
  for (const framed of [root, foundation, dependent])
    expect((await operations.readUw(framed)).admission.aggregate).toMatchObject({ status: 'complete' })
})

test('converts an existing root and native child without re-inserting the observed edge', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Queue storage', parent: 41 } })
  const { operations } = await installed(native)
  const result = await operations.frame(
    await prepare(operations, await existingRootAggregate(operations)),
    effectGuard().guard,
  )
  if (result.status !== 'written') throw new Error(`Expected a written aggregate: ${JSON.stringify(result)}`)
  expect(result.effects.map((effect) => effect.kind)).toEqual([
    'publish-intent',
    'publish-claim',
    'publish-identity',
    'patch',
    'labels',
    'publish-binding',
    'publish-claim',
    'publish-identity',
    'patch',
    'labels',
    'publish-result',
  ])
  expect([native.count('create'), native.count('patch'), native.count('sub-issue')]).toEqual([0, 2, 0])
  expect(native.issues.get(42)?.parent).toBe(41)
  for (const number of [41, 42])
    expect((await operations.readUw(scope(number))).admission.aggregate).toMatchObject({ status: 'complete' })
})

test('frames an already-current existing Wayfinder as a tierless member without metadata writes', async () => {
  const native = nativeGitHub({
    41: { title: 'Research map', body: 'Map the request queue unknowns', labels: ['wayfinder:map'] },
  })
  const { operations } = await installed(native)
  const read = await operations.readUw(scope(41))
  const source = buildFramingSourceBinding(read, [])
  if (!source.ok) throw new Error(`Cannot capture the Wayfinder source: ${codes(source.diagnostics)}`)
  const input: FramingAggregateInput = {
    kind: 'wayfinder',
    root: 'map',
    source: source.value,
    edges: [],
    coverage: [],
    foundations: [],
    members: [
      {
        kind: 'wayfinder',
        title: 'Research map',
        body: 'Map the request queue unknowns',
        label: 'wayfinder:map',
        slot: {
          kind: 'existing',
          key: 'map',
          uw: scope(41),
          sourceBodySha256: bodySha(read, 41),
          selection: { kind: 'command', reference: '#41' },
          observed: { nativeParent: null, children: [], blockers: [] },
        },
      },
    ],
  }
  const result = await operations.frame(await prepare(operations, input), effectGuard().guard)
  if (result.status !== 'written') throw new Error(`Expected a written Wayfinder aggregate: ${JSON.stringify(result)}`)
  expect(result.effects.map((effect) => effect.kind)).toEqual(['publish-intent', 'publish-claim', 'publish-result'])
  expect([native.count('patch'), native.count('labels'), native.count('create')]).toEqual([0, 0, 0])
  expect(native.issues.get(41)?.labels).toEqual(['wayfinder:map'])
  expect((await operations.readUw(scope(41))).admission.aggregate).toMatchObject({ status: 'complete' })
})

test('a declined confirmation writes nothing and the consumed proposal cannot be framed again', async () => {
  const native = nativeGitHub()
  const { operations, confirmations } = await installed(native, { confirm: false })
  const prepared = await prepare(operations, closure())
  const { guard } = effectGuard()
  const declined = await operations.frame(prepared, guard)
  if (declined.status !== 'refused') throw new Error('Expected a declined aggregate')
  expect(declined.effects).toEqual([])
  expect(codes(declined.diagnostics)).toContain('operator-confirmation-declined')
  const replay = await operations.frame(prepared, guard)
  if (replay.status !== 'refused') throw new Error('Expected a consumed proposal refusal')
  expect(codes(replay.diagnostics)).toContain('framing-proposal-unsealed')
  expect(confirmations()).toBe(1)
  expect(native.writes).toEqual([])
})

test('native drift while the proposal is displayed refuses before any effect', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Queue storage', parent: 41 } })
  const { operations } = await installed(native, {
    onConfirm: () => {
      const root = native.issues.get(41)
      if (root) root.body = 'Changed while the proposal was displayed'
    },
  })
  const result = await operations.frame(
    await prepare(operations, await existingRootAggregate(operations)),
    effectGuard().guard,
  )
  if (result.status !== 'refused') throw new Error(`Expected a refused aggregate: ${JSON.stringify(result)}`)
  expect(codes(result.diagnostics)).toContain('framing-native-stale')
  expect(native.writes).toEqual([])
})

test('an unknown root creation stops with a null Scope and no search, retry or publication', async () => {
  const native = nativeGitHub()
  native.injectFault((write) => (write.kind === 'create' ? 'lose-response' : null))
  const { operations } = await installed(native)
  const result = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
  if (result.status !== 'uncertain') throw new Error(`Expected an uncertain aggregate: ${JSON.stringify(result)}`)
  expect(result.root).toBeNull()
  expect(result.effects[0]).toMatchObject({ kind: 'create', status: 'outcome-unknown', scope: null })
  expect(result.effects.slice(1).every((effect) => effect.status === 'not-attempted')).toBe(true)
  expect(result.holds).toEqual([
    expect.objectContaining({ code: 'framing-create-uncertain', member: 'root', scope: null, durable: null }),
  ])
  expect(native.writes.map((write) => write.kind)).toEqual(['create'])
})

test('a revoked guard stops at the first unbound member with durable holds and no later writes', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const { guard } = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(':binding'))
  const result = await operations.frame(await prepare(operations, closure()), guard)
  if (result.status !== 'partial') throw new Error(`Expected a partial aggregate: ${JSON.stringify(result)}`)
  expect(result.effects.slice(0, 6).every((effect) => effect.status === 'confirmed')).toBe(true)
  expect(result.effects[6]).toMatchObject({
    kind: 'publish-binding',
    member: 'foundation',
    status: 'failed-before-effect',
  })
  expect(result.effects.slice(7).every((effect) => effect.status === 'not-attempted')).toBe(true)
  const foundation = result.effects[5].scope
  if (foundation === null || result.root === null) throw new Error('Confirmed creations must carry their Scope')
  expect(result.holds).toContainEqual(
    expect.objectContaining({ code: 'framing-member-unbound', member: 'foundation', scope: foundation, durable: null }),
  )
  expect(result.holds).toContainEqual(
    expect.objectContaining({ member: 'root', scope: result.root, durable: 'framing-aggregate-incomplete' }),
  )
  expect(result.holds.some((hold) => hold.member === 'dependent')).toBe(false)
  expect([native.count('create'), native.count('sub-issue'), native.count('blocked-by')]).toEqual([2, 0, 0])
  expect(native.comments.get(numberOf(foundation))).toEqual([])
  expect((await operations.readUw(result.root)).admission.aggregate).toMatchObject({
    status: 'held',
    code: 'framing-aggregate-incomplete',
  })
})

test('an unknown blocker edge stops before the result and keeps every claimed member held', async () => {
  const native = nativeGitHub()
  native.injectFault((write) => (write.kind === 'blocked-by' ? 'reject' : null))
  const { operations } = await installed(native)
  const result = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
  if (result.status !== 'uncertain') throw new Error(`Expected an uncertain aggregate: ${JSON.stringify(result)}`)
  const blocker = result.effects.find((effect) => effect.kind === 'blocker')
  expect(blocker).toMatchObject({ member: 'dependent', status: 'outcome-unknown' })
  expect(result.effects.at(-1)).toMatchObject({ kind: 'publish-result', status: 'not-attempted' })
  expect(result.holds).toContainEqual(
    expect.objectContaining({
      code: 'framing-edge-unapplied',
      member: 'dependent',
      durable: 'framing-aggregate-incomplete',
    }),
  )
  expect(result.holds.every((hold) => hold.durable === 'framing-aggregate-incomplete')).toBe(true)
  expect(native.count('blocked-by')).toBe(1)
  const blocked = native.writes.findIndex((write) => write.kind === 'blocked-by')
  expect(native.writes.slice(blocked + 1)).toEqual([])
  if (result.root === null) throw new Error('The confirmed root must be known')
  expect((await operations.readUw(result.root)).admission.aggregate).toMatchObject({
    status: 'held',
    code: 'framing-aggregate-incomplete',
  })
})
