import { expect, test } from 'vitest'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import {
  bodySha,
  closure,
  effectGuard,
  installed,
  invocation,
  prepare,
  scope,
  uwMember,
} from '../../testing/framing-runtime-fixture.ts'
import { sisterSpecWorld } from '../../testing/multi-sister-spec-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { UwOperationResult } from '../uw-contract.ts'
import { buildFramingSourceBinding } from '../uw-framing-prepare.ts'

function captureSubjectMutations(gh: Gh) {
  const attempts: string[][] = []
  const observed: Gh = async (cwd, args) => {
    const methodIndex = args.findIndex((arg) => arg === '--method' || arg === '-X')
    const method = methodIndex < 0 ? null : args[methodIndex + 1]?.toUpperCase()
    const graphql = args[0] === 'api' && args[1] === 'graphql'
    const graphMutation = graphql && args.some((arg) => /^query=\s*mutation\b/.test(arg))
    const implicitPost =
      args[0] === 'api' &&
      !graphql &&
      method === null &&
      args.some((arg) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(arg))
    if (
      (method !== null && method !== undefined && method !== 'GET' && method !== 'HEAD') ||
      graphMutation ||
      implicitPost ||
      (args[0] === 'issue' && ['create', 'edit', 'close', 'reopen', 'delete', 'comment'].includes(args[1]))
    )
      attempts.push([...args])
    return gh(cwd, args)
  }
  return { gh: observed, attempts }
}

async function externalComment(gh: Gh, issue: number, body: string) {
  const response = await gh('/fixture', [
    'api',
    '--method',
    'POST',
    `repos/acme/app/issues/${issue}/comments`,
    '--raw-field',
    `body=${body}`,
  ])
  return JSON.parse(response) as { id: number; body: string }
}

test('an own conflict present before the intent recheck cannot disappear across a deleted comment boundary', async () => {
  const native = nativeGitHub({ 41: { title: 'Request queue' } })
  const comments = native.comments.get(41)
  if (!comments) throw new Error('Missing root comments')
  for (let i = 0; i < 100; i++) await externalComment(native.gh, 41, `External padding ${i + 1}`)
  const conflict = roxabiWorkflowFixtures().featureMandate(scope(41), {
    recordId: 'concurrent-mandate',
    operationId: 'concurrent-mandate-operation',
  })
  const encoded = encodeParts(conflict, conflict.kind, 65_536)
  if (!encoded.ok || encoded.value.length !== 1) throw new Error('The external conflict must occupy one comment')
  let conflictId: number | null = null
  let confirmed = false
  let seeded = false
  let nextReadStarted = false
  let firstPage: number[] | null = null
  let boundary: { before: number[]; after: number[]; returned: number[] } | null = null
  const readFirstPage: Gh = async (cwd, args) => {
    if (comments.length !== 101 || comments[100].id !== conflictId)
      throw new Error('Conflict was not present at the start of the recheck')
    const response = await native.gh(cwd, args)
    firstPage = (JSON.parse(response) as { id: number }[]).map((item) => item.id)
    return response
  }
  const readBoundary: Gh = async (cwd, args) => {
    const before = comments.map((item) => item.id)
    comments.shift()
    const response = await native.gh(cwd, args)
    boundary = {
      before,
      after: comments.map((item) => item.id),
      returned: (JSON.parse(response) as { id: number }[]).map((item) => item.id),
    }
    return response
  }
  const readSecondPage: Gh = async (cwd, args) => {
    if (!seeded) {
      const response = await native.gh(cwd, args)
      conflictId = (await externalComment(native.gh, 41, encoded.value[0])).id
      seeded = true
      return response
    }
    if (nextReadStarted && firstPage !== null && boundary === null) return readBoundary(cwd, args)
    return native.gh(cwd, args)
  }
  const gh: Gh = async (cwd, args) => {
    const endpoint = args[1]
    if (confirmed && seeded && endpoint === 'graphql' && args.includes('number=41')) nextReadStarted = true
    if (
      confirmed &&
      nextReadStarted &&
      endpoint === 'repos/acme/app/issues/41/comments?per_page=100&page=1' &&
      firstPage === null
    )
      return readFirstPage(cwd, args)
    if (confirmed && endpoint === 'repos/acme/app/issues/41/comments?per_page=100&page=2')
      return readSecondPage(cwd, args)
    return native.gh(cwd, args)
  }
  const subject = captureSubjectMutations(gh)
  const { operations, confirmations } = await installed(
    { ...native, gh: subject.gh },
    {
      onConfirm: () => {
        confirmed = true
      },
    },
  )
  const read = await operations.readUw(scope(41))
  const source = buildFramingSourceBinding(read, [])
  if (!source.ok) throw new Error(`Cannot capture the real source: ${JSON.stringify(source.diagnostics)}`)
  const input = closure()
  input.source = source.value
  input.members = [
    uwMember(
      {
        kind: 'existing',
        key: 'root',
        uw: scope(41),
        sourceBodySha256: bodySha(read, 41),
        selection: { kind: 'command', reference: '#41' },
        observed: { nativeParent: null, children: [], blockers: [] },
      },
      'Request queue',
      'works',
      'Requests are processed in order',
    ),
  ]
  input.edges = []
  input.coverage = []
  input.foundations = []
  const { guard, points } = effectGuard()
  const result = await operations.frame(await prepare(operations, input), guard)

  expect(confirmations()).toBe(1)
  expect(firstPage).toEqual(Array.from({ length: 100 }, (_, i) => i + 101))
  expect(boundary).toEqual({
    before: Array.from({ length: 101 }, (_, i) => i + 101),
    after: Array.from({ length: 100 }, (_, i) => i + 102),
    returned: [],
  })
  expect(conflictId).toBe(201)
  expect(comments.some((comment) => comment.id === conflictId && comment.body === encoded.value[0])).toBe(true)
  expect(subject.attempts, JSON.stringify({ result, points, attempts: subject.attempts })).toEqual([])
  expect(result.status).toBe('refused')
  expect(result.effects).toEqual([])
  expect(points.filter((point) => point.at === 'before-effect')).toEqual([])
  expect(native.count('comment')).toBe(101)
  expect(native.writes.filter((write) => write.kind !== 'comment')).toEqual([])
})

