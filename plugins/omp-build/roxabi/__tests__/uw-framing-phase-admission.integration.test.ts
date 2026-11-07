import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import type { Scope } from '../../engine/record-values.ts'
import { assessUwAdmission } from '../../engine/uw-admission.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import { closure, effectGuard, installed, numberOf, prepare, scope } from '../../testing/framing-runtime-fixture.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { UwOperations, UwRead } from '../uw-contract.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

const phases = ['delivery-transition', 'landing'] as const

function admission(read: UwRead, phase: (typeof phases)[number], histories = read.histories, graph = read.graph) {
  if (!read.identity.ok) throw new Error(`Expected real identity ledger: ${JSON.stringify(read.identity.diagnostics)}`)
  return assessUwAdmission({
    phase,
    uw: read.uw,
    graph,
    histories,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    catalogues: read.catalogues,
    completion: read.completion,
    currentChildren: { ok: true, value: [] },
  })
}

async function acceptedMember(operations: UwOperations, gh: Gh, uw: Scope) {
  const before = await operations.readUw(uw)
  if (
    before.parsed.status !== 'conformant' ||
    !before.identity.ok ||
    before.identity.value.head?.kind !== 'spec-identity'
  )
    throw new Error('Expected a framed snapshot and identity')
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(uw, {
    recordId: 'phase-admission-mandate',
    operationId: 'phase-admission-mandate-op',
    body: before.parsed.snapshot.raw.body,
    ownSpec: {
      ...fixtures.ownSpecFromSnapshot(uw, before.parsed.snapshot),
      identityAllocations: [{ ...before.identity.value.head, kind: 'spec-identity' }],
    },
  })
  const own = before.histories.find((history) => history.source.scope.target === uw.target)
  if (!own) throw new Error('Missing member history')
  const external = before.histories.filter((history) => history !== own)
  const encoded = encodeCriterionRecords([mandate], uw, roxabiRecordFixtures().projection, 'automation', external, own)
  for (const comment of encoded.comments) {
    await gh('/fixture', [
      'api',
      '--method',
      'POST',
      `repos/acme/app/issues/${numberOf(uw)}/comments`,
      '--raw-field',
      `body=${comment.body}`,
    ])
  }
  const read = await operations.readUw(uw)
  if (read.accepted.status !== 'accepted')
    throw new Error(`Expected accepted Mandate from installed reader: ${JSON.stringify(read.accepted)}`)
  return read
}

it.each(phases)('%s does not add a framing hold to an ordinary singleton', async (phase) => {
  const native = nativeGitHub({ 41: { title: 'Ordinary issue' } })
  const { operations } = await installed(native)
  const read = await operations.readUw(scope(41))
  const result = admission(read, phase)
  expect(result.aggregate).toEqual({ status: 'none' })
  expect(result.framed.diagnostics.some((entry) => entry.code.startsWith('framing-aggregate'))).toBe(false)
  expect(result.deliverable.diagnostics.some((entry) => entry.code.startsWith('framing-aggregate'))).toBe(false)
})

it.each(phases)('%s carries a genuinely partial aggregate into both admission checks', async (phase) => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const guard = effectGuard((point) => point.at === 'before-effect' && point.effectId.endsWith(':result'))
  const framed = await operations.frame(await prepare(operations, closure()), guard.guard)
  if (framed.status !== 'partial' || framed.root === null) throw new Error('Expected genuine partial framing')
  const read = await operations.readUw(framed.root)
  expect(read.admission.aggregate).toMatchObject({ status: 'held', code: 'framing-aggregate-incomplete' })
  const result = admission(read, phase)
  expect(result.aggregate).toMatchObject({ status: 'held', code: 'framing-aggregate-incomplete' })
  expect(result.framed.diagnostics.map((entry) => entry.code)).toContain('framing-aggregate-incomplete')
  expect(result.deliverable.diagnostics.map((entry) => entry.code)).toContain('framing-aggregate-incomplete')
  const observed = await createInstalledObservedUwReadPort({ observation: read.observation }).readUw(framed.root)
  expect(observed.admission.aggregate).toEqual(read.admission.aggregate)
  expect(read.admission.deliverable.diagnostics.map((entry) => entry.code)).toContain('framing-aggregate-incomplete')
})

it.each(phases)(
  '%s retains a complete accepted member and does not reinterpret post-acceptance edge changes',
  async (phase) => {
    const native = nativeGitHub()
    const { operations } = await installed(native)
    const input = closure()
    input.members = input.members.slice(0, 2)
    input.edges = [{ kind: 'blocker', dependent: 'root', blocker: 'foundation' }]
    input.coverage = []
    input.foundations = []
    const framed = await operations.frame(await prepare(operations, input), effectGuard().guard)
    if (framed.status !== 'written') throw new Error('Expected complete framing')
    const root = native.issues.get(numberOf(framed.value.root))
    if (!root) throw new Error('Expected native root')
    const blockers = [...root.blockers]
    root.blockers = []
    const unaccepted = await operations.readUw(framed.value.root)
    expect(unaccepted.accepted.status).toBe('absent')
    expect(admission(unaccepted, phase).aggregate).toMatchObject({ status: 'held', code: 'framing-result-drift' })
    root.blockers = blockers
    const read = await acceptedMember(operations, native.gh, framed.value.root)
    const complete = admission(read, phase)
    expect(complete.aggregate).toMatchObject({ status: 'complete', member: 'root' })
    expect(complete.framed.diagnostics.map((entry) => entry.code)).not.toContain('framing-result-drift')
    // The same native edge change is no longer pre-acceptance drift after the Mandate.
    root.blockers = []
    const changed = await operations.readUw(framed.value.root)
    expect(changed.accepted.status).toBe('accepted')
    const after = admission(changed, phase)
    expect(after.aggregate).toMatchObject({ status: 'complete', member: 'root' })
    expect(after.framed.diagnostics.map((entry) => entry.code)).not.toContain('framing-result-drift')
    expect(after.deliverable.diagnostics.map((entry) => entry.code)).not.toContain('framing-result-drift')
  },
)

it.each(phases)('%s requires the real intent-home history for a non-root member', async (phase) => {
  const native = nativeGitHub()
  const { operations } = await installed(native)
  const framed = await operations.frame(await prepare(operations, closure()), effectGuard().guard)
  if (framed.status !== 'written') throw new Error('Expected complete framing')
  const member = framed.value.members.find((entry) => entry.key === 'foundation')
  if (!member) throw new Error('Expected non-root member')
  const read = await operations.readUw(member.scope)
  expect(admission(read, phase).aggregate).toMatchObject({ status: 'complete', member: 'foundation' })
  const missingRoot = admission(
    read,
    phase,
    read.histories.filter((history) => history.source.scope.target !== framed.value.root.target),
  )
  expect(missingRoot.aggregate).toMatchObject({ status: 'held', code: 'framing-aggregate-unreadable' })
  expect(missingRoot.framed.diagnostics.map((entry) => entry.code)).toContain('framing-aggregate-unreadable')
  expect(missingRoot.deliverable.diagnostics.map((entry) => entry.code)).toContain('framing-aggregate-unreadable')
})
