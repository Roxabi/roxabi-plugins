import { afterEach, expect, it, vi } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import {
  closure,
  codes,
  effectGuard,
  existingRootAggregate,
  installed,
  numberOf,
  prepare,
  scope,
} from '../../testing/framing-runtime-fixture.ts'
import { createInput } from '../../testing/uw-operations-fixture.ts'
import { continueFeature } from '../workflow.ts'
import { writtenBoundary } from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

const cases = [
  {
    member: 'root',
    suffix: ':intent',
    kind: 'publish-intent',
    hold: 'framing-intent-unpublished',
    durable: null,
    created: 1,
  },
  {
    member: 'root',
    suffix: ':claim',
    kind: 'publish-claim',
    hold: 'framing-member-unclaimed',
    durable: 'framing-binding-unregistered',
    created: 1,
  },
  {
    member: 'root',
    suffix: ':identity-allocate',
    kind: 'publish-identity',
    hold: 'framing-identity-unpublished',
    durable: 'framing-aggregate-incomplete',
    created: 1,
  },
  {
    member: 'foundation',
    suffix: ':binding',
    kind: 'publish-binding',
    hold: 'framing-member-unbound',
    durable: null,
    created: 2,
  },
  {
    member: 'foundation',
    suffix: ':claim',
    kind: 'publish-claim',
    hold: 'framing-member-unclaimed',
    durable: 'framing-binding-unregistered',
    created: 2,
  },
  {
    member: 'foundation',
    suffix: ':identity-allocate',
    kind: 'publish-identity',
    hold: 'framing-identity-unpublished',
    durable: 'framing-aggregate-incomplete',
    created: 2,
  },
  {
    member: 'root',
    suffix: ':edge:0',
    kind: 'parent-child',
    hold: 'framing-edge-unapplied',
    durable: 'framing-aggregate-incomplete',
    created: 3,
  },
  {
    member: null,
    suffix: ':result',
    kind: 'publish-result',
    hold: 'framing-result-unpublished',
    durable: null,
    created: 3,
  },
] as const

it.each(cases)(
  'stops at $member $kind and preserves each consumer-visible hold',
  async ({ member, suffix, kind, hold, durable, created }) => {
    const boundary = writtenBoundary()
    const native = boundary.native
    const framing = await installed(native)
    let writesAtStop = -1
    const { guard, points } = effectGuard((point) => {
      const stop = point.at === 'before-effect' && point.member === member && point.effectId.endsWith(suffix)
      if (stop) writesAtStop = native.writes.length
      return stop
    })
    const result = await framing.operations.frame(await prepare(framing.operations, closure()), guard)
    if (result.status !== 'partial') throw new Error(`Expected partial result: ${JSON.stringify(result)}`)
    const index = result.effects.findIndex((effect) => effect.kind === kind && effect.member === member)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(result.effects.slice(0, index).every((effect) => effect.status === 'confirmed')).toBe(true)
    expect(result.effects[index]).toMatchObject({ kind, member, status: 'failed-before-effect' })
    expect(result.effects.slice(index + 1).every((effect) => effect.status === 'not-attempted')).toBe(true)
    expect(result.holds[0]).toMatchObject({ code: hold, member, durable })
    expect(writesAtStop).toBeGreaterThanOrEqual(0)
    expect(native.writes).toHaveLength(writesAtStop)
    expect(native.count('create')).toBe(created)
    expect(framing.confirmations()).toBe(1)
    expect(
      points.filter(
        (point) => point.at === 'before-effect' && point.effectId.endsWith(suffix) && point.member === member,
      ),
    ).toHaveLength(1)

    const gh: Gh = async (cwd, args) => {
      if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
      return native.gh(cwd, args)
    }
    for (const effect of result.effects.filter((item) => item.kind === 'create' && item.status === 'confirmed')) {
      if (!effect.scope) throw new Error('A confirmed create must name its issue')
      const current = await framing.operations.readUw(effect.scope)
      expect(current.accepted.status).toBe('absent')
      const stopHold = result.holds.find((entry) => entry.member === effect.member)
      if (!stopHold) throw new Error('Every created member must have a journal hold')
      if (stopHold.durable === null) {
        expect(current.admission.aggregate.status).toBe('none')
        expect(codes(current.admission.framed.diagnostics)).toContain('spec-id-unallocated')
      } else {
        expect(current.admission.aggregate).toMatchObject({ status: 'held', code: stopHold.durable })
      }
      const selected = await continueFeature({
        cwd: boundary.principal,
        reference: effect.scope.target,
        control: 'select',
        principal: true,
        gh,
        git: boundary.git,
        uw: framing.operations,
      })
      expect(selected).toMatchObject({ kind: 'blocked', reason: stopHold.durable ?? 'spec-id-unallocated' })
      if (stopHold.durable !== null) {
        const next = await installed(native)
        const input = createInput()
        const attempted = await next.operations.create({
          ...input,
          repository: 'acme/app',
          draft: {
            ...input.draft,
            criteria: [{ kind: 'new', draftKey: 'new-work', statement: 'Process the new request' }],
          },
          normalization: [{ kind: 'new', target: { kind: 'new', draftKey: 'new-work' }, reason: 'Requested work' }],
          writes: {
            labels: { add: [], remove: [] },
            relations: {
              addChildren: [],
              removeChildren: [],
              removeBlockers: [],
              addBlockers: [{ repository: 'acme/app', number: numberOf(effect.scope) }],
            },
          },
        })
        expect(attempted.status, JSON.stringify(attempted)).toBe('refused')
        if (attempted.status !== 'refused') throw new Error('Expected singleton endpoint hold')
        expect(codes(attempted.diagnostics)).toContain(stopHold.durable)
        expect(next.confirmations()).toBe(0)
      }
      expect(native.writes).toHaveLength(writesAtStop)
    }
  },
)

