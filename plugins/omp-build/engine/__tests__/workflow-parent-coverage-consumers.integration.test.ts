import { expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { acceptedCompletionProblem } from '../uw-completion-accepted.ts'
import { canonicalSpec } from '../uw-spec.ts'
import { resolveAcceptedSpec, resolveAcceptedSpecAt, resolveAcceptedSpecPrefixes } from '../workflow-accepted-spec.ts'
import type { ParentCoverage } from '../workflow-mandate-schema.ts'
import { prepareMaterialAcceptance } from '../workflow-material-acceptance.ts'
import { type SpecAssessment, specAssessmentSchema } from '../workflow-output-schema.ts'
import { isAssessResult } from '../workflow-spec-assessment.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { must } from './workflow-test-support.ts'

const PARENT: Scope = { repository: 'acme/audit', target: 'acme/audit#910' }
const FIRST: Scope = { repository: 'acme/audit', target: 'acme/audit#911' }
const SECOND: Scope = { repository: 'acme/audit', target: 'acme/audit#912' }
const FOREIGN: Scope = { repository: 'other/audit', target: 'other/audit#912' }
const DATE = '2026-10-27T12:00:00.000Z'

function nativeSpec(uw: Scope, child: boolean, retain = true, context = '') {
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: child
        ? [
            {
              id: 'C1',
              statement: retain
                ? 'Retain each transaction audit trail'
                : 'Delete each transaction audit trail after commit',
            },
          ]
        : [
            { id: 'C1', statement: 'Integrate transaction audit trails' },
            { id: 'C2', statement: 'Audit trails remain attributable' },
          ],
      invariants: child ? [] : [{ id: 'I1', statement: 'Every committed transaction retains its audit trail' }],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context, change: '' },
    }),
  )
  const body = renderIssueSpecBody(spec, { complexity: 1 })
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, body, DATE) })
  if (parsed.status !== 'conformant') throw new Error('Expected a conformant native Spec')
  return parsed.snapshot
}

function parentWorld() {
  const workflow = roxabiWorkflowFixtures()
  const parentSnapshot = nativeSpec(PARENT, false)
  const snapshots = [nativeSpec(FIRST, true), nativeSpec(SECOND, true)]
  const children = [FIRST, SECOND].map((scope, index) => {
    const snapshot = snapshots[index]
    if (snapshot === undefined) throw new Error('Missing child snapshot')
    return { scope, snapshot, specVersion: snapshot.spec.version, tier: 'S' as const }
  })
  const parent = workflow.epicMandate(PARENT, children, {
    recordId: 'audit-parent',
    ownSpec: workflow.ownSpecFromSnapshot(PARENT, parentSnapshot),
    body: parentSnapshot.raw.body,
  })
  const parentHistory = workflow.historyFrom([parent])
  const childMandates = children.map((child, index) =>
    workflow.featureMandate(child.scope, {
      recordId: `audit-child-${index}`,
      operationId: `audit-child-op-${index}`,
      ownSpec: workflow.ownSpecFromSnapshot(child.scope, child.snapshot),
      body: child.snapshot.raw.body,
      parent: workflow.mandateRef(parent),
      inheritedOwnSpecRefs: [
        { uw: PARENT, version: parentSnapshot.spec.version, sourceAccepted: workflow.mandateRef(parent) },
      ],
    }),
  )
  const histories = [
    parentHistory,
    ...childMandates.map((child) => workflow.historyFrom([child], 'operator', 'operator', [parentHistory])),
  ]
  const accepted = resolveAcceptedSpec(parent, histories)
  if (!accepted.ok) throw new Error('Parent baseline lacks authenticated accepted authority')
  const next = nativeSpec(PARENT, false, true, 'Integrate the retained audit trails')
  const proposed = proposedAssessmentState(mandateAssessmentState(parent), {
    body: next.raw.body,
    content: {
      criteria: next.spec.criteria,
      invariants: next.spec.invariants,
      exclusions: next.spec.exclusions,
      openQuestions: next.spec.openQuestions,
      sections: next.spec.sections,
    },
  })
  const fixture = assessFixture(
    parent,
    'audit-baseline',
    mandateAssessmentState(parent),
    proposed,
    'material',
    histories,
  )
  const withAssessment = [
    workflow.historyFrom([parent, fixture.start, fixture.result], 'operator', 'operator', histories.slice(1)),
    ...histories.slice(1),
  ]
  const nodes = [
    { scope: PARENT, snapshot: parentSnapshot, parent: null, children: [FIRST, SECOND] },
    ...children.map((child) => ({ scope: child.scope, snapshot: child.snapshot, parent: PARENT, children: [] })),
  ]
  return { workflow, parent, children, histories, accepted: accepted.spec, fixture, withAssessment, nodes }
}

