import { expect, test } from 'vitest'
import { calculateTier } from '../../../issue-triage/skills/shared/domain/complexity.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { parseIssueSpecBody, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { canonicalValueDigest } from '../../engine/canonical-value.ts'
import { FRAMING_PROCEDURE_FILES, type FramingInvocationBinding } from '../../engine/framing-context-schema.ts'
import type { History } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { specDigest } from '../../engine/record-digests.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { readFramingMembership } from '../../engine/uw-framing-membership.ts'
import { reconstructFramingRegistry } from '../../engine/uw-framing-registry.ts'
import type { FramingAggregateInput } from '../../engine/uw-framing-schema.ts'
import { prepareSpecAllocation, resolveSpecIdentityLedger } from '../../engine/uw-identity.ts'
import { buildFramingSpecIdentity } from '../../engine/uw-identity-events.ts'
import { fixture, UW } from '../../testing/uw-operations-fixture.ts'
import { readFixtureUw } from '../../testing/uw-operations-fixture-read.ts'
import { buildFramingSourceBinding, isPreparedFramingProposal, prepareFraming } from '../uw-framing-prepare.ts'

const repository = 'acme/example'
const commit = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const files = (Object.keys(FRAMING_PROCEDURE_FILES) as (keyof typeof FRAMING_PROCEDURE_FILES)[]).map((stage) => ({
  source: 'git-file' as const,
  repository,
  commit,
  path: `plugins/omp-build/${FRAMING_PROCEDURE_FILES[stage]}`,
  digest,
}))
const procedures = {
  format: 'omp-build-framing-procedures/1' as const,
  plugin: { name: 'omp-build' as const, version: '0.17.2', repository, commit, root: 'plugins/omp-build', files },
  procedures: [
    { stage: 'grilling' as const, file: files[0] },
    { stage: 'domain-modeling' as const, file: files[1] },
    { stage: 'codebase-design' as const, file: files[2] },
  ] as const,
}
const sections = { origin: 'Origin', context: 'Context', change: 'Change' }
function aggregate(): FramingAggregateInput {
  const acceptedArgs = 'Frame a request queue'
  return {
    kind: 'uw',
    root: 'root',
    edges: [],
    coverage: [],
    foundations: [],
    source: { kind: 'free-text', acceptedArgs, bodySha256: specDigest(acceptedArgs), repository, materials: [] },
    members: [
      {
        kind: 'uw',
        slot: { kind: 'new', key: 'root', repository },
        title: 'Request queue',
        draft: {
          criteria: [{ kind: 'new', draftKey: 'works', statement: 'The request is processed' }],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections,
        },
        factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
        tierOverride: null,
        labels: { add: [], remove: [] },
        merges: [],
        normalization: [
          {
            origin: null,
            decision: { kind: 'new', target: { kind: 'new', draftKey: 'works' }, reason: 'User requested processing' },
          },
          ...(['origin', 'context', 'change'] as const).map((section) => ({
            origin: null,
            decision: {
              kind: 'new' as const,
              target: { kind: 'section' as const, section, range: { start: 0, end: sections[section].length } },
              reason: 'Interview context',
            },
          })),
        ],
      },
    ],
  }
}
function invocation(source: FramingAggregateInput['source']): FramingInvocationBinding {
  return {
    extensionInstanceId: 'extension',
    sessionId: 'session',
    agentId: 'main',
    generation: 1,
    revision: 1,
    sourceDigest: canonicalValueDigest(source),
    procedures: {
      ...procedures,
      procedures: [procedures.procedures[0], procedures.procedures[1], procedures.procedures[2]],
      digest: canonicalValueDigest(procedures),
    },
  }
}
const ports = {
  prepareSpecAllocation,
  renderIssueSpecBody,
  calculateTier,
  async read(): Promise<never> {
    throw new Error('Unexpected existing issue read')
  },
}

test('prepares one original aggregate with engine allocated identities and refuses a changed source', async () => {
  const input = aggregate()
  const prepared = await prepareFraming(input, invocation(input.source), ports)
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) return
  expect(isPreparedFramingProposal(prepared.value)).toBe(true)
  expect(prepared.value.proposal.members[0].allocation?.assignments).toEqual([{ draftKey: 'works', id: 'C1' }])
  expect(prepared.value.proposal.members[0].renderedBody).toContain('The request is processed')
  expect(prepared.value.proposal.input.source).toEqual(input.source)
  const changed = aggregate()
  if (changed.source.kind !== 'free-text') throw new Error('Wrong source fixture')
  changed.source.acceptedArgs = 'A different request'
  const refused = await prepareFraming(changed, invocation(input.source), ports)
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.diagnostics.map((entry) => entry.code)).toContain('framing-source-mismatch')
})

