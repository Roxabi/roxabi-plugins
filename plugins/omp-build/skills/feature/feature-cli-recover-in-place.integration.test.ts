import { expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../../adapters/github/transport.ts'
import type { Gh } from '../../adapters/github/types.ts'
import {
  appendRecords,
  interruptedResult,
  interruptionResolution,
  pairOf,
  receiptOf,
} from '../../engine/__tests__/workflow-interruption-support.ts'
import { assessFixture, mandateAssessmentState } from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import { classifyAttempts } from '../../engine/workflow-action-interruption.ts'
import { authenticateWorkflowReceiptPair } from '../../engine/workflow-context-terminal.ts'
import { abandoned } from '../../engine/workflow-control.ts'
import { admitFeature } from '../../omp/omp-feature-admission.ts'
import { featureSpecDigest } from '../../roxabi/feature-spec-digest.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import {
  branch,
  fixtures,
  invoke,
  ref,
  repository,
  revoke,
  seedAuthority,
  seedLandingChecks,
  world,
} from './feature-cli.fixture.ts'

it('admits and lands /feature in place without settling or rewriting an abandoned predecessor’s action history', async () => {
  const f = world()
  const scope = { repository, target: `${repository}#42` }
  const predecessor = f.mandate
  const { next: current, records } = revoke(f, branch)
  const code = { repository, base: f.base, head: f.tip, referenceCommit: f.tip }
  const actions = roxabiWorkflowFixtures(undefined, undefined, undefined, code)
  const [orphan] = pairOf(actions.planDraftRecords(predecessor, 'predecessor-orphan'))
  const [interruptedStart, unfinishedResult] = pairOf(actions.planDraftRecords(predecessor, 'predecessor-interrupted'))
  const interrupted = interruptedResult(unfinishedResult)
  const implementationStart = actions.implementStart(predecessor)
  const rejected = actions.rejectedImplementResult(predecessor)
  const accepted = mandateAssessmentState(predecessor)
  const { ownSpec } = nativeFeatureSpec(scope, 'Deliver the change as specified')
  const { ref: _ref, ...proposed } = accepted
  const assessment = assessFixture(
    predecessor,
    'predecessor-assessment',
    accepted,
    { ...proposed, snapshot: ownSpec.snapshot },
    'editorial',
    [fixtures.historyFrom([predecessor])],
    undefined,
    undefined,
    code,
  )
  seedAuthority(f.box, [
    predecessor,
    assessment.start,
    assessment.result,
    orphan,
    interruptedStart,
    interrupted,
    implementationStart,
    rejected,
    ...records.slice(1),
  ])
  const gh: Gh = async (cwd, args) => fixtureCatalogueGhResponse(args) ?? f.gh(cwd, args)
  const uw = await createInstalledUwOperations({
    cwd: f.cwd,
    gh,
    operator: {
      async executeConfirmed() {
        throw new Error('Recovery on the current mandate must not request another approval')
      },
    },
  })

  const history = decodeHistory(await readGitHubHistory(scope, { cwd: f.cwd, gh, readAuthor: 'operator' }))
  expect(abandoned(history, predecessor)).toBe(true)
  expect(
    classifyAttempts({ histories: [history], scan: [history], actions: ['plan', 'implement', 'assess-spec'] }),
  ).toMatchObject({
    ok: true,
    value: {
      unresolved: [
        { kind: 'orphan', action: 'plan', start: { recordId: orphan.recordId } },
        {
          kind: 'interrupted',
          action: 'plan',
          start: { recordId: interruptedStart.recordId },
          result: { recordId: interrupted.recordId },
        },
      ],
    },
  })
  expect(authenticateWorkflowReceiptPair(history, rejected, { native: 'unchecked' })).toMatchObject({
    ok: true,
    value: {
      start: { recordId: implementationStart.recordId },
      result: {
        recordId: rejected.recordId,
        payload: { admission: { admitted: false, published: false, reason: 'remote tip unreachable' } },
      },
    },
  })
  const stoppedAssessment = assessFixture(
    predecessor,
    'predecessor-stopped-assessment',
    accepted,
    { ...proposed, snapshot: ownSpec.snapshot },
    'editorial',
    [fixtures.historyFrom([predecessor])],
    undefined,
    undefined,
    code,
  )
  const stoppedResult = interruptedResult(receiptOf(stoppedAssessment.result))
  const pause = fixtures.pauseRequested(predecessor)
  const resolution = interruptionResolution({
    mandate: predecessor,
    pause: fixtures.pauseConfirmed(predecessor, pause),
    start: receiptOf(stoppedAssessment.start),
    result: stoppedResult,
  })
  // Reproduce a decoded control left behind after its cited pause became unavailable.
  const appended = appendRecords(history, [stoppedAssessment.start, stoppedResult, resolution])
  writeSim(f.box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Expected issue')
    for (const comment of appended.source.comments.slice(history.source.comments.length)) {
      issue.comments.push({
        id: Number(comment.nativeId),
        author: 'operator',
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })
    }
  })
  const before = readSim(f.box).issues['42']?.comments
  const recoveryHistory = decodeHistory(await readGitHubHistory(scope, { cwd: f.cwd, gh, readAuthor: 'operator' }))
  expect(recoveryHistory.operations).toContainEqual(
    expect.objectContaining({ recordId: resolution.recordId, status: 'complete', authority: 'accounted' }),
  )
  expect(
    classifyAttempts({ histories: [recoveryHistory], scan: [recoveryHistory], actions: ['assess-spec'] }),
  ).toMatchObject({
    ok: false,
    diagnostics: [
      {
        code: 'interruption-resolution-invalid',
        recordId: resolution.recordId,
        message: 'Resolution predecessor does not bind one authenticated control',
      },
    ],
  })
  expect(resolveAcceptedSpec(predecessor, [recoveryHistory])).toMatchObject({
    ok: true,
    spec: {
      snapshot: { spec: { criteria: [{ id: 'C1', statement: 'Deliver the change as specified' }] } },
      chain: [{ kind: 'mandate' }, { kind: 'editorial', source: { recordId: assessment.result.recordId } }],
    },
  })

  f.bare('update-ref', '-d', ref)
  const admission = await admitFeature({
    cwd: f.cwd,
    reference: scope.target,
    control: 'select',
    principal: false,
    gh,
    git: f.gitRunner,
    uw,
  })
  expect(admission, JSON.stringify(admission)).toMatchObject({
    kind: 'ready',
    mandate: current.recordId,
    branch,
    base: 'main',
    worktree: f.cwd,
    acceptedSpec: { own: { sourceAccepted: { recordId: current.recordId } } },
  })
  if (admission.kind !== 'ready') throw new Error('Expected delivery admission')
  expect(git(f.box, f.cwd, ['rev-parse', 'HEAD'])).toBe(f.tip)
  expect(readSim(f.box).issues['42']?.comments).toEqual(before)

  const options = { gh, mandate: current.recordId }
  expect(await invoke(f, 'push', ['--tip', f.tip], options)).toMatchObject({ code: 0, status: 'pushed', head: f.tip })
  expect(f.bare('rev-parse', ref)).toBe(f.tip)
  const opened = 100
  const binding = `workflow-binding:${repository}#${opened}:${current.recordId}`
  expect(await invoke(f, 'open-pr', ['--tip', f.tip], options)).toMatchObject({
    code: 0,
    status: 'created',
    pr: opened,
    head: f.tip,
    binding,
  })
  seedLandingChecks(f.box, 'main', f.tip, 17)
  const spec = featureSpecDigest(admission.acceptedSpec)
  expect(await invoke(f, 'land', ['--pr', String(opened), '--head', f.tip, '--spec', spec], options)).toMatchObject({
    code: 0,
    status: 'merged',
    head: f.tip,
    pr: opened,
  })
  expect(readSim(f.box).prs[String(opened)]?.state).toBe('MERGED')
  expect(f.bare('rev-parse', 'main^2')).toBe(f.tip)
  expect(readSim(f.box).issues['42']?.comments).toEqual(before)
})