type World = ReturnType<typeof parentWorld>
type CoverageCase =
  | 'orphan'
  | 'unknown-criterion'
  | 'repeated-criterion'
  | 'missing-child'
  | 'unknown-child'
  | 'repeated-child'
  | 'wrong-version'

function changedCoverage(coverage: ParentCoverage, scenario: CoverageCase): ParentCoverage {
  const first = coverage.assignments[0]
  const second = coverage.assignments[1]
  if (first === undefined || second === undefined) throw new Error('Expected two covered criteria')
  switch (scenario) {
    case 'orphan':
      return { ...coverage, assignments: [first] }
    case 'unknown-criterion':
      return { ...coverage, assignments: [first, { ...second, criterion: 'C99' }] }
    case 'repeated-criterion':
      return { ...coverage, assignments: [first, { ...second, criterion: first.criterion }] }
    case 'missing-child':
      return {
        ...coverage,
        assignments: coverage.assignments.map<ParentCoverage['assignments'][number]>((row) => ({
          ...row,
          children: [FIRST],
        })),
      }
    case 'unknown-child':
      return { ...coverage, assignments: [first, { ...second, children: [FOREIGN] }] }
    case 'repeated-child':
      return { ...coverage, assignments: [first, { ...second, children: [SECOND, SECOND] }] }
    case 'wrong-version':
      return { ...coverage, parent: { ...coverage.parent, version: 'f'.repeat(64) } }
  }
}

function expectedIdentities(world: World, scenario: CoverageCase): string[] {
  const parent = [PARENT.repository, PARENT.target, world.parent.payload.ownSpec.version]
  if (scenario === 'wrong-version') return [...parent, 'f'.repeat(64)]
  if (scenario === 'orphan') return [...parent, 'C2']
  if (scenario === 'unknown-criterion') return [...parent, 'C99']
  if (scenario === 'repeated-criterion') return [...parent, 'C1']
  const second = world.children[1]
  if (second === undefined) throw new Error('Expected the second accepted child')
  return scenario === 'unknown-child'
    ? [FOREIGN.repository, FOREIGN.target]
    : [SECOND.repository, SECOND.target, second.specVersion]
}

test.each([
  'orphan',
  'unknown-criterion',
  'repeated-criterion',
  'missing-child',
  'unknown-child',
  'repeated-child',
  'wrong-version',
] as const)('canonical parent transition names invalid coverage: %s', (scenario) => {
  const world = parentWorld()
  const coverage = world.parent.payload.coverage
  if (coverage === null) throw new Error('Expected accepted parent coverage')
  expect(buildRecord(world.parent).ok).toBe(true)
  expect(
    prepareMaterialAcceptance({
      uw: PARENT,
      operationId: 'positive-parent-control',
      histories: world.withAssessment,
      mandate: world.parent,
      currentProposed: world.fixture.proposed,
      identityAllocations: world.fixture.result.payload.exactInputs.identityAllocations,
    }).ok,
  ).toBe(true)
  const rejected = buildRecord({
    ...world.parent,
    payload: { ...world.parent.payload, coverage: changedCoverage(coverage, scenario) },
  })
  expect(rejected).toMatchObject({ ok: false, diagnostics: [{ code: 'malformed' }] })
  if (rejected.ok) throw new Error('Invalid parent coverage was admitted')
  const diagnostics = JSON.stringify(rejected.diagnostics)
  for (const identity of expectedIdentities(world, scenario)) expect(diagnostics).toContain(identity)
})