test('refuses a changed procedure manifest before any native read', async () => {
  const input = aggregate()
  const binding = invocation(input.source)
  binding.procedures.digest = 'c'.repeat(64)
  const refused = await prepareFraming(input, binding, ports)
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.diagnostics.map((entry) => entry.code)).toContain('framing-procedures-invalid')
})

test('existing native root is sealed from the actual parser, ledger, graph and history cut', async () => {
  const fixtureState = fixture()
  fixtureState.state.body = ''
  let read = readFixtureUw(fixtureState.state)
  const ledger = resolveSpecIdentityLedger({
    uw: UW,
    history: read.histories[0],
    histories: read.histories,
    accepted: null,
  })
  if (!ledger.ok) throw new Error('Could not construct real empty identity ledger')
  fixtureState.state.ledger = ledger.value
  read = readFixtureUw(fixtureState.state)
  const captured = buildFramingSourceBinding(read, [])
  if (!captured.ok) throw new Error('Could not capture native issue source')
  const input = aggregate()
  const member = input.members[0]
  if (member.kind !== 'uw') throw new Error('Wrong member fixture')
  member.slot = {
    kind: 'existing',
    key: 'root',
    uw: UW,
    sourceBodySha256: captured.value.body.bodySha256,
    selection: { kind: 'command', reference: '#42' },
    observed: { nativeParent: null, children: [], blockers: [] },
  }
  input.source = captured.value
  const prepared = await prepareFraming(input, invocation(input.source), { ...ports, read: async () => read })
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) return
  expect(prepared.value.proposal.members[0].slot).toEqual(member.slot)
  expect(prepared.value.proposal.members[0].historyDigest).toBe(canonicalValueDigest(read.histories[0]))
  expect(prepared.value.proposal.members[0].nativeAnalysis?.analysis).toEqual(read.parsed.analysis)
  fixtureState.state.body = 'New work appeared after the original source capture'
  const changed = readFixtureUw(fixtureState.state)
  const refused = await prepareFraming(input, invocation(input.source), { ...ports, read: async () => changed })
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.diagnostics.map((entry) => entry.code)).toContain('framing-native-stale')
  expect(fixtureState.state.patchCount).toBe(0)
})

test('refuses an existing native child omitted from the planned aggregate', async () => {
  const fixtureState = fixture()
  fixtureState.state.body = ''
  fixtureState.state.children = [{ repository: UW.repository, number: 43 }]
  const read = readFixtureUw(fixtureState.state)
  const captured = buildFramingSourceBinding(read, [])
  if (!captured.ok) throw new Error('Could not capture native issue source')
  const input = aggregate()
  const member = input.members[0]
  if (member.kind !== 'uw') throw new Error('Wrong member fixture')
  member.slot = {
    kind: 'existing',
    key: 'root',
    uw: UW,
    sourceBodySha256: captured.value.body.bodySha256,
    selection: { kind: 'command', reference: '#42' },
    observed: {
      nativeParent: null,
      children: [{ repository: UW.repository, target: `${UW.repository}#43` }],
      blockers: [],
    },
  }
  input.source = captured.value
  const refused = await prepareFraming(input, invocation(input.source), { ...ports, read: async () => read })
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.diagnostics.map((entry) => entry.code)).toContain('framing-native-child-unplanned')
  expect(fixtureState.state.patchCount).toBe(0)
})

test('checks planned hierarchy and blockers together before sealing', async () => {
  const input = aggregate()
  const root = input.members[0]
  if (root.kind !== 'uw') throw new Error('Wrong member fixture')
  const child = structuredClone(root)
  child.slot = { kind: 'new', key: 'child', repository }
  child.title = 'Child request'
  input.members.push(child)
  input.edges.push({ kind: 'parent-child', parent: 'root', child: 'child' })
  input.coverage.push({
    parent: 'root',
    assignments: [{ criterion: { kind: 'new', draftKey: 'works' }, children: ['child'] }],
  })
  const prepared = await prepareFraming(input, invocation(input.source), ports)
  expect(prepared.ok).toBe(true)
  if (prepared.ok)
    expect(prepared.value.proposal.input.edges).toEqual([{ kind: 'parent-child', parent: 'root', child: 'child' }])
  input.edges.push({ kind: 'blocker', dependent: 'child', blocker: 'root' })
  const refused = await prepareFraming(input, invocation(input.source), ports)
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.diagnostics.map((entry) => entry.code)).toContain('framing-graph-cycle')
})