it('refuses an existing aggregate before its intent without recording any effect', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Queue storage', parent: 41 } })
  const framing = await installed(native)
  const guard = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(':intent'))
  const result = await framing.operations.frame(
    await prepare(framing.operations, await existingRootAggregate(framing.operations)),
    guard.guard,
  )
  expect(result.status).toBe('refused')
  expect(result.effects).toEqual([])
  expect(framing.confirmations()).toBe(1)
  expect(native.writes).toEqual([])
  expect((await framing.operations.readUw(scope(41))).admission.aggregate.status).toBe('none')
})

it('holds both existing members when the child patch is refused before its native write', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Queue storage', parent: 41 } })
  const framing = await installed(native)
  let writesAtStop = -1
  const guard = effectGuard((point) => {
    const stop = point.at === 'before-effect' && point.member === 'child' && point.effectId.endsWith(':patch')
    if (stop) writesAtStop = native.writes.length
    return stop
  })
  const result = await framing.operations.frame(
    await prepare(framing.operations, await existingRootAggregate(framing.operations)),
    guard.guard,
  )
  if (result.status !== 'partial') throw new Error(`Expected partial patch: ${JSON.stringify(result)}`)
  const index = result.effects.findIndex((effect) => effect.kind === 'patch' && effect.member === 'child')
  expect(index).toBeGreaterThan(0)
  expect(result.effects.slice(0, index).every((effect) => effect.status === 'confirmed')).toBe(true)
  expect(result.effects[index]).toMatchObject({ status: 'failed-before-effect', scope: scope(42) })
  expect(result.effects.slice(index + 1).every((effect) => effect.status === 'not-attempted')).toBe(true)
  expect(result.holds[0]).toMatchObject({
    code: 'framing-patch-unapplied',
    member: 'child',
    scope: scope(42),
    durable: 'framing-aggregate-incomplete',
  })
  expect(native.writes).toHaveLength(writesAtStop)
  expect(native.count('patch')).toBe(1)
  expect(native.issues.get(42)?.parent).toBe(41)
  for (const number of [41, 42]) {
    expect((await framing.operations.readUw(scope(number))).admission.aggregate).toMatchObject({
      status: 'held',
      code: 'framing-aggregate-incomplete',
    })
  }
})

