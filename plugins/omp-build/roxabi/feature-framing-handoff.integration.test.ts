import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readFramingCoverageIntent } from '../engine/uw-framing-membership.ts'
import type { FramingAggregateInput } from '../engine/uw-framing-schema.ts'
import { dispose, git, sandbox } from '../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { nativeGitHub } from '../testing/framing-native-github.ts'
import { closure, effectGuard, installed, prepare, uwMember } from '../testing/framing-runtime-fixture.ts'
import { prepareFramedFeatureHandoff } from './feature-framing-handoff.ts'
import { freshOwnSpec } from './feature-initial-own-spec.ts'
import type { UwRead } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

function checkoutWorld() {
  const world = sandbox()
  for (const key of ['PATH', 'HOME', 'GH_SIM_STATE', 'GH_SIM_ORIGIN'] as const) {
    const value = world.env[key]
    if (value !== undefined) vi.stubEnv(key, value)
  }
  vi.stubEnv('OMP_WORKTREE_DIR', join(world.root, 'checkouts'))
  const principal = join(world.root, 'principal')
  git(world.origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const port: GitRunner = async (cwd, args) => {
    try {
      return { code: 0, stdout: git(cwd, args), stderr: '' }
    } catch (error) {
      return { code: 1, stdout: '', stderr: String(error) }
    }
  }
  return { principal, git: port }
}

function coverageFromHistory(read: UwRead) {
  const membership = read.admission.aggregate
  if (membership.status !== 'complete') throw new Error('Expected complete framing membership')
  const result = readFramingCoverageIntent({ uw: read.uw, histories: read.histories, membership })
  if (!result.ok || result.value === null)
    throw new Error(`Expected recorded Parent coverage: ${JSON.stringify(result)}`)
  return result.value
}

it('retains confirmed Parent framing and coverage but refuses delivery before checkout', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const result = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
  if (result.status !== 'written') throw new Error(`Expected real aggregate: ${JSON.stringify(result)}`)
  const read = await operations.readUw(result.value.root)
  const intent = coverageFromHistory(read)
  expect(intent.children.map((child) => child.scope)).toEqual(
    expect.arrayContaining(
      result.value.members.filter((member) => member.key !== 'root').map((member) => member.scope),
    ),
  )
  const world = checkoutWorld()
  const gh = async (cwd: string, args: string[]) =>
    args[0] === 'repo' && args[1] === 'view'
      ? JSON.stringify({ nameWithOwner: result.value.root.repository })
      : native.gh(cwd, args)
  const handoff = await prepareFramedFeatureHandoff({
    written: result.value,
    read,
    cwd: world.principal,
    git: world.git,
    gh,
    uw: operations,
    checkLive: async () => true,
  })
  expect(handoff).toEqual({ kind: 'blocked', reason: 'parent-delivery-suspended' })
  expect(await world.git(world.principal, ['worktree', 'list', '--porcelain'])).toMatchObject({
    code: 0,
    stdout: expect.not.stringContaining('checkouts'),
  })
  expect((await operations.readUw(result.value.root)).admission.aggregate.status).not.toBe('held')
})

it('discovers distinct nested Parent coverage from the same real aggregate without inventing accepted ancestor authority', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const input: FramingAggregateInput = closure()
  input.members.push(
    uwMember(
      { kind: 'new', key: 'nested', repository: 'acme/app' },
      'Storage migration',
      'migrated',
      'Stored requests can be migrated',
    ),
  )
  input.edges.push({ kind: 'parent-child', parent: 'foundation', child: 'nested' })
  input.coverage.push({
    parent: 'foundation',
    assignments: [{ criterion: { kind: 'new', draftKey: 'stored' }, children: ['nested'] }],
  })
  input.foundations.push({ parent: 'foundation', child: 'nested' })
  const result = await operations.frame(await prepare(operations, input), effectGuard().guard)
  if (result.status !== 'written') throw new Error(`Expected nested aggregate: ${JSON.stringify(result)}`)
  const middle = result.value.members.find((member) => member.key === 'foundation')?.scope
  const nested = result.value.members.find((member) => member.key === 'nested')?.scope
  if (!middle || !nested) throw new Error('Nested aggregate members missing')
  const rootRead = await operations.readUw(result.value.root)
  const middleRead = await operations.readUw(middle)
  const rootIntent = coverageFromHistory(rootRead)
  const middleIntent = coverageFromHistory(middleRead)
  expect(rootIntent.parent).toEqual(result.value.root)
  expect(middleIntent.parent).toEqual(middle)
  expect(middleIntent.children.map((child) => child.scope)).toEqual([nested])
})

