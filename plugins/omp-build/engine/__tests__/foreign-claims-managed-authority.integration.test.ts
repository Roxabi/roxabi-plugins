import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { expect, test } from 'vitest'
import { REMOVE_BLOCKED_BY_MUTATION } from '../../../issue-triage/skills/shared/queries.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { isolateViewerToken, releaseViewerToken } from '../../roxabi/__tests__/uw-viewer-token.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { installedMultiSisterFixture } from '../../testing/multi-sister-installed-fixture.ts'
import { resolveCauseDependencyControl } from '../cause-dependency-control.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import { scopeKey } from '../uw-graph.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { capturedChildOwnSources } from '../workflow-assessment-child-sources.ts'
import { deliveredLeaf } from './uw-delivery-proof-fixture.ts'
import { mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'

function withForeignCopy(history: DecodedHistory, kind: string, recordId?: string): DecodedHistory {
  const operation = history.operations.find(
    (entry) =>
      entry.kind === kind && entry.authority !== 'foreign' && (recordId === undefined || entry.recordId === recordId),
  )
  if (!operation || operation.parts.length === 0) throw new Error(`Expected authenticated ${kind} parts`)
  const copies = operation.parts.map((part, index) => ({
    ...part,
    locator: `foreign-copy-${kind}-${index}`,
    nativeId: `foreign-copy-${kind}-${index}`,
    author: 'intruder',
  }))
  return decodeHistory({ ...history.source, comments: [...history.source.comments, ...copies] })
}

test('an extra foreign mandate copy cannot veto a delivered managed leaf', async () => {
  const fixture = await deliveredLeaf()
  const baseline = assessUwCompletion(fixture.observation).completions.get(scopeKey(fixture.uw))
  expect(baseline).toMatchObject({
    state: 'complete',
    role: 'leaf',
    spec: fixture.accepted.ref,
    code: fixture.inputs.manifest.code,
  })
  const issue = withForeignCopy(fixture.review.issueHistory, 'mandate')
  expect(issue.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'mandate', authority: 'foreign' }),
      expect.objectContaining({ kind: 'mandate', authority: 'accounted', recordId: fixture.mandate.recordId }),
    ]),
  )
  const histories = fixture.observation.histories.map((history) =>
    history === fixture.review.issueHistory ? issue : history,
  )
  const completion = assessUwCompletion({ ...fixture.observation, histories }).completions.get(scopeKey(fixture.uw))
  expect(completion).toMatchObject({
    state: 'complete',
    role: 'leaf',
    spec: fixture.accepted.ref,
    versionVector: [fixture.accepted.ref],
    code: fixture.inputs.manifest.code,
    sources: expect.arrayContaining([
      { scope: fixture.pullRequest, kind: 'workflow-binding', recordId: fixture.binding.recordId },
      { scope: fixture.uw, kind: 'action-receipt', recordId: fixture.implementation.recordId },
      { scope: fixture.pullRequest, kind: 'review', recordId: fixture.review.review.recordId },
    ]),
  })
})

test('an extra foreign child mandate cannot veto the current accepted parent vector', async () => {
  const fixture = await deliveredLeaf('Approve (clean)', 52, true)
  if (!fixture.parent) throw new Error('Expected accepted parent')
  const accepted = resolveAcceptedSpec(fixture.parent, fixture.observation.histories)
  if (!accepted.ok) throw new Error('Expected accepted parent Spec')
  const request = {
    mode: 'current' as const,
    own: accepted.spec.ref,
    histories: fixture.observation.histories,
    graph: fixture.observation.graph,
  }
  const baseline = resolveSpecEffective(request)
  expect(baseline).toMatchObject({ ok: true, value: { own: accepted.spec.ref, versionVector: [accepted.spec.ref] } })
  const issue = withForeignCopy(fixture.review.issueHistory, 'mandate')
  const histories = request.histories.map((history) => (history === fixture.review.issueHistory ? issue : history))
  expect(resolveSpecEffective({ ...request, histories })).toMatchObject({
    ok: true,
    value: { own: accepted.spec.ref, versionVector: [accepted.spec.ref] },
  })
  expect(resolveSpecEffective({ ...request, own: fixture.accepted.ref, histories })).toMatchObject({
    ok: true,
    value: { versionVector: fixture.effective.versionVector },
  })
})