it('refuses fresh feature selection of an issue whose creation response was lost', async () => {
  const boundary = writtenBoundary()
  const native = boundary.native
  native.injectFault((write) => (write.kind === 'create' ? 'lose-response' : null))
  const framing = await installed(native)
  const result = await framing.operations.frame(await prepare(framing.operations, closure()), effectGuard().guard)
  if (result.status !== 'uncertain') throw new Error(`Expected uncertain creation: ${JSON.stringify(result)}`)
  expect(result.root).toBeNull()
  expect(result.effects[0]).toMatchObject({ kind: 'create', status: 'outcome-unknown', scope: null })
  expect(result.effects.slice(1).every((effect) => effect.status === 'not-attempted')).toBe(true)
  expect(result.holds).toEqual([
    expect.objectContaining({ code: 'framing-create-uncertain', member: 'root', scope: null, durable: null }),
  ])
  expect(native.writes).toEqual([{ kind: 'create', issue: 51 }])
  const read = await framing.operations.readUw(scope(51))
  expect(read.accepted.status).toBe('absent')
  expect(read.admission.aggregate.status).toBe('none')
  expect(codes(read.admission.framed.diagnostics)).toContain('spec-id-unallocated')
  const gh: Gh = async (cwd, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    return native.gh(cwd, args)
  }
  const selected = await continueFeature({
    cwd: boundary.principal,
    reference: scope(51).target,
    control: 'select',
    principal: true,
    gh,
    git: boundary.git,
    uw: framing.operations,
  })
  expect(selected).toMatchObject({ kind: 'blocked', reason: 'spec-id-unallocated' })
  expect(native.writes).toEqual([{ kind: 'create', issue: 51 }])
  expect(framing.confirmations()).toBe(1)
})

it('distinguishes an intent written before guard loss from the local unconfirmed journal', async () => {
  const boundary = writtenBoundary()
  const native = boundary.native
  const framing = await installed(native)
  let writesAtStop = -1
  const guard = effectGuard((point) => {
    const stop = point.at === 'after-readback' && point.effectId.endsWith(':intent')
    if (stop) writesAtStop = native.writes.length
    return stop
  })
  const result = await framing.operations.frame(await prepare(framing.operations, closure()), guard.guard)
  if (result.status !== 'partial' || result.root === null)
    throw new Error(`Expected an unconfirmed published intent: ${JSON.stringify(result)}`)
  expect(result.effects[0]).toMatchObject({ kind: 'create', status: 'confirmed', scope: result.root })
  expect(result.effects[1]).toMatchObject({ kind: 'publish-intent', status: 'applied-readback-unconfirmed' })
  expect(result.effects[1].evidenceRefs).toHaveLength(1)
  expect(result.effects.slice(2).every((effect) => effect.status === 'not-attempted')).toBe(true)
  expect(result.holds[0]).toMatchObject({
    code: 'framing-intent-uncertain',
    member: 'root',
    scope: result.root,
    durable: null,
  })
  expect(native.writes).toHaveLength(writesAtStop)
  expect(native.count('create')).toBe(1)
  const read = await framing.operations.readUw(result.root)
  expect(read.accepted.status).toBe('absent')
  expect(read.admission.aggregate).toMatchObject({ status: 'held', code: 'framing-binding-unregistered' })
  const gh: Gh = async (cwd, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    return native.gh(cwd, args)
  }
  expect(
    await continueFeature({
      cwd: boundary.principal,
      reference: result.root.target,
      control: 'select',
      principal: true,
      gh,
      git: boundary.git,
      uw: framing.operations,
    }),
  ).toMatchObject({ kind: 'blocked', reason: 'framing-binding-unregistered' })
  expect(native.writes).toHaveLength(writesAtStop)
})