it('keeps an actually partially written aggregate held on a fresh read before initial coverage', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const guard = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(':binding'))
  const result = await operations.frame(await prepare(operations, closure()), guard.guard)
  if (result.status !== 'partial' || result.root === null)
    throw new Error(`Expected a partial aggregate: ${JSON.stringify(result)}`)
  const read = await operations.readUw(result.root)
  expect(read.admission.aggregate).toMatchObject({ status: 'held', code: 'framing-aggregate-incomplete' })
  expect(await freshOwnSpec(result.root, read, operations)).toMatchObject({
    kind: 'blocked',
    reason: 'framing-aggregate-incomplete',
  })
  expect(native.count('sub-issue')).toBe(0)
})

it('refuses checkout mutations when the source lifetime ends during the fresh native read', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const input = closure()
  input.members.splice(1)
  input.edges = []
  input.coverage = []
  input.foundations = []
  const result = await operations.frame(await prepare(operations, input), effectGuard().guard)
  if (result.status !== 'written') throw new Error(`Expected real aggregate: ${JSON.stringify(result)}`)
  const read = await operations.readUw(result.value.root)
  const world = checkoutWorld()
  const gh = async (cwd: string, args: string[]) =>
    args[0] === 'repo' && args[1] === 'view'
      ? JSON.stringify({ nameWithOwner: result.value.root.repository })
      : native.gh(cwd, args)
  const paused = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let live = true
  const uw = {
    ...operations,
    async readUw(scope: typeof result.value.root) {
      started.resolve()
      await paused.promise
      return operations.readUw(scope)
    },
  }
  const mutations: string[][] = []
  const git: GitRunner = async (cwd, args) => {
    if (args[0] === 'fetch' || (args[0] === 'worktree' && args[1] === 'add')) mutations.push(args)
    return world.git(cwd, args)
  }
  const pending = prepareFramedFeatureHandoff({
    written: result.value,
    read,
    cwd: world.principal,
    git,
    gh,
    uw,
    checkLive: async () => live,
  })
  await started.promise
  live = false
  paused.resolve()
  expect(await pending).toMatchObject({ kind: 'blocked', reason: 'framing-handoff-revoked' })
  expect(mutations).toEqual([])
})

it('holds each claimed member after a real incomplete blocker effect', async () => {
  const native = nativeGitHub()
  native.injectFault((write) => (write.kind === 'blocked-by' ? 'reject' : null))
  const { operations } = await installed(native)
  const result = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
  if (result.status !== 'uncertain') throw new Error(`Expected incomplete aggregate: ${JSON.stringify(result)}`)
  const claims = result.effects.filter((effect) => effect.kind === 'publish-claim' && effect.status === 'confirmed')
  expect(claims).toHaveLength(3)
  for (const claim of claims) {
    if (claim.scope === null) throw new Error('A confirmed claim needs its native scope')
    const read = await operations.readUw(claim.scope)
    expect(read.admission.aggregate).toMatchObject({ status: 'held', code: 'framing-aggregate-incomplete' })
    expect(await freshOwnSpec(claim.scope, read, operations)).toMatchObject({
      kind: 'blocked',
      reason: 'framing-aggregate-incomplete',
    })
  }
})
