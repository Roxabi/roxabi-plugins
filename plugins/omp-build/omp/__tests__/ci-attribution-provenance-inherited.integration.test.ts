import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import { actionRequest, confirmPreparedAction, uwSubject } from '../../roxabi/delivery-action.ts'
import { sealReceipt } from '../../roxabi/feature-action-receipt.ts'
import { readNativeCiFailureEvidence } from '../../roxabi/feature-ci-evidence.ts'
import { loadContracts } from '../../roxabi/feature-engine.ts'
import { publishFeatureNativeResult } from '../../roxabi/feature-result.ts'
import type { RecordInputRef } from '../../roxabi/uw-action-contract.ts'
import { prepareUwAction, replayUwActionInputs } from '../../roxabi/uw-action-inputs.ts'
import type { UwOperations } from '../../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { assertParentRefusals } from '../../testing/ci-attribution-provenance-inherited-parent.ts'
import { captureNativeTask } from '../../testing/native-action-capture.ts'
import { nativeActionFixturePorts } from '../../testing/native-action-ports.ts'
import { runNestedDeliveryScenario } from '../../testing/nested-delivery-world.ts'

type NestedContext = Parameters<NonNullable<Parameters<typeof runNestedDeliveryScenario>[3]>>[0]

async function prepareInheritedAttribution(context: NestedContext, artifactsDir: string) {
  const { world, scenario, produced, parents, git, parent } = context
  const head = git.heads[0]
  const merge = git.merges[0]
  if (!head || !merge) throw new Error('nested-commits-missing')
  world.observePullRequest({
    scope: scenario.pullRequest,
    branch: 'feature/202-leaf',
    base: 'main',
    head,
    baseTip: git.p0,
    state: 'OPEN',
    mergeCommit: null,
    author: 'operator',
  })
  const pull = JSON.parse(
    await world.gh(world.cwd, [
      'pr',
      'view',
      '302',
      '--repo',
      scenario.leaf.repository,
      '--json',
      'headRefOid,baseRefOid,headRefName,baseRefName,state,mergeCommit',
    ]),
  )
  expect(pull).toMatchObject({ state: 'OPEN', headRefOid: head, baseRefName: 'main' })
  const gh: typeof world.gh = async (cwd, args) => {
    if (
      args[0] === 'api' &&
      args[1] === 'graphql' &&
      args.includes(`sha=${head}`) &&
      args.some((arg) => arg.includes('contexts(first: 100, after: $after)'))
    ) {
      return JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: 'StatusContext',
                      id: 'nested-ci-failure',
                      context: 'nested-ci',
                      state: 'FAILURE',
                    },
                  ],
                },
              },
            },
          },
        },
      })
    }
    return world.gh(cwd, args)
  }
  const installed = await createInstalledUwOperations({
    cwd: world.cwd,
    artifactsDir,
    gh,
    readAuthor: 'operator',
    operator: {
      async executeConfirmed() {
        throw new Error('No operator mutation is authorized')
      },
    },
  })
  const bytes = execFileSync('git', ['-C', git.cwd, 'show', `${merge}:fixture.txt`])
  const file = {
    source: 'git-file' as const,
    repository: scenario.leaf.repository,
    commit: merge,
    path: 'fixture.txt',
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
  const ports = nativeActionFixturePorts({
    cwd: world.cwd,
    artifactsDir,
    gh,
    git: world.git,
    author: 'operator',
    plugin: standaloneReviewInputs().manifest.plugin,
    commits: new Map(scenario.facts.commits.map((commit) => [commit.sha, commit])),
    diffs: new Map([[`${git.p0}\0${head}`, git.diff(git.p0, head)]]),
    repositoryFiles: new Map([[`${file.repository}\0${file.commit}\0${file.path}`, { ref: file, bytes }]]),
  })
  const operations: UwOperations = {
    ...installed,
    prepareAction: (request, projection, review, correctionRoot) =>
      prepareUwAction(request, ports, projection, review, correctionRoot),
    replayActionInputs: (request) => replayUwActionInputs(request, ports),
  }
  const loaded = await loadContracts()
  if ('missing' in loaded) throw new Error(`engine-missing:${loaded.missing}`)
  const evidence = await readNativeCiFailureEvidence(world.cwd, scenario.leaf.repository, head, scenario.pullRequest, {
    gh,
    failedCheckEvidenceDigest: loaded.failedCheckEvidenceDigest,
  })
  if (!evidence.ok) throw new Error(`nested-ci-evidence:${evidence.reason}`)
  const exactInputs = {
    candidateGitSHA: head,
    scope: scenario.pullRequest,
    failedChecks: evidence.failedChecks,
    failures: evidence.failures,
    evidenceDigest: evidence.evidenceDigest,
  }
  const code = { repository: scenario.leaf.repository, base: git.p0, head, referenceCommit: head }
  const actionId = randomUUID()
  const prepared = await confirmPreparedAction(
    operations,
    actionRequest({
      actionId,
      purpose: 'attribute-ci',
      subject: uwSubject(scenario.leaf, scenario.pullRequest),
      code,
      operands: { action: 'attribute-ci', exactInputs },
    }),
  )
  if (!prepared.ok) throw new Error(`nested-attribution-prepare:${JSON.stringify(prepared.diagnostics)}`)
  expect(prepared.value.inputs.manifest.deliveryData.some((item) => item.role === 'plan')).toBe(true)
  const current = await operations.readUw(scenario.leaf)
  const pullHistory = current.histories.find((item) => item.source.scope.target === scenario.pullRequest.target)
  if (!pullHistory) throw new Error('nested-pull-history-missing')
  const opened = await sealReceipt({
    loaded,
    history: pullHistory,
    scope: scenario.pullRequest,
    cwd: world.cwd,
    gh,
    parents: [produced.history, ...parents],
    operationId: actionId,
    action: 'attribute-ci',
    mandate: { scope: scenario.leaf, kind: 'mandate', recordId: scenario.leafMandate.recordId },
    exactInputs,
    native: { branch: 'feature/202-leaf', base: 'main' },
    prepared: prepared.value,
  })
  if (opened.kind !== 'action' || opened.node !== 'attribute-ci')
    throw new Error(`nested-attribution-open:${JSON.stringify(opened)}`)
  const result = await captureNativeTask({
    batch: opened.followUp,
    cwd: world.cwd,
    childId: 'nested-attribution',
    command: 'true',
    toolCallId: 'nested-ci-observation',
    output: '',
    claim: { attribution: 'change', evidence: null },
    expectedRuns: 0,
    git: { repository: scenario.leaf.repository, commit: head, tree: parent.tree(head) },
  })
  const published = await publishFeatureNativeResult({
    cwd: world.cwd,
    gh,
    git: world.git,
    start: opened.start,
    result,
  })
  if (!published.published) throw new Error(`nested-attribution-publish:${published.reason}`)
  if (!published.receipt) throw new Error('nested-attribution-publication-ref-missing')
  return { operations, exactInputs, code, published }
}