it('does not retry a rejected intent POST or give the stranded issue an identity', async () => {
  const boundary = writtenBoundary()
  const native = boundary.native
  native.injectFault((write) => (write.kind === 'comment' ? 'reject' : null))
  const framing = await installed(native)
  const result = await framing.operations.frame(await prepare(framing.operations, closure()), effectGuard().guard)
  if (result.status !== 'uncertain' || result.root === null)
    throw new Error(`Expected uncertain intent: ${JSON.stringify(result)}`)
  expect(result.effects[0]).toMatchObject({ kind: 'create', status: 'confirmed', scope: result.root })
  expect(result.effects[1]).toMatchObject({ kind: 'publish-intent', status: 'outcome-unknown' })
  expect(result.effects.slice(2).every((effect) => effect.status === 'not-attempted')).toBe(true)
  expect(result.holds[0]).toMatchObject({
    code: 'framing-intent-uncertain',
    member: 'root',
    scope: result.root,
    durable: null,
  })
  expect(native.writes.map((write) => write.kind)).toEqual(['create', 'comment'])
  expect(native.comments.get(numberOf(result.root))).toEqual([])
  const read = await framing.operations.readUw(result.root)
  expect(read.admission.aggregate.status).toBe('none')
  expect(codes(read.admission.framed.diagnostics)).toContain('spec-id-unallocated')
  const gh: Gh = async (cwd, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    return native.gh(cwd, args)
  }
  expect(
    await continueFeature({
      cwd: boundary.principal,
      reference: result.root.target,
      control: 'select',
      principal: true,
      gh,
      git: boundary.git,
      uw: framing.operations,
    }),
  ).toMatchObject({ kind: 'blocked', reason: 'spec-id-unallocated' })
  expect(native.writes.map((write) => write.kind)).toEqual(['create', 'comment'])
})

const rejectedEffects = [
  { member: 'root', suffix: ':create', kind: 'create', hold: 'framing-create-uncertain' },
  { member: 'root', suffix: ':intent', kind: 'publish-intent', hold: 'framing-intent-uncertain' },
  { member: 'root', suffix: ':claim', kind: 'publish-claim', hold: 'framing-member-unclaimed' },
  { member: 'root', suffix: ':identity-allocate', kind: 'publish-identity', hold: 'framing-identity-unpublished' },
  { member: 'root', suffix: ':labels', kind: 'labels', hold: 'framing-patch-unapplied' },
  { member: 'foundation', suffix: ':create', kind: 'create', hold: 'framing-create-uncertain' },
  { member: 'foundation', suffix: ':binding', kind: 'publish-binding', hold: 'framing-member-unbound' },
  { member: 'foundation', suffix: ':claim', kind: 'publish-claim', hold: 'framing-member-unclaimed' },
  {
    member: 'foundation',
    suffix: ':identity-allocate',
    kind: 'publish-identity',
    hold: 'framing-identity-unpublished',
  },
  { member: 'root', suffix: ':edge:0', kind: 'parent-child', hold: 'framing-edge-unapplied' },
  { member: null, suffix: ':result', kind: 'publish-result', hold: 'framing-result-unpublished' },
] as const

it.each(rejectedEffects)(
  'does not retry rejected $member $kind or execute its successors',
  async ({ member, suffix, kind, hold }) => {
    const native = nativeGitHub()
    const framing = await installed(native)
    let writesBeforeFailure = -1
    const guard = effectGuard((point) => {
      if (point.at === 'before-effect' && point.member === member && point.effectId.endsWith(suffix)) {
        writesBeforeFailure = native.writes.length
        native.injectFault(() => 'reject')
      }
      return false
    })
    const result = await framing.operations.frame(await prepare(framing.operations, closure()), guard.guard)
    if (result.status !== 'uncertain') throw new Error(`Expected uncertain effect: ${JSON.stringify(result)}`)
    const index = result.effects.findIndex((effect) => effect.kind === kind && effect.member === member)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(result.effects.slice(0, index).every((effect) => effect.status === 'confirmed')).toBe(true)
    expect(result.effects[index]).toMatchObject({ kind, member, status: 'outcome-unknown' })
    expect(result.effects.slice(index + 1).every((effect) => effect.status === 'not-attempted')).toBe(true)
    expect(result.holds[0]).toMatchObject({ code: hold, member })
    expect(writesBeforeFailure).toBeGreaterThanOrEqual(0)
    expect(native.writes).toHaveLength(writesBeforeFailure + 1)
    expect(framing.confirmations()).toBe(1)
  },
)