test('assessment transition names omitted proposed criteria and children at their pinned versions', () => {
  const world = parentWorld()
  const start = world.fixture.start
  if (start.kind !== 'action-receipt' || start.payload.action !== 'assess-spec' || start.payload.phase !== 'start')
    throw new Error('Expected the authenticated native assessment start')
  expect(buildRecord(start).ok).toBe(true)
  const proposed = start.payload.exactInputs.proposed
  if (proposed.coverage === null) throw new Error('Expected proposed parent coverage')
  const first = proposed.coverage.assignments[0]
  if (first === undefined) throw new Error('Expected criterion C1')
  const exactInputs: typeof start.payload.exactInputs = {
    ...start.payload.exactInputs,
    proposed: { ...proposed, coverage: { ...proposed.coverage, assignments: [{ ...first, children: [FIRST] }] } },
  }
  const manifest: typeof start.payload.inputs.manifest = {
    ...start.payload.inputs.manifest,
    operands: { action: 'assess-spec', origin: { kind: 'native-current' }, exactInputs },
  }
  const inputs = { ...start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const rejected = buildRecord({ ...start, payload: { ...start.payload, inputs, exactInputs } })
  expect(rejected).toMatchObject({ ok: false, diagnostics: [{ code: 'malformed' }] })
  if (rejected.ok) throw new Error('Orphaned proposed obligations were admitted')
  const detail = JSON.stringify(rejected.diagnostics)
  const secondChild = world.children[1]
  if (secondChild === undefined) throw new Error('Expected the second proposed child')
  for (const name of [
    'C2',
    PARENT.repository,
    PARENT.target,
    proposed.snapshot.spec.version,
    SECOND.target,
    secondChild.specVersion,
  ])
    expect(detail).toContain(name)
})

test('completion coverage consumes the authenticated parent and exact native child graph', async () => {
  const world = parentWorld()
  const observed = await observeFixtureNativeWorld({
    root: PARENT,
    histories: world.histories,
    nodes: world.nodes.map(({ scope, snapshot, parent, children }) => ({
      scope,
      title: scope.target,
      body: snapshot.raw.body,
      updatedAt: DATE,
      labels: ['size:S'],
      parent,
      children,
      blockers: [],
      state: 'OPEN',
      stateReason: null,
    })),
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
  expect(observed.observation.status).toBe('complete')
  const node = observed.observation.graph.nodes.find((entry) => entry.uw.target === PARENT.target)
  if (node === undefined) throw new Error('Fresh native parent was not observed')
  expect(
    acceptedCompletionProblem(PARENT, node, observed.observation.graph, world.accepted, (uw, code, message) => ({
      code,
      message,
      location: { kind: 'native', uw, connection: 'state' },
      related: [],
    })),
  ).toBeNull()
})

function conflictingAssessment(world: World) {
  const first = world.children[0]
  if (first === undefined) throw new Error('Expected the first accepted child')
  const destructive = nativeSpec(FIRST, true, false)
  const proposed = {
    ...world.fixture.proposed,
    children: [{ ...first, snapshot: destructive, specVersion: destructive.spec.version }, ...world.children.slice(1)],
  }
  const fixture = assessFixture(
    world.parent,
    'audit-conflict',
    mandateAssessmentState(world.parent),
    proposed,
    'material',
    world.histories,
  )
  const assessment = specAssessmentSchema.parse(fixture.result.payload.structured)
  const parent = assessment.compatibility.examined.find(
    (constraint) =>
      constraint.kind === 'accepted' &&
      constraint.target.kind === 'invariant' &&
      constraint.target.spec.uw.target === PARENT.target,
  )
  const child = assessment.compatibility.examined.find(
    (constraint) =>
      constraint.kind === 'proposed' &&
      constraint.subject.kind === 'existing' &&
      constraint.subject.uw.target === FIRST.target &&
      constraint.element.kind === 'criterion',
  )
  const parentPin = fixture.result.payload.inputs.manifest.acceptedSources.find(
    (pin) => pin.record.scope.target === PARENT.target,
  )
  const childPin = fixture.result.payload.inputs.manifest.acceptedSources.find(
    (pin) => pin.record.scope.target === FIRST.target,
  )
  if (parent === undefined || child === undefined || parentPin === undefined || childPin === undefined)
    throw new Error('The distinct parent/child constraints and actual source pins must be present')
  const compatibility: SpecAssessment['compatibility'] = {
    state: 'conflicting',
    examined: assessment.compatibility.examined,
    conflicts: [
      {
        left: parent,
        right: child,
        reason: 'Deleting transaction audit trails violates mandatory parent retention',
        references: [parentPin, childPin],
      },
    ],
  }
  const result = must(
    buildRecord({
      ...fixture.result,
      payload: { ...fixture.result.payload, structured: { ...assessment, compatibility } },
    }),
  )
  return { fixture, result, destructive, compatibility }
}

test('material transition refuses the named authenticated parent invariant versus destructive child criterion', () => {
  const world = parentWorld()
  const baseline = prepareMaterialAcceptance({
    uw: PARENT,
    operationId: 'audit-positive',
    histories: world.withAssessment,
    mandate: world.parent,
    currentProposed: world.fixture.proposed,
    identityAllocations: world.fixture.result.payload.exactInputs.identityAllocations,
  })
  expect(baseline.ok).toBe(true)
  const { fixture, result, destructive } = conflictingAssessment(world)
  const control = acceptMaterialFixture(world.parent, 'audit-rejected-successor', fixture)
  const stoppedHistories = [
    world.workflow.historyFrom(
      [world.parent, fixture.start, result, control],
      'operator',
      'operator',
      world.histories.slice(1),
    ),
    ...world.histories.slice(1),
  ]
  expect(resolveAcceptedSpec(world.parent, stoppedHistories)).toMatchObject({
    ok: false,
    evidence: [{ code: 'material-spec' }],
  })
  expect(resolveAcceptedSpecAt(world.parent, stoppedHistories, world.accepted.ref).ok).toBe(false)
  expect(resolveAcceptedSpecPrefixes(world.parent, stoppedHistories).ok).toBe(false)
  const rejected = prepareMaterialAcceptance({
    uw: PARENT,
    operationId: 'audit-refused',
    mandate: world.parent,
    histories: [
      world.workflow.historyFrom(
        [world.parent, fixture.start, result],
        'operator',
        'operator',
        world.histories.slice(1),
      ),
      ...world.histories.slice(1),
    ],
    currentProposed: fixture.proposed,
    identityAllocations: fixture.result.payload.exactInputs.identityAllocations,
  })
  expect(rejected.ok).toBe(false)
  if (rejected.ok) throw new Error('Contradictory parent/child obligations were accepted')
  expect(rejected.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'material-spec' })]))
  const detail = rejected.diagnostics.map((item) => item.message).join('\n')
  for (const name of [
    PARENT.repository,
    PARENT.target,
    world.parent.payload.ownSpec.version,
    'I1',
    FIRST.repository,
    FIRST.target,
    destructive.spec.version,
    'C1',
  ])
    expect(detail).toContain(name)
})

