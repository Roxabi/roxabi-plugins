import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { rawSource } from '../../adapters/github-native/uw-spec.ts'
import { causeActionData } from '../../roxabi/uw-action-cause-data.ts'
import type { UwActionRequest } from '../../roxabi/uw-action-contract.ts'
import { synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { submission } from '../../testing/record-builders.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { operation } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import { assessAdjudicationSuccessor } from '../cause-adjudication-successor.ts'
import {
  assessCauseDispositions,
  readCauseDispositionHeads,
  readCauseReports,
  validateCauseDispositionRecords,
} from '../cause-disposition.ts'
import { causeAdjudicationProposalSchema } from '../cause-disposition-schema.ts'
import { assessCauseHolds } from '../cause-hold.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import { canonicalSpec } from '../uw-spec.ts'
import { projectUwWaits } from '../uw-waits.ts'
import { recordsOf } from '../workflow-control.ts'
import { cataloguesForInputs, withPinnedCatalogue } from './cause-catalogue-fixture.ts'
import { appendAccountedRecords, ref } from './cause-hold-fixture.ts'
import { must } from './workflow-test-support.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uw = { repository: 'acme/app', target: 'acme/app#42' }
const pr = { repository: 'acme/app', target: 'acme/app#44' }
const observedAt = '2026-10-27T12:00:00.000Z'
const nativeGraph = {
  status: 'complete' as const,
  root: uw,
  observedAt,
  nodes: [
    {
      uw,
      title: 'Save region',
      raw: rawSource(uw.target, 'Save region; bulk export is excluded', observedAt),
      updatedAt: observedAt,
      labels: ['size:S'],
      wayfinderLabels: [],
      parent: null,
      children: [],
      blockers: [],
      native: { state: 'OPEN' as const, stateReason: null },
    },
  ],
}
function fixtureHolds(
  histories: Parameters<typeof projectUwWaits>[0]['histories'],
  catalogues: Parameters<typeof projectUwWaits>[0]['catalogues'],
) {
  return assessCauseHolds({
    uw,
    waits: projectUwWaits({ graph: nativeGraph, histories, catalogues }),
    dependencies: new Map(),
  })
}
const citation = {
  source: 'git-file' as const,
  repository: uw.repository,
  commit: '1'.repeat(40),
  path: 'src/region.ts',
  digest: 'a'.repeat(64),
}

function mixedFixture(includeExclusion = true) {
  const fixtures = roxabiWorkflowFixtures()
  const body = 'Save region; bulk export is excluded'
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Save the selected region' }],
      invariants: [],
      exclusions: ['bulk export'],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const ownSpec = fixtures.ownSpecFromSnapshot(uw, {
    spec,
    raw: { reference: uw.target, body, bodySha256: specDigest(body), lastEditedAt: '2026-10-27T12:00:00.000Z' },
  })
  const mandate = fixtures.featureMandate(uw, { recordId: 'mixed-mandate', body, ownSpec })
  const binding = fixtures.workflowBinding(pr, mandate, 'feat/42-save', 'main')
  const base = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'mixed', label: 'issue' })
  const manifest = { ...base.inputs.manifest, repositoryReferences: [citation] }
  const inputs = withPinnedCatalogue({ ...base.inputs, manifest, fingerprint: actionInputDigest(manifest) })
  const catalogues = cataloguesForInputs(inputs)
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('Expected accepted Spec')
  const graph = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'mixed', label: 'issue', inputs })
  const sourceAction = { actionId: 'mixed-panel-action', inputs }
  const root = must(
    parseRecord({
      ...graph.root,
      payload: {
        ...graph.root.payload,
        slots: graph.root.payload.slots.map((slot) =>
          slot.slotId === 'panel-0' ? { ...slot, action: sourceAction } : slot,
        ),
      },
    }),
  )
  const original = graph.panel.payload.findings?.[0]
  const finding = graph.decision.payload.judgment.findings[0]
  const cause = graph.decision.payload.judgment.causes[0]
  if (!original || !finding?.target || !cause) throw new Error('Expected original finding and cause')
  const secondOriginal = { ...original, id: `${graph.panel.recordId}:f1` }
  const originals = [original, secondOriginal]
  const actionable = { ...finding, id: 'mixed-actionable', sourceFindingIds: [secondOriginal.id] }
  const findings = [finding, actionable]
  const output = { findings: originals.map((item) => item.data) }
  const panel = must(
    parseRecord({
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        host: { ...graph.panel.payload.host, action: sourceAction },
        findings: originals,
        structured: output,
        rawAttempts: [
          submission({ id: `child-${graph.panel.recordId}`, structuredOutput: { status: 'valid', data: output } }),
        ],
      },
    }),
  )
  const judgment = {
    ...graph.decision.payload.judgment,
    findings,
    causes: [{ ...cause, findingIds: findings.map((item) => item.id) }],
    exclusionClaims: includeExclusion
      ? [
          {
            sourceFindingId: original.id,
            target: finding.target,
            exclusion: { spec: inputs.manifest.spec.effective.own, index: 0 },
            concern: 'additional-work' as const,
            reason: 'Bulk export is excluded',
          },
        ]
      : [],
  }
  const decision = must(parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } }))
  const synthesis = must(
    parseRecord({
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: judgment,
        rawAttempts: [
          submission({
            id: `child-${graph.synthesisContribution.recordId}`,
            structuredOutput: { status: 'valid', data: judgment },
          }),
        ],
      },
    }),
  )
  if (decision.kind !== 'decision') throw new Error('Expected decision')
  const source = {
    ...graph.history,
    operations: graph.history.operations.map((entry) =>
      entry.recordId === root.recordId
        ? operation(root)
        : entry.recordId === panel.recordId
          ? operation(panel)
          : entry.recordId === decision.recordId
            ? operation(decision)
            : entry.recordId === synthesis.recordId
              ? operation(synthesis)
              : entry,
    ),
  }
  let own = fixtures.historyFrom([mandate])
  const context = { original: uw, effective: inputs.manifest.spec.effective }
  const assessment = must(
    assessCauseDispositions({
      context,
      capture: synthesisActionCapture(decision, [source]),
      graph: nativeGraph,
      source: { kind: 'decision', decision },
      histories: [own, source],
      adjudications: [],
      catalogues,
    }),
  )
  const payload = assessment.outcomes.find((item) => item.subject.kind === 'cause')
  if (payload?.outcome.state !== 'pending-blocking') throw new Error('Expected mixed pending cause')
  const pending = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'mixed-pending',
      runId: 'run',
      operationId: 'mixed-pending-op',
      kind: 'cause-disposition',
      payload,
    }),
  )
  if (pending.kind !== 'cause-disposition') throw new Error('Expected disposition')
  own = appendAccountedRecords(own, [pending])
  const proposal = causeAdjudicationProposalSchema.parse({
    format: 'omp-build-cause-adjudication-proposal/1',
    operationId: 'mixed-reject',
    operation: 'adjudicate-cause',
    uw,
    pending: ref(pending),
    pendingDigest: hash(pending),
    rejectedFindingIds: [actionable.id],
    judgment: null,
    reason: 'The actionable finding is contradicted by the cited evidence',
    references: [citation],
  })
  const digest = hash(proposal)
  const adjudication = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'mixed-operation',
      runId: 'run',
      operationId: 'mixed-operation-op',
      kind: 'cause-operation',
      payload: {
        format: 'omp-build-cause-operation/1',
        proposal,
        proposalDigest: digest,
        confirmation: {
          route: 'omp-native-command',
          operationId: proposal.operationId,
          proposalDigest: digest,
          confirmedAt: '2026-10-27T12:00:00.000Z',
        },
      },
    }),
  )
  if (adjudication.kind !== 'cause-operation') throw new Error('Expected operation')
  own = appendAccountedRecords(own, [adjudication])
  const outcome = must(
    assessAdjudicationSuccessor({ pending, operation: adjudication, histories: [own, source], catalogues }),
  )
  const head = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'mixed-report',
      runId: 'run',
      operationId: 'mixed-report-op',
      kind: 'cause-disposition',
      payload: outcome,
    }),
  )
  if (head.kind !== 'cause-disposition') throw new Error('Expected report')
  own = appendAccountedRecords(own, [head])
  const request: UwActionRequest = {
    actionId: 'fresh-review',
    purpose: 'review',
    subject: inputs.manifest.subject,
    code: inputs.manifest.code,
    stageSources: [],
    expandedContext: [],
  }
  return { own, source, pending, head, adjudication, request, catalogues }
}