test('a foreign child mandate copy cannot veto captured managed assessment sources', async () => {
  const fixture = await deliveredLeaf('Approve (clean)', 54, true)
  if (!fixture.parent) throw new Error('Expected accepted parent')
  const accepted = mandateAssessmentState(fixture.parent)
  const proposed = proposedAssessmentState(accepted, { body: 'Parent assessment proposal' })
  const original = fixture.review.issueHistory
  const baseline = capturedChildOwnSources(accepted, proposed, fixture.observation.histories, [])
  expect(baseline).toMatchObject({
    childOwnSources: [{ uw: fixture.uw, own: fixture.accepted.ref }],
    sourceRefs: expect.arrayContaining([{ scope: fixture.uw, kind: 'mandate', recordId: fixture.mandate.recordId }]),
  })
  const foreign = withForeignCopy(original, 'mandate')
  const onlyForeign = decodeHistory({
    ...foreign.source,
    comments: foreign.source.comments.filter((comment) => comment.author === 'intruder'),
  })
  expect(capturedChildOwnSources(accepted, proposed, [onlyForeign], [])).toBeNull()
  const histories = fixture.observation.histories.map((history) => (history === original ? foreign : history))
  expect(capturedChildOwnSources(accepted, proposed, histories, [])).toEqual(baseline)
})

test('an extra foreign control copy cannot veto an authenticated causal withdrawal', async () => {
  const artifacts = mkdtempSync(join(tmpdir(), 'omp-foreign-cause-'))
  isolateViewerToken()
  try {
    const world = await installedMultiSisterFixture(1, { artifactsDir: artifacts })
    const created = await world.operations.createSister(world.request(0))
    if (created.status !== 'created' || created.receipt.kind !== 'debt-receipt')
      throw new Error('Expected confirmed sister')
    const origin = world.context.original
    const sister = { repository: 'acme/app', target: 'acme/app#43' }
    const disposition = world.request(0).disposition
    const receipt = { scope: created.receipt.scope, recordId: created.receipt.recordId, kind: created.receipt.kind }
    const issue = world.issues.get(42)
    if (!issue?.blockers.includes(43)) throw new Error('Expected created native blocker')
    const gh: Gh = async (cwd, args) => {
      if (args[1] === 'graphql' && args[3] === `query=${REMOVE_BLOCKED_BY_MUTATION}`) {
        if (args[5] !== 'issueId=node-42' || args[7] !== 'blockingId=node-43')
          throw new Error('Unexpected blocker mutation')
        issue.blockers = issue.blockers.filter((number) => number !== 43)
        return JSON.stringify({ data: { removeBlockedBy: { issue: { number: 42 }, blockingIssue: { number: 43 } } } })
      }
      return world.gh(cwd, args)
    }
    const operator = createOperatorConfirmation({
      agent: { kind: 'main', depth: 0 },
      hasUI: true,
      mode: 'tui',
      ui: {
        async confirm() {
          return true
        },
      },
      localProtocolOptions: { getArtifactsDir: () => artifacts },
    } as unknown as ExtensionContext)
    const operations = await createInstalledUwOperations({ cwd: '/fixture', gh, readAuthor: 'automation', operator })
    const result = await operations.adjustCauseDependency({
      origin,
      disposition,
      receipt,
      predecessor: receipt,
      change: { kind: 'withdraw' },
      nativeEffect: { kind: 'update-blockers', remove: [sister], add: [] },
      reason: 'The operator withdrew this causal dependency',
      references: [],
    })
    if (result.status !== 'adjusted') throw new Error(`Expected confirmed adjustment: ${JSON.stringify(result)}`)
    const read = await operations.readUw(origin)
    if (read.observation.status !== 'complete') throw new Error('Expected complete causal observation')
    const input = {
      origin,
      disposition,
      receipt,
      target: sister,
      histories: read.histories,
      graph: read.graph,
      catalogues: read.observation.catalogues,
    }
    expect(resolveCauseDependencyControl(input)).toMatchObject({ state: 'withdrawn', control: result.control })
    const home = read.histories.find((history) => scopeKey(history.source.scope) === scopeKey(origin))
    if (!home) throw new Error('Expected origin history')
    const control = home.operations.find(
      (entry) => entry.recordId === result.control.recordId && entry.authority !== 'foreign',
    )
    if (!control || control.parts.length === 0) throw new Error('Expected confirmed control parts')
    const removed = new Set(control.parts.map((part) => part.locator))
    const missingControl = decodeHistory({
      ...home.source,
      comments: home.source.comments.filter((part) => !removed.has(part.locator)),
    })
    const missingHistories = read.histories.map((history) => (history === home ? missingControl : history))
    expect(resolveCauseDependencyControl({ ...input, histories: missingHistories })).not.toMatchObject({
      state: 'withdrawn',
      control: result.control,
    })
    const foreign = withForeignCopy(home, 'operator-control', result.control.recordId)
    expect(foreign.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'operator-control', authority: 'foreign' }),
        expect.objectContaining({
          kind: 'operator-control',
          authority: 'accounted',
          recordId: result.control.recordId,
        }),
      ]),
    )
    const histories = read.histories.map((history) => (history === home ? foreign : history))
    expect(resolveCauseDependencyControl({ ...input, histories })).toMatchObject({
      state: 'withdrawn',
      control: result.control,
    })
  } finally {
    releaseViewerToken()
    rmSync(artifacts, { recursive: true, force: true })
  }
})
