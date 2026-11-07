import type { Gh } from '../adapters/github/types.ts'
import { criterionTargetSchema } from '../engine/finding-target-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Json, Scope } from '../engine/record-values.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { startImplement } from '../roxabi/feature-action-start.ts'
import { loadContracts } from '../roxabi/feature-engine.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import type { UwOperations, UwRead } from '../roxabi/uw-contract.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import { captureNativeTask } from './native-action-capture.ts'

async function observedImplementationCommits(
  git: GitRunner,
  cwd: string,
  startHead: string,
  head: string,
  tree: string,
) {
  const observedHead = await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const observedTree = await git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}'])
  if (
    observedHead.code !== 0 ||
    observedTree.code !== 0 ||
    observedHead.stdout.trim() !== head ||
    observedTree.stdout.trim() !== tree
  )
    throw new Error('Native task Git identity does not match the observed checkout')
  const range = await git(cwd, ['rev-list', '--first-parent', '--reverse', `${startHead}..${head}`])
  const commitSHAs = range.stdout.trim() === '' ? [] : range.stdout.trim().split(/\s+/)
  if (
    range.code !== 0 ||
    commitSHAs.length === 0 ||
    commitSHAs.at(-1) !== head ||
    commitSHAs.some((sha) => !/^[0-9a-f]{40}$/.test(sha)) ||
    new Set(commitSHAs).size !== commitSHAs.length
  )
    throw new Error('Implemented outcome requires a nonempty observed first-parent commit range')
  return commitSHAs
}

async function refuseImplementationPublication(
  operations: UwOperations,
  scope: Scope,
  actionId: string,
  published: unknown,
): Promise<never> {
  const read = await operations.readUw(scope)
  const history = read.histories.find(
    (entry) => entry.source.scope.repository === scope.repository && entry.source.scope.target === scope.target,
  )
  const retained =
    history === undefined
      ? []
      : recordsOf(history).filter(
          (record) =>
            record.kind === 'action-receipt' &&
            record.payload.action === 'implement' &&
            record.payload.phase === 'result' &&
            record.payload.actionId === actionId,
        )
  throw new Error(
    `Implementation publication refused: ${JSON.stringify(
      { published, retained, accepted: read.accepted, identity: read.identity, observation: read.observation },
      null,
      2,
    )}`,
  )
}

/**
 * Run the real implementation start, native event capture, admission and result publisher.
 * The caller owns the independent, mutable native/Git world and its observed histories.
 */
