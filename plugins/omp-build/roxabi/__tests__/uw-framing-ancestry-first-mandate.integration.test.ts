import { afterEach, expect, it, vi } from 'vitest'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { recordsOf } from '../../dist/contracts.js'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
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
import { buildFramingSourceBinding } from '../uw-framing-prepare.ts'
import { continueFeature } from '../workflow.ts'
import { answeredQuestion, begun, codes as formCodes, submit } from './feature-framing-controller-drivers.ts'
import { world, writtenBoundary } from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

async function childInput(operations: UwOperations, parent: number | null) {
  const read = await operations.readUw(scope(42))
  const source = buildFramingSourceBinding(read, [])
  if (!source.ok) throw new Error(JSON.stringify(source.diagnostics))
  const input = closure()
  input.source = source.value
  input.members = [
    uwMember(
      {
        kind: 'existing',
        key: 'root',
        uw: scope(42),
        sourceBodySha256: bodySha(read, 42),
        selection: { kind: 'command', reference: '#42' },
        observed: { nativeParent: parent === null ? null : scope(parent), children: [], blockers: [] },
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

function github(native: ReturnType<typeof nativeGitHub>): Gh {
  return async (cwd, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    if (args[0] === 'pr' && args[1] === 'list') return '[]'
    return native.gh(cwd, args)
  }
}

it('frames the unmandated Parent and native child through feature before the Parent first Mandate', async () => {
  const base = writtenBoundary()
  const native = nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Queue storage', parent: 41 } })
  const boundary = { ...base, native }
  const framing = await installed(native)
  const childOnly = await childInput(framing.operations, 41)
  const refused = await framing.operations.prepareFraming(childOnly, invocation(childOnly.source))
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(codes(refused.diagnostics)).toContain('framing-ancestor-unqualified')
  expect(framing.confirmations()).toBe(0)
  expect(native.writes).toEqual([])
  const selection = await continueFeature({
    cwd: boundary.principal,
    reference: scope(41).target,
    control: 'select',
    principal: true,
    gh: github(native),
    git: boundary.git,
    uw: framing.operations,
  })
  expect(selection).toEqual({ kind: 'framing', source: { kind: 'issue', uw: scope(41) } })
  const input = await existingRootAggregate(framing.operations)
  const w = world({ written: boundary })
  await begun(w, { kind: 'issue', uw: scope(41) })
  const grill = await answeredQuestion(w, 'parent-grill')
  expect(
    (
      await submit(w, {
        kind: 'grilling',
        shape: 'parent',
        unresolved: [],
        decisions: [grill],
        terms: [],
      })
    ).status,
  ).toBe('accepted')
  const domain = await answeredQuestion(w, 'parent-domain')
  expect(
    (
      await submit(w, {
        kind: 'terminology',
        unresolved: [],
        decisions: [domain],
        terms: [],
      })
    ).status,
  ).toBe('accepted')
  const design = await answeredQuestion(w, 'parent-design')
  expect(
    (
      await submit(w, {
        kind: 'module-design',
        unresolved: [],
        decisions: [design],
        modules: [],
      })
    ).status,
  ).toBe('accepted')
  const members = input.members.map((member) => ({
    ...member,
    slot:
      member.slot.key === 'root'
        ? { kind: 'selected', key: 'root' }
        : { kind: 'native-child', key: 'child', parent: 'root', reference: '#42' },
  }))
  const staged = await submit(w, {
    kind: 'proposal',
    decisions: [],
    modules: [],
    vocabulary: [],
    aggregate: { kind: 'uw', root: 'root', members, edges: input.edges, coverage: input.coverage, foundations: [] },
  })
  expect(formCodes(staged)).toEqual(['framing-proposal-staged'])
  w.runtime.idle = true
  w.runtime.answers.push(true)
  await w.controller.act(w.ctx())
  const move = w.controller.view()?.pendingMove
  if (!move) throw new Error(`Expected Parent framing handoff: ${w.statuses.at(-1)}`)
  expect(move.root).toEqual(scope(41))
  expect((await framing.operations.readUw(scope(41))).admission.aggregate.status).toBe('complete')
  expect((await framing.operations.readUw(scope(42))).admission.aggregate.status).toBe('complete')
  expect((await framing.operations.readUw(scope(42))).accepted.status).toBe('absent')
  expect(native.issues.get(42)?.parent).toBe(41)
  w.location.cwd = move.destination
  w.runtime.answers.push(true)
  await w.controller.act(w.ctx())
  expect(w.continued).toEqual([expect.objectContaining({ reference: scope(41).target, control: 'continue' })])
  // The confirmed coverage is consumed by the first Mandate: no second coverage request follows it.
  expect(w.outcomes).not.toContainEqual(expect.objectContaining({ reason: expect.stringMatching(/^parent-coverage/) }))
  // The next ordinary Parent stop is the epic driver, which this fixture gives no driver effects.
  expect(w.outcomes).toContainEqual(expect.objectContaining({ kind: 'blocked', reason: 'epic-step-failed' }))
  const parent = await framing.operations.readUw(scope(41))
  if (parent.accepted.status !== 'accepted') throw new Error('Expected the Parent first Mandate')
  expect(parent.accepted.value.coverage?.assignments.flatMap((assignment) => assignment.children)).toContainEqual(
    scope(42),
  )
  expect((await framing.operations.readUw(scope(42))).accepted.status).toBe('absent')
  const own = parent.histories.find((history) => history.source.scope.target === scope(41).target)
  expect(own && recordsOf(own).some((record) => record.kind === 'mandate')).toBe(true)
})

/** Fixture-scoped ancestor acceptance matches the child's real, independently planned spec and tier. */
async function acceptedAncestor() {
  const example = sisterSpecWorld(true)
  if (!example.parentMandate) throw new Error('Missing parent fixture')
  const native = nativeGitHub({
    41: { title: 'Parent', body: example.parentBody, labels: ['size:F-lite'] },
    42: { title: 'Request queue' },
  })
  const subject = await installed(native)
  const input = await childInput(subject.operations, null)
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
    if (ref.kind !== 'spec-identity') throw new Error('Expected ancestor identity')
    return { ...ref, kind: ref.kind }
  })
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
  async function post(number: number, body: string) {
    await native.gh('/fixture', [
      'api',
      '--method',
      'POST',
      `repos/acme/app/issues/${number}/comments`,
      '--raw-field',
      `body=${body}`,
    ])
  }
  for (const body of fixtures.framedBodies([parent], 'automation')) await post(41, body)
  const identity = fixtures.identityAllocation(scope(42))
  const encoded = encodeParts(identity, identity.kind, 65_536)
  if (!encoded.ok) throw new Error('Cannot encode the fixture identity')
  for (const body of encoded.value) await post(42, body)
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
  return { native, input, parent, operations: subject.operations }
}

it('carries the matching accepted ancestor into the child first Mandate', async () => {
  const boundary = writtenBoundary()
  const { native, input, parent, operations } = await acceptedAncestor()
  const prepared = await prepare(operations, input)
  expect(prepared.proposal.members[0].inherited).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        uw: scope(41),
        sourceAccepted: expect.objectContaining({ recordId: parent.recordId }),
      }),
    ]),
  )
  const framed = await operations.frame(prepared, effectGuard().guard)
  if (framed.status !== 'written') throw new Error(`Expected complete child framing: ${JSON.stringify(framed)}`)
  const before = await operations.readUw(scope(42))
  expect(before.admission.aggregate).toMatchObject({ status: 'complete' })
  expect(before.accepted.status).toBe('absent')
  const parentRead = await operations.readUw(scope(41))
  if (parentRead.accepted.status !== 'accepted') throw new Error('Fixture ancestor is not accepted')
  const acceptedRef = parentRead.accepted.value.ref
  const continuation = {
    cwd: boundary.principal,
    reference: scope(42).target,
    control: 'continue' as const,
    principal: true,
    gh: github(native),
    git: boundary.git,
    uw: operations,
  }
  const move = await continueFeature(continuation)
  if (move.kind !== 'session-cwd') throw new Error(`Expected Parent checkout handoff: ${JSON.stringify(move)}`)
  // Model the operator selecting the child's branch inside the canonical Parent worktree.
  const checkout = await boundary.git(move.path, ['checkout', '-b', 'feat/42-request-queue'])
  expect(checkout.code, checkout.stderr).toBe(0)
  const result = await continueFeature({ ...continuation, cwd: move.path, principal: false })
  expect(result).toMatchObject({ kind: 'blocked', reason: 'plugin-pin-unavailable' })
  const after = await operations.readUw(scope(42))
  expect(after.accepted.status).toBe('accepted')
  const own = after.histories.find((history) => history.source.scope.target === scope(42).target)
  const mandates = own ? recordsOf(own).filter((record) => record.kind === 'mandate') : []
  expect(mandates).toHaveLength(1)
  const mandate = mandates[0]
  if (mandate?.kind !== 'mandate') throw new Error('Expected the real first child Mandate')
  expect(mandate.payload.inheritedOwnSpecRefs).toEqual([acceptedRef, ...parentRead.accepted.value.inheritedOwnSpecRefs])
  expect(mandate.payload.parent).toEqual({ scope: scope(41), kind: 'mandate', recordId: parent.recordId })
})
