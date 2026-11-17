import { encodeRecord } from '../adapters/github/history-codec.ts'
import { buildRecord } from '../engine/record-construction.ts'
import { defaultGh } from '../roxabi/feature-engine.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { featureMandate, pullHistory } from './feature-ci-review-fixture.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'
import { writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const [cwd, boxText, actionFile, scenario] = process.argv.slice(2)
if (!cwd || !boxText || !actionFile) throw new Error('CI race arguments missing')
// Installed SDK settings must exist before the fixture loads the production workflow.
await installFixtureSdkSettings(cwd)
const { loadFeatureWorkflow } = await import('../roxabi/feature-loader.ts')
const { createInstalledUwOperations } = await import('../roxabi/uw-installed-operations.ts')
const box = JSON.parse(boxText) as Box
box.env = process.env
const baseGh = defaultGh()
let injected = false
function appendRaceFrames(bodies: string[]) {
  writeSim(box, (state) => {
    const destination = scenario !== 'binding-race' ? state.issues['42'] : state.prs['7']
    if (!destination) throw new Error('CI race destination missing')
    let id = state.nextCommentId ?? 0
    for (const thread of [...Object.values(state.issues), ...Object.values(state.prs)])
      for (const comment of thread.comments) id = Math.max(id, comment.id ?? 0)
    for (const body of bodies) {
      id++
      destination.comments.push({
        id,
        author: 'operator',
        body,
        createdAt: '2026-10-22T12:00:00Z',
        updatedAt: '2026-10-22T12:00:00Z',
      })
    }
    state.nextCommentId = id
  })
}

function confirmRacePause() {
  const current = featureMandate(box)
  const confirmed = buildRecord({
    version: 1,
    repository: current.record.repository,
    target: current.record.target,
    recordId: 'ci-race-pause-confirmed',
    operationId: 'ci-race-pause-confirm-op',
    runId: 'ci-race-pause-confirm-run',
    kind: 'operator-control',
    payload: {
      control: 'pause-confirmed',
      controlId: 'ci-race-pause',
      predecessor: {
        scope: current.history.source.scope,
        recordId: 'ci-race-pause-request',
        kind: 'operator-control',
      },
      disarm: { observed: true, evidence: { source: 'host' } },
      mandate: { scope: current.history.source.scope, kind: 'mandate', recordId: current.record.recordId },
    },
  })
  if (!confirmed.ok) throw new Error(`CI race pause invalid: ${JSON.stringify(confirmed.diagnostics)}`)
  const framed = encodeRecord(confirmed.value, current.history.source, null)
  if (!framed.ok) throw new Error(`CI race pause encoding failed: ${JSON.stringify(framed.diagnostics)}`)
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('CI race issue missing')
    let id = state.nextCommentId ?? 0
    for (const body of framed.value) {
      id++
      issue.comments.push({
        id,
        author: 'operator',
        body,
        createdAt: '2026-10-22T12:00:01Z',
        updatedAt: '2026-10-22T12:00:01Z',
      })
    }
    state.nextCommentId = id
  })
}

const gh = async (directory: string, args: string[]) => {
  const result = await baseGh(directory, args)
  if (injected || !args.some((arg) => arg.includes('statusCheckRollup'))) return result
  const history = pullHistory(box)
  const start = history.operations.find(
    ({ record }) =>
      record?.kind === 'action-receipt' &&
      record.payload.action === 'attribute-ci' &&
      record.payload.phase === 'start' &&
      record.payload.actionId === 'expanded-ci',
  )
  if (!start) return result
  const mandate = featureMandate(box)
  const original = history.operations.find(({ record }) => record?.kind === 'workflow-binding')?.record
  if (original?.kind !== 'workflow-binding') throw new Error('CI race original binding missing')
  const built =
    scenario === 'binding-race'
      ? buildRecord({
          ...original,
          recordId: 'ci-race-binding-b2',
          operationId: 'ci-race-operation-b2',
          runId: 'ci-race-run-b2',
        })
      : buildRecord({
          version: 1,
          repository: mandate.record.repository,
          target: mandate.record.target,
          recordId: scenario === 'abandon-race' ? 'ci-race-abandon' : 'ci-race-pause-request',
          operationId: 'ci-race-control-op',
          runId: 'ci-race-control-run',
          kind: 'operator-control',
          payload: {
            control: scenario === 'abandon-race' ? 'abandon' : 'pause-requested',
            controlId: scenario === 'abandon-race' ? 'ci-race-abandon' : 'ci-race-pause',
            mandate: { scope: mandate.history.source.scope, kind: 'mandate', recordId: mandate.record.recordId },
            predecessor: null,
          },
        })
  if (!built.ok) throw new Error(`CI race record invalid: ${JSON.stringify(built.diagnostics)}`)
  const encoded =
    scenario !== 'binding-race'
      ? encodeRecord(built.value, mandate.history.source, null)
      : encodeRecord(built.value, history.source, null, [mandate.history])
  if (!encoded.ok) throw new Error(`CI race encoding failed: ${JSON.stringify(encoded.diagnostics)}`)
  appendRaceFrames(encoded.value)
  if (scenario === 'pause-confirmed-race') confirmRacePause()
  injected = true
  return result
}
const operator: OperatorPort = {
  async executeConfirmed(prepared, action) {
    return {
      status: 'confirmed',
      value: await action({
        route: 'omp-native-command',
        operationId: prepared.proposal.operationId,
        proposalDigest: prepared.digest,
        confirmedAt: '2026-10-22T12:00:00.000Z',
      }),
    }
  },
}
const workflow = await loadFeatureWorkflow()
const uw = await createInstalledUwOperations({ cwd, operator, gh })
const result = await workflow.continueFeature({
  cwd,
  reference: '#42',
  control: 'recover-context',
  principal: false,
  contextRecovery: { actionFile },
  uw,
  gh,
})
const records = pullHistory(box).operations.flatMap(({ record }) => (record ? [record] : []))
process.stdout.write(
  `${JSON.stringify({ injected, result, records, mandateRecords: featureMandate(box).history.operations.flatMap(({ record }) => (record ? [record] : [])) })}\n`,
)