export async function produceNativeImplementation(input: {
  cwd: string
  gh: Gh
  git: GitRunner
  operations: UwOperations
  read: UwRead
  scope: Scope
  mandate: MandateRecord
  parents: readonly DecodedHistory[]
  startHead: string
  command: string
  output: string
  criterion?: { verification: 'unverified'; reason: string }
  /** Advance the actual declared checkout after START and return its observed Git identity. */
  advance(): { head: string; tree: string } | Promise<{ head: string; tree: string }>
}) {
  if (input.read.observation.status !== 'complete' || input.read.accepted.status !== 'accepted')
    throw new Error('Implementation world lacks complete accepted UW observation')
  const history = input.read.histories.find(
    (entry) =>
      entry.source.scope.repository === input.scope.repository && entry.source.scope.target === input.scope.target,
  )
  const native = input.read.graph.nodes.find(
    (node) => node.uw.repository === input.scope.repository && node.uw.target === input.scope.target,
  )
  if (!history || !native) throw new Error('Implementation world lacks its native UW or history')
  const loaded = await loadContracts()
  if ('missing' in loaded) throw new Error(`Missing engine ${loaded.missing}`)
  const opened = await startImplement(
    loaded,
    {
      issue: history,
      pullRequest: null,
      parents: [...input.parents],
      causal: {
        histories: input.read.observation.histories,
        catalogues: input.read.observation.catalogues,
        observation: input.read.observation,
      },
    },
    history,
    input.scope,
    { body: native.raw.body },
    input.git,
    input.gh,
    input.cwd,
    input.mandate,
    input.operations,
  )
  if (opened.kind !== 'action' || opened.node !== 'implement')
    throw new Error(`Implementation action refused: ${JSON.stringify(opened)}`)
  const criterion = input.read.accepted.value.snapshot.spec.criteria[0]
  if (!criterion) throw new Error('Implementation fixture requires a criterion')
  const { head, tree } = await input.advance()
  const commitSHAs = await observedImplementationCommits(input.git, input.cwd, input.startHead, head, tree)
  const target = criterionTargetSchema.parse({
    format: 'omp-build-finding-target/1',
    kind: 'criterion',
    spec: input.read.accepted.value.ref,
    id: criterion.id,
  })
  const toolCallId = 'native-fixture-test'
  const declarationClaim: Json =
    input.criterion === undefined
      ? {
          target,
          verification: 'evidence',
          evidence: [
            {
              id: 'native-fixture-criterion',
              target,
              method: 'test',
              scenario: criterion.statement,
              before: null,
              after: {
                toolCallId,
                versionClaim: {
                  code: { repository: input.scope.repository, commit: head },
                  reason: 'Observed at test execution',
                  references: [],
                },
              },
            },
          ],
        }
      : { target, verification: 'unverified', reason: input.criterion.reason }
  const claim = {
    outcome: 'implemented' as const,
    commitSHAs,
    commands: [{ toolCallId, command: input.command, exitCode: 0 }],
    criteria: [declarationClaim],
    reason: 'Implementation and captured test completed',
  }
  const result = await captureNativeTask({
    batch: opened.followUp,
    cwd: input.cwd,
    childId: `native-${input.scope.target}`,
    command: input.command,
    toolCallId,
    output: input.output,
    claim,
    expectedRuns: 1,
    git: { repository: input.scope.repository, commit: head, tree },
  })
  const published = await publishFeatureNativeResult({
    cwd: input.cwd,
    start: opened.start,
    startHead: input.startHead,
    result,
    gh: input.gh,
    git: input.git,
  })
  if (!published.published)
    await refuseImplementationPublication(input.operations, input.scope, opened.followUp.operationId, published)
  const readPublishedImplementation = async () => {
    const after = await input.operations.readUw(input.scope)
    const updated = after.histories.find(
      (entry) =>
        entry.source.scope.repository === input.scope.repository && entry.source.scope.target === input.scope.target,
    )
    if (!updated) throw new Error('Producer readback lacks its UW history')
    const receipt = recordsOf(updated).find(
      (record) =>
        record.kind === 'action-receipt' &&
        record.payload.action === 'implement' &&
        record.payload.phase === 'result' &&
        record.payload.actionId === opened.followUp.operationId,
    )
    if (
      receipt?.kind !== 'action-receipt' ||
      receipt.payload.action !== 'implement' ||
      receipt.payload.phase !== 'result' ||
      receipt.payload.admission?.admitted !== true ||
      receipt.payload.structured?.outcome !== 'implemented'
    )
      throw new Error('Producer did not publish an admitted implementation receipt')
    const declaration = receipt.payload.structured.criteria.find((item) => item.target.id === criterion.id)
    if (input.criterion === undefined) {
      if (
        declaration?.verification !== 'evidence' ||
        !declaration.evidence.some(
          (item) => item.method === 'test' && 'run' in item.after && item.after.run.toolCallId === toolCallId,
        )
      )
        throw new Error('Producer did not retain captured criterion evidence')
    } else if (declaration?.verification !== 'unverified' || declaration.reason !== input.criterion.reason) {
      throw new Error('Producer did not retain the unverified criterion declaration')
    }
    return { after, updated, receipt, declaration }
  }
  const { after, updated, receipt, declaration } = await readPublishedImplementation()
  return { opened, result, receipt, declaration, read: after, history: updated }
}