test('revoking an authenticated inherited mandate before the post-confirmation check holds without effects', async () => {
  const example = sisterSpecWorld(true)
  if (!example.parentMandate) throw new Error('Missing accepted parent fixture')
  const native = nativeGitHub({
    41: { title: 'Parent', body: example.parentBody, labels: ['size:F-lite'] },
    42: { title: 'Request queue' },
  })
  const subject = captureSubjectMutations(native.gh)
  const { operations, confirmations } = await installed({ ...native, gh: subject.gh })
  const actor = captureSubjectMutations(native.gh)
  const concurrent = await installed({ ...native, gh: actor.gh })
  const original = await operations.readUw(scope(42))
  const originalSource = buildFramingSourceBinding(original, [])
  if (!originalSource.ok) throw new Error('Cannot capture the original child')
  const input = closure()
  input.source = originalSource.value
  input.members = [
    uwMember(
      {
        kind: 'existing',
        key: 'root',
        uw: scope(42),
        sourceBodySha256: bodySha(original, 42),
        selection: { kind: 'command', reference: '#42' },
        observed: { nativeParent: null, children: [], blockers: [] },
      },
      'Request queue',
      'works',
      'Requests are processed in order',
    ),
  ]
  input.edges = []
  input.coverage = []
  input.foundations = []
  const standalone = await prepare(operations, input)
  const planned = standalone.proposal.members[0]
  if (!planned.allocation || !planned.tier) throw new Error('Missing planned child specification')
  const parsed = parseIssueSpecBody({
    uw: scope(42),
    raw: rawSource(scope(42).target, planned.renderedBody, '2026-10-27T12:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error('Planned child body is not a conformant native specification')
  const fixtures = roxabiWorkflowFixtures()
  const ownSpec = example.parentMandate.payload.ownSpec
  const identityAllocations = ownSpec.identityAllocations.map((ref) => {
    if (ref.kind !== 'spec-identity') throw new Error('Ancestor allocation must reference a spec identity')
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
  const child = native.issues.get(42)
  if (!child) throw new Error('Missing inherited native child')
  for (const body of fixtures.framedBodies([parent], 'automation')) await externalComment(native.gh, 41, body)
  const identity = fixtures.identityAllocation(scope(42))
  const identityBody = encodeParts(identity, identity.kind, 65_536)
  if (!identityBody.ok || identityBody.value.length !== 1) throw new Error('Missing native child identity')
  await externalComment(native.gh, 42, identityBody.value[0])
  child.parent = 41
  child.body = planned.renderedBody
  child.labels = [`size:${planned.tier}`]
  const inherited = await operations.readUw(scope(42))
  const parentRead = await inherited.observedReader?.readUw(scope(41))
  if (parentRead?.accepted.status !== 'accepted' || !parentRead.admission.deliverable.ok)
    throw new Error(`Ancestor is not current and deliverable: ${JSON.stringify(parentRead?.admission)}`)
  const source = buildFramingSourceBinding(inherited, [])
  if (!source.ok) throw new Error(`Cannot capture inherited source: ${JSON.stringify(source.diagnostics)}`)
  input.source = source.value
  const member = input.members[0]
  if (member.kind !== 'uw' || member.slot.kind !== 'existing') throw new Error('Expected existing UW child')
  member.slot.observed.nativeParent = scope(41)
  member.slot.sourceBodySha256 = bodySha(inherited, 42)
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
  const preparedResult = await operations.prepareFraming(input, invocation(input.source))
  if (!preparedResult.ok)
    throw new Error(`Cannot prepare inherited framing: ${JSON.stringify(preparedResult.diagnostics)}`)
  const prepared = preparedResult.value
  expect(prepared.proposal.members[0].inherited).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        uw: scope(41),
        sourceAccepted: expect.objectContaining({ recordId: parent.recordId }),
      }),
    ]),
  )
  const { guard: baseGuard, points } = effectGuard()
  let confirmationChecks = 0
  let abandonment: UwOperationResult | null = null
  const guard: typeof baseGuard = {
    async check(point) {
      await baseGuard.check(point)
      if (point.at === 'confirmation' && ++confirmationChecks === 2) {
        abandonment = await concurrent.operations.abandon(scope(41), {
          scope: scope(41),
          recordId: parent.recordId,
          kind: 'mandate',
        })
      }
    },
  }
  const result = await operations.frame(prepared, guard)
  expect(confirmations()).toBe(1)
  expect(confirmationChecks).toBe(2)
  expect(abandonment, JSON.stringify(abandonment)).toMatchObject({ status: 'abandoned' })
  expect(actor.attempts.some((args) => args.includes('POST'))).toBe(true)
  expect(subject.attempts, JSON.stringify({ result, points, attempts: subject.attempts })).toEqual([])
  expect(result.status).toBe('refused')
  expect(result.effects).toEqual([])
  expect(points.filter((point) => point.at === 'before-effect')).toEqual([])
})