function damagedExamination(examined: SpecAssessment['compatibility']['examined'], fault: string) {
  switch (fault) {
    case 'omitted-examination':
      return examined.slice(1)
    case 'repeated-examination':
      return [...examined, examined[0]]
    case 'misversioned-examination':
      return examined.map((constraint, index) =>
        index === 0 && constraint.kind === 'accepted'
          ? {
              ...constraint,
              target: { ...constraint.target, spec: { ...constraint.target.spec, version: '0'.repeat(64) } },
            }
          : constraint,
      )
    default:
      return examined
  }
}

test.each([
  'foreign-operand',
  'uncaptured-citation',
  'omitted-examination',
  'repeated-examination',
  'misversioned-examination',
  'missing-child',
] as const)('material transition does not name an unauthenticated conflict: %s', (fault) => {
  const world = parentWorld()
  expect(
    prepareMaterialAcceptance({
      uw: PARENT,
      operationId: 'audit-authority-baseline',
      mandate: world.parent,
      histories: world.withAssessment,
      currentProposed: world.fixture.proposed,
      identityAllocations: world.fixture.result.payload.exactInputs.identityAllocations,
    }).ok,
  ).toBe(true)
  const { fixture, result, compatibility } = conflictingAssessment(world)
  const conflict = compatibility.conflicts[0]
  if (conflict.left.kind !== 'accepted') throw new Error('Expected the genuine accepted parent invariant')
  const firstCitation = conflict.references[0]
  const mutated =
    fault === 'foreign-operand'
      ? {
          ...conflict,
          left: {
            ...conflict.left,
            target: { ...conflict.left.target, spec: { ...conflict.left.target.spec, uw: FOREIGN } },
          },
        }
      : fault === 'uncaptured-citation'
        ? { ...conflict, references: [{ ...firstCitation, digest: '0'.repeat(64) }, ...conflict.references.slice(1)] }
        : conflict
  const untrustedReason = 'UNTRUSTED-CLAIM-MUST-NOT-BECOME-AUTHORITY'
  if (!isAssessResult(result)) throw new Error('Expected the actual native assess-spec result before mutation')
  const structured = specAssessmentSchema.parse(result.payload.structured)
  const malformed = must(
    buildRecord({
      ...result,
      payload: {
        ...result.payload,
        structured: specAssessmentSchema.parse({
          ...structured,
          compatibility: {
            ...compatibility,
            examined: damagedExamination(compatibility.examined, fault),
            conflicts: [{ ...mutated, reason: untrustedReason }],
          },
        }),
      },
    }),
  )
  const published = world.workflow.historyFrom(
    [world.parent, fixture.start, malformed],
    'operator',
    'operator',
    world.histories.slice(1),
  )
  const available = [published, ...world.histories.slice(1)]
  const histories =
    fault === 'missing-child' ? available.filter((entry) => entry.source.scope.target !== FIRST.target) : available
  const rejected = prepareMaterialAcceptance({
    uw: PARENT,
    operationId: 'audit-unqualified-refused',
    mandate: world.parent,
    histories,
    currentProposed: fixture.proposed,
    identityAllocations: fixture.result.payload.exactInputs.identityAllocations,
  })
  expect(rejected.ok).toBe(false)
  if (rejected.ok) throw new Error('Unqualified conflict was accepted')
  const detail = rejected.diagnostics.map((item) => item.message).join('\n')
  expect(detail).toContain(
    fault === 'foreign-operand'
      ? 'outside the examined set'
      : fault === 'uncaptured-citation'
        ? 'not captured in the assessment inputs'
        : fault === 'missing-child'
          ? 'missing, ambiguous or has a bad suffix'
          : 'examined set does not exactly cover',
  )
  expect(detail).not.toContain(untrustedReason)
})