it('consumes the authenticated excluded-only report after rejecting the actionable member', () => {
  const fixture = mixedFixture()
  const histories = [fixture.own, fixture.source]
  expect(fixture.head.payload.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
  expect(
    validateCauseDispositionRecords({ records: recordsOf(fixture.own), histories, catalogues: fixture.catalogues }),
  ).toEqual([])
  const heads = must(readCauseDispositionHeads({ uw, histories, catalogues: fixture.catalogues }))
  expect(heads.map((head) => head.recordId)).toEqual([fixture.head.recordId])
  expect(fixtureHolds(histories, fixture.catalogues)).toEqual([])
  expect(
    must(causeActionData(fixture.request, histories, [], fixture.catalogues)).map((pin) => pin.record.recordId),
  ).toEqual(expect.arrayContaining([fixture.pending.recordId, fixture.adjudication.recordId, fixture.head.recordId]))
  const reports = must(readCauseReports({ root: uw, subtree: [uw], histories: [fixture.own] }))
  expect(reports.reports.map((report) => report.ref.recordId)).toEqual([fixture.head.recordId])
})

it('refuses a forged report that clears a surviving actionable finding and missing source history', () => {
  const fixture = mixedFixture()
  const forged = must(
    parseRecord({
      ...fixture.pending,
      payload: {
        ...fixture.pending.payload,
        outcome: { state: 'final', disposition: 'report', blocking: false, reason: 'forged clearing' },
      },
    }),
  )
  const own = {
    ...fixture.own,
    operations: fixture.own.operations
      .filter((entry) => entry.recordId !== fixture.adjudication.recordId && entry.recordId !== fixture.head.recordId)
      .map((entry) => (entry.recordId === fixture.pending.recordId ? { ...entry, record: forged } : entry)),
  }
  const histories = [own, fixture.source]
  expect(readCauseDispositionHeads({ uw, histories, catalogues: fixture.catalogues }).ok).toBe(false)
  expect(fixtureHolds(histories, fixture.catalogues).length).toBeGreaterThan(0)
  expect(causeActionData(fixture.request, histories, [], fixture.catalogues).ok).toBe(false)
  // Retained ledger display does not establish that the initial outcome was semantically valid.
  expect(
    must(readCauseReports({ root: uw, subtree: [uw], histories: [own] })).reports.map((report) => report.ref.recordId),
  ).toEqual([forged.recordId])
  expect(readCauseDispositionHeads({ uw, histories: [fixture.own], catalogues: fixture.catalogues }).ok).toBe(false)
})

it('refuses omitted confirmation and competing successor instead of clearing a hold', () => {
  const fixture = mixedFixture()
  const withoutConfirmation = {
    ...fixture.own,
    operations: fixture.own.operations.filter((entry) => entry.recordId !== fixture.adjudication.recordId),
  }
  const competing = must(
    parseRecord({ ...fixture.head, recordId: 'mixed-competing', operationId: 'mixed-competing-op' }),
  )
  const withCompetition = appendAccountedRecords(fixture.own, [competing])
  for (const own of [withoutConfirmation, withCompetition]) {
    const histories = [own, fixture.source]
    expect(readCauseDispositionHeads({ uw, histories, catalogues: fixture.catalogues }).ok).toBe(false)
    expect(fixtureHolds(histories, fixture.catalogues).length).toBeGreaterThan(0)
    expect(causeActionData(fixture.request, histories, [], fixture.catalogues).ok).toBe(false)
    expect(readCauseReports({ root: uw, subtree: [uw], histories: [own] }).ok).toBe(false)
  }
})

it('keeps the remaining blocker pending when the exclusion is absent', () => {
  const fixture = mixedFixture(false)
  const histories = [fixture.own, fixture.source]
  expect(fixture.head.payload.outcome.state).toBe('pending-blocking')
  expect(fixtureHolds(histories, fixture.catalogues).length).toBeGreaterThan(0)
  expect(must(readCauseReports({ root: uw, subtree: [uw], histories })).reports).toEqual([])
})
