import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import {
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import { assessCauseDispositions } from '../../engine/cause-disposition.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { resolveSpecEffective } from '../../engine/spec-effective.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { fixtureCatalogueGhResponse, fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { authenticatedReview, causeFixtureGraph } from '../../testing/cause-input-fixture.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { observedUwWithoutPullRequests } from '../../testing/uw-completion-observation.ts'
import { createCauseAdjudication } from '../uw-cause-adjudication.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

function must<T>(
  result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string; message: string }[] },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

export async function historicalWorld(confirm: boolean, beforeConfirmation?: () => Promise<void>) {
  const fixtures = roxabiWorkflowFixtures()
  const { projection } = roxabiRecordFixtures()
  const { graph, context: fixtureContext } = authenticatedReview()
  const uw = fixtureContext.original
  const mandate = fixtures.featureMandate(uw, { recordId: 'mandate-42', body: 'Save the selected region' })
  const allocation = mandate.payload.ownSpec.identityAllocations[0]
  if (!allocation) throw new Error('Expected mandate identity allocation')
  const identity = fixtures.identityAllocation(uw, allocation.recordId)
  let own = encodeCriterionRecords([identity, mandate], uw, projection, 'operator').history
  const source = graph.history
  const acceptedA = resolveAcceptedSpec(mandate, [own, source])
  if (!acceptedA.ok) throw new Error(`Spec A unavailable: ${acceptedA.reason}`)
  const contextA = {
    original: uw,
    effective: must(
      resolveSpecEffective({
        mode: 'historical',
        own: acceptedA.spec.ref,
        versionVector: [acceptedA.spec.ref, ...acceptedA.spec.inheritedOwnSpecRefs],
        histories: [own, source],
      }),
    ),
  }
  const decision = recordsOf(source).find(
    (record) => record.kind === 'decision' && record.recordId === graph.decision.recordId,
  )
  if (decision?.kind !== 'decision') throw new Error('Encoded review decision is missing')
  const assessment = must(
    assessCauseDispositions({
      context: contextA,
      capture: synthesisActionCapture(decision, [source]),
      graph: causeFixtureGraph(),
      source: { kind: 'decision', decision },
      histories: [own, source],
      catalogues: fixtureReviewClassCatalogues(),
      adjudications: [],
    }),
  )
  const payload = assessment.outcomes.find((item) => item.subject.kind === 'cause')
  if (payload?.outcome.state !== 'pending-blocking' || payload.subject.kind !== 'cause')
    throw new Error('Expected unresolved Spec A cause hold')
  const pending = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'historical-pending',
      runId: 'historical-run',
      operationId: 'write-historical-pending',
      kind: 'cause-disposition',
      payload,
    }),
  )
  if (pending.kind !== 'cause-disposition') throw new Error('Expected disposition')
  own = encodeCriterionRecords([pending], uw, projection, 'operator', [source], own).history
  const accepted = mandateAssessmentState(mandate)
  const proposed = proposedAssessmentState(accepted, { body: 'Editorial clarification of selected region' })
  const amendment = assessFixture(mandate, 'historical-editorial', accepted, proposed, 'editorial', [own, source])
  own = encodeCriterionRecords([amendment.start, amendment.result], uw, projection, 'operator', [source], own).history
  const acceptedB = resolveAcceptedSpec(mandate, [own, source])
  if (!acceptedB.ok) throw new Error(`Spec B unavailable: ${acceptedB.reason}`)

  type NativeComment = { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }
  let nextId = 1000
  const comments = new Map<string, NativeComment[]>(
    [own, source].map((history): [string, NativeComment[]] => [
      history.source.scope.target,
      history.source.comments.map((comment) => {
        if (comment.author === null || comment.createdAt === null || comment.updatedAt === null)
          throw new Error('Expected authenticated native comment metadata')
        return {
          id: ++nextId,
          body: comment.body,
          user: { login: comment.author },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        }
      }),
    ]),
  )
  const posts: NativeComment[] = []
  const github = {
    cwd: '/fixture',
    readAuthor: 'operator',
    writeAuthor: 'operator',
    writerLogin: 'operator',
    gh: async (_cwd: string, args: string[]) => {
      const catalogue = fixtureCatalogueGhResponse(args)
      if (catalogue !== null) return catalogue
      const endpoint = args.find((arg) => arg.startsWith('repos/acme/app/issues/')) ?? ''
      const match = /^repos\/acme\/app\/issues\/(\d+)\/comments(?:\?per_page=100&page=(\d+))?$/.exec(endpoint)
      if (args[0] !== 'api' || !match) throw new Error(`Unexpected GH request: ${JSON.stringify(args)}`)
      const list = comments.get(`acme/app#${match[1]}`)
      if (!list) throw new Error(`Unexpected scope: ${match[1]}`)
      if (args.includes('POST')) {
        const body = args.find((arg) => arg.startsWith('body='))?.slice(5)
        if (body === undefined) throw new Error('Missing comment body')
        const item = {
          id: ++nextId,
          body,
          user: { login: 'operator' },
          created_at: '2026-10-27T12:00:00Z',
          updated_at: '2026-10-27T12:00:00Z',
        }
        list.push(item)
        posts.push(item)
        return JSON.stringify(item)
      }
      const page = Number(match[2] ?? 1)
      return JSON.stringify(list.slice((page - 1) * 100, page * 100))
    },
  }
  const reader = createInstalledObservedUwReadPort({
    observation: await observedUwWithoutPullRequests({
      graph: {
        status: 'complete',
        root: uw,
        observedAt: '2026-10-27T12:00:00.000Z',
        nodes: [
          {
            uw,
            title: 'Save the selected region',
            raw: amendment.proposed.snapshot.raw,
            updatedAt: '2026-10-27T12:00:00.000Z',
            labels: [`size:${mandate.payload.tier}`],
            wayfinderLabels: [],
            parent: null,
            children: [],
            blockers: [],
            native: { state: 'OPEN', stateReason: null },
          },
        ],
      },
      histories: [own, source],
      catalogues: fixtureReviewClassCatalogues(),
    }),
  })
  const prompts: string[] = []
  const artifacts = mkdtempSync(join(tmpdir(), 'omp-historical-adjudication-'))
  process.once('exit', () => rmSync(artifacts, { recursive: true, force: true }))
  const operator = createOperatorConfirmation({
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: {
      confirm: async (_title: string, message: string) => {
        prompts.push(message)
        await beforeConfirmation?.()
        return confirm
      },
    },
    localProtocolOptions: { getArtifactsDir: () => artifacts },
  } as unknown as ExtensionContext)
  const citation = graph.inputs.manifest.repositoryReferences[0]
  if (!citation) throw new Error('Expected pinned review evidence')
  const ref = { scope: uw, recordId: pending.recordId, kind: 'cause-disposition' as const }
  const request = {
    pending: ref,
    rejectedFindingIds: payload.subject.findings.map((finding) => finding.id),
    judgment: null,
    reason: 'The pinned source contradicts the reported findings',
    references: [citation],
  }
  return {
    uw,
    pending,
    ref,
    acceptedA: acceptedA.spec,
    acceptedB: acceptedB.spec,
    reader,
    github,
    prompts,
    posts,
    request,
    adjudicate: createCauseAdjudication({ reader, github, operator }),
  }
}