test('encoded aggregate claims remain held until result and reject conflicting root claims', async () => {
  const input = aggregate()
  const prepared = await prepareFraming(input, invocation(input.source), ports)
  if (!prepared.ok) throw new Error('Expected a genuine prepared proposal')
  const root = { repository, target: `${repository}#42` }
  const native = {
    issue: { repository, number: 42 },
    title: 'Request queue',
    body: '',
    updatedAt: '2026-10-27T12:00:00.000Z',
    nativeState: { state: 'OPEN' as const, stateReason: null },
    labels: [],
    parent: null,
    children: [],
    blockers: [],
  }
  const confirmation = {
    route: 'omp-native-command' as const,
    operationId: prepared.value.proposal.operationId,
    proposalDigest: prepared.value.digest,
    confirmedAt: '2026-10-27T12:00:00.000Z',
  }
  // GitHub-native comment metadata uses second precision; UI evidence may retain milliseconds.
  const nativeTime = '2026-10-27T12:00:00Z'
  const make = (
    recordId: string,
    payload: import('../../engine/uw-framing-receipt-schema.ts').FramingReceiptPayload,
  ): CanonicalRecord => {
    const result = buildRecord({
      version: 1,
      ...root,
      recordId,
      runId: 'frame-run',
      operationId: recordId,
      kind: 'framing-receipt',
      payload,
    })
    if (!result.ok) throw new Error(`Cannot build fixture: ${JSON.stringify(result.diagnostics)}`)
    return result.value
  }
  const intent = make('frame-intent', {
    format: 'omp-build-framing-receipt/1',
    phase: 'intent',
    root,
    proposal: prepared.value.proposal,
    proposalDigest: prepared.value.digest,
    confirmation,
    native,
  })
  const intentRef = { kind: 'framing-receipt' as const, recordId: intent.recordId, scope: root }
  const member = prepared.value.proposal.members[0]
  const claimPayload = {
    format: 'omp-build-framing-receipt/1' as const,
    phase: 'member-claim' as const,
    intent: intentRef,
    member: member.key,
    ordinal: member.ordinal,
    memberDigest: member.memberDigest,
    scope: root,
    slot: 'new' as const,
    binding: null,
    native,
  }
  const claim = make('frame-claim', claimPayload)
  const decode = (records: readonly CanonicalRecord[]) => {
    const comments: History['comments'] = records.flatMap((record, index) => {
      const encoded = encodeParts(record, record.kind, 65_536)
      if (!encoded.ok) throw new Error(`Cannot encode fixture: ${JSON.stringify(encoded.diagnostics)}`)
      return encoded.value.map((body, part) => ({
        locator: `comment-${index}-${part}`,
        nativeId: `${index * 10 + part + 1}`,
        body,
        author: 'operator',
        createdAt: nativeTime,
        updatedAt: nativeTime,
      }))
    })
    const decoded = decodeHistory({
      scope: root,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      comments,
      diagnostics: [],
    })
    if (decoded.operations.some((operation) => operation.status !== 'complete'))
      throw new Error(`Unreadable native fixture: ${JSON.stringify(decoded)}`)
    return decoded
  }
  const history = decode([intent, claim])
  const graph = { ...readFixtureUw(fixture().state).graph, root }
  expect(
    readFramingMembership({ uw: root, histories: [history], graph, accepted: { status: 'absent' } }),
  ).toMatchObject({ status: 'held', code: 'framing-aggregate-incomplete' })
  const duplicate = make('frame-claim-duplicate', claimPayload)
  expect(reconstructFramingRegistry(decode([intent, claim, duplicate]), intentRef)).toMatchObject({ ok: false })
  if (!member.allocation) throw new Error('Expected allocated UW member')
  const claimRef = { kind: 'framing-receipt' as const, recordId: claim.recordId, scope: root }
  const authorization = {
    kind: 'framing-member' as const,
    intent: intentRef,
    claim: claimRef,
    binding: claimRef,
    member: member.key,
    memberDigest: member.memberDigest,
    confirmation,
  }
  const identityDraft = buildFramingSpecIdentity({
    uw: root,
    histories: [history],
    authorization,
    plan: member.allocation,
    predecessor: null,
    event: 'allocate',
    operationId: 'frame-identity',
  })
  if (!identityDraft.ok) throw new Error(`Cannot authorize real identity: ${JSON.stringify(identityDraft.diagnostics)}`)
  const identity = buildRecord(identityDraft.value)
  if (!identity.ok) throw new Error(`Cannot build real identity: ${JSON.stringify(identity.diagnostics)}`)
  const withIdentity = decode([intent, claim, identity.value])
  const ledger = resolveSpecIdentityLedger({
    uw: root,
    history: withIdentity,
    histories: [withIdentity],
    accepted: null,
  })
  expect(ledger.ok).toBe(true)
  if (ledger.ok) expect([...ledger.value.allocations.keys()]).toContain('C1')
  if (graph.status !== 'complete' || member.tier === null) throw new Error('Expected complete graph and tier')
  const raw = {
    reference: root.target,
    body: member.renderedBody,
    bodySha256: specDigest(member.renderedBody),
    lastEditedAt: null,
  }
  const parsed = parseIssueSpecBody({ uw: root, raw })
  if (parsed.status !== 'conformant') throw new Error('Expected rendered canonical Spec')
  const identities = [{ kind: 'spec-identity' as const, recordId: identity.value.recordId, scope: root }]
  const resultPayload = {
    format: 'omp-build-framing-receipt/1' as const,
    phase: 'result' as const,
    intent: intentRef,
    claims: [claimRef],
    bindings: [claimRef],
    identities,
    members: [
      {
        key: member.key,
        scope: root,
        memberDigest: member.memberDigest,
        binding: claimRef,
        snapshot: parsed.snapshot,
        tier: member.tier,
      },
    ],
    edges: [],
    coverage: [],
    graphDigest: canonicalValueDigest([]),
    identityDigest: canonicalValueDigest(identities),
  }
  const completedGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      uw: root,
      title: input.members[0].title,
      raw,
      labels: [`size:${member.tier}`],
      parent: null,
      children: [],
      blockers: [],
    })),
  }
  const resultRecord = make('frame-result', resultPayload)
  const completeHistory = decode([intent, claim, identity.value, resultRecord])
  expect(
    readFramingMembership({
      uw: root,
      histories: [completeHistory],
      graph: completedGraph,
      accepted: { status: 'absent' },
    }),
  ).toMatchObject({ status: 'complete' })
  const changedResult = make('frame-result-changed', { ...resultPayload, graphDigest: 'd'.repeat(64) })
  expect(
    readFramingMembership({
      uw: root,
      histories: [decode([intent, claim, identity.value, changedResult])],
      graph: completedGraph,
      accepted: { status: 'absent' },
    }),
  ).toMatchObject({ status: 'held', code: 'framing-result-drift' })
  const tampered = buildFramingSpecIdentity({
    uw: root,
    histories: [history],
    authorization: { ...authorization, confirmation: { ...confirmation, proposalDigest: 'c'.repeat(64) } },
    plan: member.allocation,
    predecessor: null,
    event: 'allocate',
    operationId: 'tampered-identity',
  })
  expect(tampered.ok).toBe(false)
  const wrongNative = make('frame-claim-wrong-native', {
    ...claimPayload,
    native: { ...native, issue: { repository, number: 43 } },
  })
  expect(reconstructFramingRegistry(decode([intent, wrongNative]), intentRef)).toMatchObject({ ok: false })
})

test('refuses unresolved accepted authority even without a mandate claim', async () => {
  const fixtureState = fixture({ acceptedRefused: true })
  fixtureState.state.body = ''
  const read = readFixtureUw(fixtureState.state)
  const captured = buildFramingSourceBinding(read, [])
  if (!captured.ok) throw new Error('Could not capture native issue source')
  const input = aggregate()
  const member = input.members[0]
  if (member.kind !== 'uw') throw new Error('Wrong member fixture')
  member.slot = {
    kind: 'existing',
    key: 'root',
    uw: UW,
    sourceBodySha256: captured.value.body.bodySha256,
    selection: { kind: 'command', reference: '#42' },
    observed: { nativeParent: null, children: [], blockers: [] },
  }
  input.source = captured.value
  const refused = await prepareFraming(input, invocation(input.source), { ...ports, read: async () => read })
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.diagnostics.map((entry) => entry.code)).toContain('framing-slot-authority')
  expect(fixtureState.state.patchCount).toBe(0)
})
