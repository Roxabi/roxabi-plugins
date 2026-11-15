import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { githubScope, readGitHubHistory } from '../adapters/github/transport.ts'
import { validateRecordGraph } from '../engine/history-graph.ts'
import type { NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { actionRequest, recordStageRef } from '../roxabi/delivery-action.ts'
import type { FixRecord, RecordPublisher } from '../roxabi/fix-contract.ts'
import { prepareCorrectionSynthesis } from '../roxabi/fix-contributions-synthesis.ts'
import { createIdentity } from '../roxabi/fix-entry-lifecycle.ts'
import { createGitHubRecordPublisher } from '../roxabi/github-publisher.ts'
import { prepareUwAction } from '../roxabi/uw-action-inputs.ts'
import { createProductionActionPorts } from '../roxabi/uw-input-readers.ts'
import { multiSlotCorrectionRoot } from './correction-publication-provenance-roots.ts'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { createReviewDriver } from './native-review-driver.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const cwd = process.argv[2]
const statePath = process.env.GH_SIM_STATE
if (!cwd || !statePath) throw new Error('fixture-environment-missing')
await installFixtureSdkSettings(cwd)
const driver = await createReviewDriver(cwd, 128_000, 'feature', true)
let after = driver.messages.length
const intakeReady = driver.nextBatch(after)
await driver.settle(() => ({ attribution: 'change', evidence: null }))
await intakeReady
after = driver.messages.length
const synthesisReady = driver.nextBatch(after)
await driver.settle((task) => reviewInitialData({ ...task, name: 'panel-ci' }))
await synthesisReady
const active = driver.controller.active()
if (!active) throw new Error('synthesis-batch-missing')
await driver.native.stopOwned(active, 'fixture capture before synthesis')
const gh = async (dir: string, args: string[]) =>
  (await promisify(execFile)('gh', args, { cwd: dir, encoding: 'utf8' })).stdout
const scope = githubScope('acme/app', 7)
const options = { cwd, gh, readAuthor: 'operator' }
const history = async () => decodeHistory(await readGitHubHistory(scope, options))
const prefix = await history()
if (!validateRecordGraph(prefix).ok) throw new Error('captured-prefix-invalid')
const records = prefix.operations.flatMap((item) => (item.record ? [item.record] : []))
const initial = records.find(
  (item) => item.kind === 'review-attempt' && item.payload.stage === 'initial' && item.payload.purpose === 'correction',
)
if (
  initial?.kind !== 'review-attempt' ||
  initial.payload.stage !== 'initial' ||
  initial.payload.purpose !== 'correction'
)
  throw new Error('initial-missing')
const initialRequestId = initial.payload.requestId
const oldRequest = records.find((item) => item.kind === 'fix-request' && item.recordId === initialRequestId)
if (oldRequest?.kind !== 'fix-request') throw new Error('request-missing')
const oldOperator = records.find(
  (item) => item.kind === 'contribution' && item.recordId === oldRequest.payload.requestContributionId,
)
if (oldOperator?.kind !== 'contribution') throw new Error('operator-missing')
const intakeSlot = initial.payload.slots[0]
if (!intakeSlot?.action) throw new Error('intake-action-missing')
const action = intakeSlot.action
const manifest = action.inputs.manifest
if (manifest.subject.kind !== 'uw') throw new Error('uw-subject-missing')
const findingsA = records.filter(
  (item): item is Extract<FixRecord, { kind: 'contribution' }> =>
    item.kind === 'contribution' &&
    item.payload.inventoryId === initial.recordId &&
    item.payload.content === 'findings',
)
if (findingsA.length === 0) throw new Error('root-a-findings-missing')
const external = decodeHistory(await readGitHubHistory(manifest.subject.uw, options))
const rawPublisher = createGitHubRecordPublisher(scope, options, null)
const publisher: RecordPublisher = {
  publish: async (item, canPublish) => {
    const result = await rawPublisher.publish(item, [external], canPublish)
    return result.ok ? { ok: true, value: undefined } : result
  },
}
const ports = createProductionActionPorts({
  cwd,
  gh,
  readAuthor: 'operator',
  pluginPin: {
    repository: manifest.plugin.repository,
    commit: manifest.plugin.commit,
    installedRoot: new URL('../', import.meta.url).pathname,
  },
})
const target = {
  ...scope,
  number: 7,
  kind: 'pull-request' as const,
  state: 'open' as const,
  candidateGitSHA: manifest.code.head,
  baseGitSHA: manifest.code.base,
}
const settle = async (batch: NativeBatch): Promise<NativeBatchResult> => {
  const completed = Promise.withResolvers<NativeBatchResult>()
  driver.native.activate(batch, {
    onComplete: (result) => completed.resolve(result),
    onStop: (reason) => completed.reject(new Error(`fixture-native-stopped:${reason}`)),
  })
  await driver.native.announce(batch)
  await driver.settle(() => ({ findings: [] }))
  return completed.promise
}
const fixture = await multiSlotCorrectionRoot({
  cwd,
  gh,
  ports,
  publisher,
  identity: createIdentity('fixture-root-b', 'fixture-root-b-operation'),
  target,
  intakeInputs: action.inputs,
  oldRequest,
  oldOperator,
  role: intakeSlot.role,
  settle,
})
const root = {
  inventory: { scope, kind: 'review-attempt' as const, recordId: fixture.prepared.inventoryId },
  requestId: fixture.prepared.requestId,
}
const sourceA = [...action.inputs.stageSources, ...findingsA.map(recordStageRef)]
const oldRootRequest = actionRequest({
  actionId: 'foreign-root-probe',
  purpose: 'correction',
  subject: fixture.prepared.subject,
  code: manifest.code,
  stageSources: sourceA,
})
const before = JSON.stringify(JSON.parse(readFileSync(statePath, 'utf8')).prs['7'].comments)
const oldRoot = await prepareUwAction(oldRootRequest, ports, undefined, undefined, root)
const task = {
  name: 'fixture-synthesis',
  agent: intakeSlot.role,
  task: 'Synthesize the complete findings.',
  solutionSpace: 'Correction only.',
}
const omitted = await prepareCorrectionSynthesis(
  fixture.prepared,
  createIdentity('fixture-omit', 'fixture-omit-operation'),
  publisher,
  fixture.outputs.slice(0, 1),
  task,
  fixture.operations,
  [],
)
const foreign = await prepareCorrectionSynthesis(
  fixture.prepared,
  createIdentity('fixture-foreign', 'fixture-foreign-operation'),
  publisher,
  findingsA,
  task,
  fixture.operations,
  action.inputs.stageSources,
)
const afterRefusals = JSON.stringify(JSON.parse(readFileSync(statePath, 'utf8')).prs['7'].comments)
const graphAfter = validateRecordGraph(await history())
const baseline = await prepareCorrectionSynthesis(
  fixture.prepared,
  createIdentity('fixture-valid', 'fixture-valid-operation'),
  publisher,
  fixture.outputs,
  task,
  fixture.operations,
  [],
)
const graphFinal = validateRecordGraph(await history())
process.stdout.write(
  `${JSON.stringify({
    oldRoot,
    omitted,
    foreign,
    unchanged: before === afterRefusals,
    graphAfter: graphAfter.ok,
    baseline: baseline.ok,
    graphFinal: graphFinal.ok,
    findingsA: findingsA.length,
    findingsB: fixture.outputs.length,
  })}\n`,
)
process.exit(0)
