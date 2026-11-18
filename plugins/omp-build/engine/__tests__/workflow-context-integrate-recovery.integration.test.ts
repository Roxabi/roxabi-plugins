import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import type { ContinueFeatureResult } from '../../roxabi/feature-contract.ts'
import { publishFeatureNativeResult } from '../../roxabi/feature-result.ts'
import { currentParentIntegration } from '../../roxabi/uw-parent-current-integration.ts'
import { continueFeature } from '../../roxabi/workflow.ts'
import { withEpicEffects } from '../../skills/feature/epic-driver-runtime.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceNativePlan } from '../../testing/native-plan-producer.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { criterionTargetSchema } from '../finding-target-schema.ts'
import { scopeKey } from '../uw-graph.ts'
import { bindExternalRef, historyFor, recordsOf } from '../workflow-control.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'
import { clear } from './workflow-captured-world-fixture.ts'

it('recovers a native parent integration context negative through the public action and admits the real successor', async () => {
  const checkout = nativeImplementationGit()
  try {
    const [first, second, third] = checkout.merges
    if (!first || !second || !third) throw new Error('Expected three child merges')
    await checkout.publishBase(third)
    const parent = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
    const fileBytes = execFileSync('git', ['-C', parent.cwd, 'show', `${third}:fixture.txt`])
    const fileDigest = createHash('sha256').update(fileBytes).digest('hex')
    await threeDeliveredChildren(
      {
        ...checkout,
        cwd: parent.cwd,
        trees: checkout.heads.map(checkout.tree),
        baseTrees: [checkout.p0, first, second].map(checkout.tree),
        mergeTrees: checkout.merges.map(checkout.tree),
        parentTree: checkout.tree(checkout.parentHead),
        diff: checkout.diff(third, checkout.parentHead),
        repositoryFiles: [
          {
            ref: { source: 'git-file', repository: 'acme/app', commit: third, path: 'fixture.txt', digest: fileDigest },
            bytes: fileBytes,
          },
        ],
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'framed',
      async (world) =>
        withEpicEffects(
          {
            git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }),
            gh: (cwd, args, input) => {
              if (input !== undefined) throw new Error('Unexpected stdin in declared GitHub transport')
              return world.ghSync(cwd, args)
            },
            uw: world.operations,
            uwReadAuthor: 'operator',
          },
          async () => {
            parent.checkout(third)
            await produceNativePlan({
              world: { cwd: parent.cwd, gh: world.gh, git: world.git, operations: world.operations },
              scope: world.parentScope,
              mandate: world.parent,
              parentScopes: [],
              git: { repository: world.parentScope.repository, commit: third, tree: checkout.tree(third) },
              output: {
                steps: [
                  {
                    id: 'parent-integration',
                    criterionIds: ['C1'],
                    change: 'Integrate the delivered children',
                    doneWhen: 'Save keeps the selected region',
                    evidence: 'The parent integration test verifies the criterion',
                    paths: ['fixture.txt'],
                  },
                ],
                resolutions: [],
              },
              reviews: [clear, clear],
            })
            const before = await world.operations.readUw(world.parentScope)
            function acceptedParent() {
              if (before.accepted.status !== 'accepted') throw new Error('Parent spec unavailable')
              return before.accepted.value
            }
            const accepted = acceptedParent()
            const children = world.reviews.map(({ uw }) => {
              const completion = before.completion.completions.get(scopeKey(uw))
              if (completion?.state !== 'complete') throw new Error('Child completion missing')
              return { spec: completion.spec, code: completion.code, sources: [...completion.sources] }
            })
            async function openInitialIntegration() {
              const opened: Array<Extract<ContinueFeatureResult, { kind: 'action' }>> = []
              const stopAfterStart = new Error('fixture-stop-after-start')
              try {
                const initial = parent.observe()
                await produceParentIntegration(world, parent, {
                  initial,
                  candidate: initial,
                  command: 'bun test parent.test.ts',
                  output: 'PASS',
                  observeStart(value) {
                    if (value.kind === 'action') opened.push(value)
                    throw stopAfterStart
                  },
                })
              } catch (error) {
                if (error !== stopAfterStart) throw error
              }
              const initialStart = opened[0]
              if (initialStart?.node !== 'integrate') throw new Error('Integration START missing')
              return initialStart
            }
            const initialStart = await openInitialIntegration()
            const task = initialStart.followUp.tasks.tasks[0]
            if (!task) throw new Error('Integration task missing')
            const root = { ...consultableAgentRoot(), cwd: parent.cwd }
            const identity = { repository: world.parentScope.repository, commit: third, tree: checkout.tree(third) }
            const negative = {
              outcome: 'missing-context',
              missing: [
                {
                  locator: { kind: 'information-request', description: 'Parent integration evidence' },
                  reason: 'Required to integrate the children',
                  targets: [],
                },
              ],
            }
            async function settleInitialNegative() {
              const harness = bridgeHarness()
              harness.controller.bindHostGit(() => identity)
              let stopped = false
              harness.controller.activate(initialStart.followUp, {
                onComplete: async () => {
                  throw new Error('Negative completed as positive')
                },
                onStop: async (reason, result) => {
                  expect(reason).toBe('action-context-missing')
                  if (result?.canPublishContext?.() !== true) throw new Error('Missing native settlement ownership')
                  const published = await publishFeatureNativeResult({
                    cwd: parent.cwd,
                    start: initialStart.start,
                    result,
                    gh: world.gh,
                    git: world.git,
                    current: () => result.canPublishContext?.() === true,
                  })
                  expect(published).toMatchObject({ published: true })
                  stopped = true
                },
              })
              expect(await harness.admitBatch(initialStart.followUp, 'initial-integrate', root)).toBe(true)
              await harness.admitChild(initialStart.followUp, task.name, 'initial-child', {
                toolCallId: 'initial-integrate',
                root,
                skipRootCall: true,
              })
              await harness.yieldChild('initial-child', negative)
              await harness.settleBatch({
                toolCallId: 'initial-integrate',
                errors: [],
                results: [
                  {
                    index: 0,
                    id: 'initial-child',
                    agent: task.agent,
                    exitCode: 0,
                    structuredOutput: { status: 'valid', data: negative },
                  },
                ],
              })
              expect(stopped).toBe(true)
              const afterNegative = await world.operations.readUw(world.parentScope)
              const negativeReceipt = afterNegative.histories
                .flatMap(recordsOf)
                .find(
                  (record) =>
                    record.kind === 'action-receipt' &&
                    record.payload.action === 'integrate' &&
                    record.payload.phase === 'result' &&
                    record.payload.start.recordId === initialStart.start.recordId,
                )
              if (
                negativeReceipt?.kind !== 'action-receipt' ||
                negativeReceipt.payload.action !== 'integrate' ||
                negativeReceipt.payload.phase !== 'result'
              )
                throw new Error('Native negative receipt missing')
              expect(negativeReceipt.payload.structured).toEqual(negative)
              expect(negativeReceipt.payload.admission).toBeNull()
              return { negativeReceipt, afterNegative }
            }
            const { negativeReceipt, afterNegative } = await settleInitialNegative()
            const inputs = task.action.inputs
            const manifest = inputs.manifest
            const startHistory = historyFor(initialStart.start.scope, afterNegative.histories)
            if (!startHistory) throw new Error('Initial integration history missing')
            const initialRecord = bindExternalRef(initialStart.start, startHistory)
            if (!initialRecord.ok || initialRecord.value.kind !== 'action-receipt')
              throw new Error('Initial integration START unauthenticated')
            const request = {
              actionId: 'expanded-parent-integration',
              purpose: manifest.purpose,
              subject: manifest.subject,
              code: manifest.code,
              ...(manifest.operands === undefined ? {} : { operands: manifest.operands }),
              stageSources: inputs.stageSources,
              expandedContext: [
                ...manifest.expandedContext,
                {
                  source: 'record',
                  record: { scope: world.parentScope, kind: 'action-receipt', recordId: negativeReceipt.recordId },
                  selector: '/payload',
                  digest: canonicalValueDigest(negativeReceipt.payload),
                },
                {
                  source: 'record',
                  record: initialStart.start,
                  selector: '/payload',
                  digest: canonicalValueDigest(initialRecord.value.payload),
                },
                {
                  source: 'git-file',
                  repository: world.parentScope.repository,
                  commit: third,
                  path: 'fixture.txt',
                  digest: fileDigest,
                },
              ],
            }
            const actionFile = join(dirname(checkout.cwd), 'integrate-recovery.json')
            writeFileSync(actionFile, JSON.stringify({ request }))
            const continuation = {
              cwd: parent.cwd,
              reference: '#200',
              principal: false,
              gh: world.gh,
              git: world.git,
              uw: world.operations,
            }
            async function recoverIntegration() {
              const cold = await continueFeature({ ...continuation, control: 'continue' })
              expect(cold).toMatchObject({ kind: 'blocked' })
              const foreignFile = join(dirname(checkout.cwd), 'foreign-integrate-recovery.json')
              writeFileSync(
                foreignFile,
                JSON.stringify({
                  request: { ...request, expandedContext: [{ ...request.expandedContext[0], digest: '0'.repeat(64) }] },
                }),
              )
              expect(
                await continueFeature({
                  ...continuation,
                  control: 'recover-context',
                  contextRecovery: { actionFile: foreignFile },
                }),
              ).toMatchObject({ kind: 'blocked' })
              const recovered = await continueFeature({
                ...continuation,
                control: 'recover-context',
                contextRecovery: { actionFile },
              })
              if (recovered.kind !== 'action' || recovered.node !== 'integrate')
                throw new Error(`Recovery refused: ${JSON.stringify(recovered)}`)
              const recoveredTask = recovered.followUp.tasks.tasks[0]
              if (!recoveredTask) throw new Error('Recovered integration task missing')
              return { recovered, recoveredTask }
            }
            const { recovered, recoveredTask } = await recoverIntegration()
            const code = recoveredTask.action.inputs.manifest.code
            const target = criterionTargetSchema.parse({
              format: 'omp-build-finding-target/1',
              kind: 'criterion',
              spec: accepted.ref,
              id: 'C1',
            })
            const model = {
              outcome: 'integrated',
              code,
              children,
              coverage: accepted.coverage,
              commands: [{ toolCallId: 'parent-proof', command: 'bun test parent.test.ts', exitCode: 0 }],
              criteria: [
                {
                  target,
                  verification: 'evidence',
                  evidence: [
                    {
                      id: 'parent-test-C1',
                      target,
                      method: 'test',
                      scenario: 'Save keeps the selected region',
                      before: null,
                      after: {
                        toolCallId: 'parent-proof',
                        versionClaim: {
                          code: { repository: code.repository, commit: code.head },
                          reason: 'captured candidate',
                          references: [],
                        },
                      },
                    },
                  ],
                },
              ],
              reason: 'integrated and checked',
            }
            const successor = bridgeHarness()
            successor.controller.bindHostGit(() => identity)
            let published = false
            successor.controller.activate(recovered.followUp, {
              onComplete: async (result, canContinue) => {
                const value = await publishFeatureNativeResult({
                  cwd: parent.cwd,
                  start: recovered.start,
                  result,
                  gh: world.gh,
                  git: world.git,
                  current: canContinue,
                })
                expect(value).toMatchObject({ published: true })
                published = true
              },
              onStop: async (reason) => {
                throw new Error(`Unexpected successor stop: ${reason}`)
              },
            })
            expect(await successor.admitBatch(recovered.followUp, 'recovered-integrate', root)).toBe(true)
            const child = await successor.admitChild(recovered.followUp, recoveredTask.name, 'recovered-child', {
              toolCallId: 'recovered-integrate',
              root,
              skipRootCall: true,
            })
            await child.call('bash', 'parent-proof', { command: 'bun test parent.test.ts' })
            await child.result(
              'bash',
              'parent-proof',
              { command: 'bun test parent.test.ts' },
              {
                content: [{ type: 'text', text: 'PASS parent integration' }],
                details: { exitCode: 0 },
                isError: false,
              },
            )
            await successor.yieldChild('recovered-child', model)
            await successor.settleBatch({
              toolCallId: 'recovered-integrate',
              errors: [],
              results: [
                {
                  index: 0,
                  id: 'recovered-child',
                  agent: recoveredTask.agent,
                  exitCode: 0,
                  structuredOutput: { status: 'valid', data: model },
                },
              ],
            })
            expect(published).toBe(true)
            async function assertRecoveredReadback() {
              const after = await world.operations.readUw(world.parentScope)
              const history = historyFor(recovered.start.scope, after.histories)
              if (!history) throw new Error('Recovery history missing')
              const start = bindExternalRef(recovered.start, history)
              expect(start.ok).toBe(true)
              const receipt = after.histories
                .flatMap(recordsOf)
                .find(
                  (record) =>
                    record.kind === 'action-receipt' &&
                    record.payload.action === 'integrate' &&
                    record.payload.phase === 'result' &&
                    record.payload.start.recordId === recovered.start.recordId,
                )
              if (
                receipt?.kind !== 'action-receipt' ||
                receipt.payload.action !== 'integrate' ||
                receipt.payload.phase !== 'result'
              )
                throw new Error('Recovered result missing')
              expect(receipt.payload).toMatchObject({
                structured: { outcome: 'integrated' },
                admission: { admitted: true, remoteTip: third },
              })
              const selected = currentParentIntegration(after, code.base, third)
              expect(selected.ok && selected.value?.source.record.recordId).toBe(receipt.recordId)
              expect(
                await continueFeature({ ...continuation, control: 'recover-context', contextRecovery: { actionFile } }),
              ).toMatchObject({ kind: 'blocked' })
              const reread = await world.operations.readUw(world.parentScope)
              expect(
                reread.histories
                  .flatMap(recordsOf)
                  .filter(
                    (record) =>
                      record.kind === 'action-receipt' &&
                      record.payload.action === 'integrate' &&
                      record.payload.phase === 'start',
                  ),
              ).toHaveLength(2)
              expect(
                reread.histories.flatMap(recordsOf).some((record) => record.recordId === negativeReceipt.recordId),
              ).toBe(true)
            }
            await assertRecoveredReadback()
          },
        ),
    )
  } finally {
    cleanupFixtureActions()
    checkout.cleanup()
  }
}, 120_000)
