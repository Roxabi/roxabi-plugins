import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { FramingAggregateInput } from '../engine/uw-framing-schema.ts'
import { dispose, git, sandbox } from '../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { nativeGitHub } from '../testing/framing-native-github.ts'
import { closure, effectGuard, installed, numberOf, prepare, uwMember } from '../testing/framing-runtime-fixture.ts'
import { resolveFeatureAuthority } from './feature-continuation-admission.ts'
import { selectFeatureMandate } from './feature-continuation-selection.ts'
import { discoverFramingCoverageIntent, resolveFramingCoverageIntent } from './feature-framing-coverage.ts'
import { prepareFramedFeatureHandoff, verifyFramedFeatureDestination } from './feature-framing-handoff.ts'
import { freshOwnSpec } from './feature-initial-own-spec.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
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

it('carries a real completed Parent aggregate and its exact coverage into the canonical destination', async () => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const result = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
  if (result.status !== 'written') throw new Error(`Expected real aggregate: ${JSON.stringify(result)}`)
  const read = await operations.readUw(result.value.root)
  const intent = discoverFramingCoverageIntent(result.value.root, read)
  if ('kind' in intent || intent.intent === null)
    throw new Error(`Expected recorded Parent coverage: ${JSON.stringify(intent)}`)
  const pair = await resolveFramingCoverageIntent({ uw: result.value.root, read, intent: intent.intent })
  if ('kind' in pair) throw new Error(`Expected approved coverage: ${JSON.stringify(pair)}`)
  expect(pair.coverage.assignments[0]?.children).toEqual(
    expect.arrayContaining(
      result.value.members.filter((member) => member.key !== 'root').map((member) => member.scope),
    ),
  )
  const own = await freshOwnSpec(result.value.root, read, operations, pair.coverage, pair.basis)
  if ('kind' in own) throw new Error(`Expected current Parent facts: ${JSON.stringify(own)}`)
  expect(own.children.map((child) => child.scope)).toEqual(
    expect.arrayContaining(pair.coverage.assignments[0]?.children ?? []),
  )
  expect(own.ownSpec.identityAllocations.length).toBeGreaterThan(0)
  const staleBasis = {
    ...pair.basis,
    criteria: pair.basis.criteria.map((criterion) => ({ ...criterion, statement: `${criterion.statement} changed` })),
  }
  expect(await freshOwnSpec(result.value.root, read, operations, pair.coverage, staleBasis)).toMatchObject({
    kind: 'blocked',
    reason: 'parent-coverage-intent-changed',
  })
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
  if ('kind' in handoff) throw new Error(`Expected checkout preparation: ${JSON.stringify(handoff)}`)
  expect(handoff.checkout).toMatchObject({ status: 'move', path: handoff.destination })
  expect(handoff.coverage).toEqual(pair.coverage)
  expect(handoff.basis).toEqual(pair.basis)
  expect(
    await verifyFramedFeatureDestination({
      ticket: handoff,
      read,
      cwd: world.principal,
      git: world.git,
      gh,
      uw: operations,
    }),
  ).toMatchObject({ kind: 'blocked', reason: 'session-not-intended-worktree' })
  const continued = await verifyFramedFeatureDestination({
    ticket: handoff,
    read: await operations.readUw(result.value.root),
    cwd: handoff.destination,
    git: world.git,
    gh,
    uw: operations,
  })
  if ('kind' in continued) throw new Error(`Expected exact destination continuation: ${JSON.stringify(continued)}`)
  expect(continued.continuation).toMatchObject({
    cwd: handoff.destination,
    reference: result.value.root.target,
    control: 'continue',
    parentCoverage: pair.coverage,
    parentCoverageBasis: pair.basis,
  })
  const issue = native.issues.get(numberOf(result.value.root))
  if (!issue) throw new Error('Missing real native root')
  issue.title += ' changed after the handoff'
  expect(
    await verifyFramedFeatureDestination({
      ticket: handoff,
      read: await operations.readUw(result.value.root),
      cwd: handoff.destination,
      git: world.git,
      gh,
      uw: operations,
    }),
  ).toMatchObject({ kind: 'blocked', reason: 'framing-handoff-changed' })
  issue.title = issue.title.slice(0, -' changed after the handoff'.length)
  const authority = await resolveFeatureAuthority(continued.continuation)
  if ('kind' in authority) throw new Error(`Expected destination authority: ${JSON.stringify(authority)}`)
  const selected = await selectFeatureMandate(
    'continue',
    undefined,
    authority,
    operations,
    operations,
    pair.coverage,
    pair.basis,
  )
  if ('kind' in selected) throw new Error(`Expected same-UW continuation: ${JSON.stringify(selected)}`)
  expect(selected.authority.scope).toEqual(result.value.root)
  expect(selected.mandate?.payload.coverage).toEqual(pair.coverage)
  expect((await operations.readUw(result.value.root)).accepted.status).toBe('accepted')
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
  const rootIntent = discoverFramingCoverageIntent(result.value.root, rootRead)
  const middleIntent = discoverFramingCoverageIntent(middle, middleRead)
  if ('kind' in rootIntent || rootIntent.intent === null || 'kind' in middleIntent || middleIntent.intent === null)
    throw new Error('Both Parent intents must be discoverable from the authenticated result')
  expect(rootIntent.intent.parent).toEqual(result.value.root)
  expect(middleIntent.intent.parent).toEqual(middle)
  expect(middleIntent.intent.children.map((child) => child.scope)).toEqual([nested])
  expect(await resolveFramingCoverageIntent({ uw: middle, read: middleRead, intent: rootIntent.intent })).toMatchObject(
    { kind: 'blocked', reason: 'parent-coverage-intent-changed' },
  )
  expect(
    await resolveFramingCoverageIntent({ uw: middle, read: middleRead, intent: middleIntent.intent }),
  ).toMatchObject({ kind: 'blocked' })
  const world = checkoutWorld()
  const gh = async (cwd: string, args: string[]) =>
    args[0] === 'repo' && args[1] === 'view'
      ? JSON.stringify({ nameWithOwner: result.value.root.repository })
      : native.gh(cwd, args)
  const ticket = await prepareFramedFeatureHandoff({
    written: result.value,
    read: rootRead,
    cwd: world.principal,
    git: world.git,
    gh,
    uw: operations,
    checkLive: async () => true,
  })
  if ('kind' in ticket) throw new Error(`Expected canonical Parent checkout: ${JSON.stringify(ticket)}`)
  const destination = await verifyFramedFeatureDestination({
    ticket,
    read: await operations.readUw(result.value.root),
    cwd: ticket.destination,
    git: world.git,
    gh,
    uw: operations,
  })
  if ('kind' in destination) throw new Error(`Expected destination: ${JSON.stringify(destination)}`)
  const authority = await resolveFeatureAuthority(destination.continuation)
  if ('kind' in authority) throw new Error(`Expected Parent authority: ${JSON.stringify(authority)}`)
  const selected = await selectFeatureMandate(
    'continue',
    undefined,
    authority,
    operations,
    operations,
    ticket.coverage,
    ticket.basis,
  )
  if ('kind' in selected) throw new Error(`Expected accepted Parent: ${JSON.stringify(selected)}`)
  const updated = await operations.readUw(middle)
  const nestedPair = await resolveFramingCoverageIntent({ uw: middle, read: updated, intent: middleIntent.intent })
  if ('kind' in nestedPair)
    throw new Error(`Expected nested approved coverage after parent acceptance: ${JSON.stringify(nestedPair)}`)
  expect(nestedPair.basis.inheritedOwnSpecRefs.map((ref) => ref.uw)).toEqual([result.value.root])
  expect(nestedPair.coverage.parent.uw).toEqual(middle)
  expect(await resolveParentWorktreeAnchor({ subject: middle, read: updated })).toEqual({
    ok: true,
    anchor: result.value.root,
  })
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
  const result = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
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