test('a foreign native author cannot lend authority to an otherwise shaped parent/child conflict', () => {
  const world = parentWorld()
  expect(
    prepareMaterialAcceptance({
      uw: PARENT,
      operationId: 'audit-native-author-positive',
      mandate: world.parent,
      histories: world.withAssessment,
      currentProposed: world.fixture.proposed,
      identityAllocations: world.fixture.result.payload.exactInputs.identityAllocations,
    }).ok,
  ).toBe(true)
  const { fixture, result } = conflictingAssessment(world)
  const foreign = world.workflow.historyFrom(
    [world.parent, fixture.start, result],
    'intruder',
    'operator',
    world.histories.slice(1),
  )
  const rejected = prepareMaterialAcceptance({
    uw: PARENT,
    operationId: 'audit-foreign-refused',
    mandate: world.parent,
    histories: [foreign, ...world.histories.slice(1)],
    currentProposed: fixture.proposed,
    identityAllocations: fixture.result.payload.exactInputs.identityAllocations,
  })
  expect(rejected).toMatchObject({ ok: false, diagnostics: [{ code: 'unconfirmed' }] })
  if (rejected.ok) throw new Error('Foreign native conflict was accepted')
  expect(JSON.stringify(rejected.diagnostics)).not.toContain(
    'Deleting transaction audit trails violates mandatory parent retention',
  )
})
