import { actionInputDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { Scope } from '../engine/record-values.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { encodeCriterionRecords } from './criterion-approval.ts'
import { graphFromSimulatedIssues } from './criterion-dispositions.ts'
import { type NativeWorldFacts, nativeImplementationWorld } from './native-implementation-world.ts'
import { roxabiRecordFixtures } from './roxabi-presets.ts'
import { eligiblePlan } from './workflow-decision-cases/support/workflow-decision-fixtures.ts'

export async function sisterImplementationHistory(
  data: { mandate: MandateRecord; own: DecodedHistory; context: { original: Scope }; body: string },
  base: string,
  head: string,
  commits: NativeWorldFacts['commits'],
): Promise<DecodedHistory> {
  const plan = eligiblePlan(data.mandate, [data.own])
    .filter((record) => record.kind !== 'mandate')
    .map((record) => {
      if (record.kind !== 'action-receipt') return record
      const previous = record.payload.inputs
      const manifest = {
        ...previous.manifest,
        code: { repository: data.context.original.repository, base, head: base, referenceCommit: base },
      }
      const built = buildRecord({
        ...record,
        payload: { ...record.payload, inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) } },
      })
      if (!built.ok) throw new Error(`Invalid installed sister plan: ${JSON.stringify(built.diagnostics)}`)
      return built.value
    })
  const planned = encodeCriterionRecords(
    plan,
    data.context.original,
    roxabiRecordFixtures().projection,
    'automation',
    [],
    data.own,
  ).history
  const graph = graphFromSimulatedIssues(data.context.original, [
    {
      number: 42,
      title: 'Original',
      body: data.body,
      updatedAt: '2026-10-27T12:00:00Z',
      state: 'OPEN',
      stateReason: null,
      labels: ['size:S'],
      subIssues: [],
      blockedBy: [],
    },
  ])
  return (
    await nativeImplementationWorld({
      graph,
      histories: [planned],
      scope: data.context.original,
      mandate: data.mandate,
      startHead: base,
      head,
      branch: 'feat/42-save',
      author: 'automation',
      command: 'bun test sister.test.ts',
      output: 'PASS sister fixture',
      commits,
      baseTip: base,
      remoteTipBefore: base,
      remoteTipAfter: head,
      pullRequestsBefore: [],
      pullRequestsAfter: [],
      comparisons: [],
    })
  ).history
}
