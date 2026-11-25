import { expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../../adapters/github/transport.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { interruptedResult, pairOf } from '../../engine/__tests__/workflow-interruption-support.ts'
import { assessFixture, mandateAssessmentState } from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import { classifyAttempts } from '../../engine/workflow-action-interruption.ts'
import { authenticateWorkflowReceiptPair } from '../../engine/workflow-context-terminal.ts'
import { abandoned } from '../../engine/workflow-control.ts'
import { admitFeature } from '../../omp/omp-feature-admission.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { git, readSim } from '../../testing/sandbox/sandbox-repository.ts'
import { branch, fixtures, repository, revoke, seedAuthority, world } from './feature-cli.fixture.ts'

it('admits /feature in place without settling or rewriting an abandoned predecessor’s action history', async () => {
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
  const before = readSim(f.box).issues['42']?.comments
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
  expect(git(f.box, f.cwd, ['rev-parse', 'HEAD'])).toBe(f.tip)
  expect(readSim(f.box).issues['42']?.comments).toEqual(before)

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
  expect(resolveAcceptedSpec(predecessor, [history])).toMatchObject({
    ok: true,
    spec: {
      snapshot: { spec: { criteria: [{ id: 'C1', statement: 'Deliver the change as specified' }] } },
      chain: [{ kind: 'mandate' }, { kind: 'editorial', source: { recordId: assessment.result.recordId } }],
    },
  })
})