type InheritedFixture = Awaited<ReturnType<typeof prepareInheritedAttribution>>

async function prepareInheritedIntake(context: NestedContext, fixture: InheritedFixture) {
  const { scenario } = context
  const { operations, code, published } = fixture
  const read = await operations.readUw(scenario.leaf)
  const history = read.histories.find((item) => item.source.scope.target === scenario.pullRequest.target)
  const receipt = history?.operations.find((item) => item.recordId === published.receipt?.recordId)?.record
  if (
    receipt?.kind !== 'action-receipt' ||
    receipt.payload.action !== 'attribute-ci' ||
    receipt.payload.phase !== 'result'
  )
    throw new Error('nested-attribution-result-missing')
  const receiptPayload = receipt.payload
  expect(scenario.leafMandate.payload.parent).not.toBeNull()
  expect(scenario.leafMandate.payload.inheritedOwnSpecRefs.length).toBeGreaterThan(0)
  expect(scenario.leafMandate.payload.ownSpec.uw).toEqual(scenario.leaf)
  const receiptSubject = receipt.payload.inputs.manifest.subject
  if (receiptSubject.kind !== 'uw' || !receiptSubject.binding) throw new Error('nested-attribution-subject-missing')
  expect(receiptSubject.uw).toEqual(scenario.leaf)
  const receiptSpec = receipt.payload.inputs.manifest.spec
  if (receiptSpec.kind !== 'accepted') throw new Error('nested-attribution-spec-missing')
  expect(receiptSpec.effective.own.uw).toEqual(scenario.leaf)
  expect(receiptSpec.effective.versionVector.length).toBeGreaterThan(1)
  expect(receipt.payload.mandate).toEqual({
    scope: scenario.leaf,
    kind: 'mandate',
    recordId: scenario.leafMandate.recordId,
  })
  const ref: RecordInputRef = {
    source: 'record',
    record: { scope: scenario.pullRequest, kind: 'action-receipt', recordId: receipt.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(receipt.payload),
  }
  const intake = await confirmPreparedAction(
    operations,
    actionRequest({
      actionId: randomUUID(),
      purpose: 'correction',
      subject: uwSubject(scenario.leaf, scenario.pullRequest),
      code,
      stageSources: [ref],
    }),
  )
  if (!intake.ok) throw new Error(`nested-intake-prepare:${JSON.stringify(intake.diagnostics)}`)
  const intakeSubject = intake.value.inputs.manifest.subject
  if (intakeSubject.kind !== 'uw') throw new Error('nested-intake-subject-missing')
  expect(intakeSubject.binding).toEqual(receiptSubject.binding)
  expect(intakeSubject.uw).toEqual(scenario.leaf)
  expect(intake.value.inputs.stageSources).toEqual([ref])
  return { history, receipt: { ...receipt, payload: receiptPayload }, receiptSubject, intakeSubject, ref }
}

it('admits an inherited child attribution sealed by the host before correction prepare', async () => {
  await runNestedDeliveryScenario('complete', undefined, undefined, async (context) => {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'ci-attribution-inherited-'))
    try {
      const fixture = await prepareInheritedAttribution(context, artifactsDir)
      const positive = await prepareInheritedIntake(context, fixture)
      await assertParentRefusals(context, fixture, positive)
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })
})
