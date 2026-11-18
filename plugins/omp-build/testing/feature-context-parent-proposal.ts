import { execFileSync } from 'node:child_process'
import { parseIssueSpecBody, rawSource } from '../adapters/github-native/uw-spec.ts'
import { historyFor, recordsOf } from '../engine/workflow-control.ts'
import { selectedMandate } from '../engine/workflow-mandate-admission.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { nativeFeatureSpec } from './feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { readSim, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const repository = 'acme/app'
const parentScope = { repository, target: `${repository}#200` }
const scopes = [201, 202, 203].map((number) => ({ repository, target: `${repository}#${number}` }))
const date = '2026-10-27T12:00:00Z'

/** Change only the native child proposal; accepting it remains an operator operation. */
export function proposeParentChildV2({ box }: { box: Box }) {
  const scope = scopes[0]
  const issue = readSim(box).issues['201']
  if (!scope || !issue) throw new Error('Child #201 is unavailable')
  const before = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, issue.body, issue.updatedAt ?? null) })
  if (before.status !== 'conformant') throw new Error('Original child specification is invalid')
  const proposed = nativeFeatureSpec(scope, 'preserves the region and its timezone')
  const afterVersion = proposed.ownSpec.version
  if (before.snapshot.spec.version === afterVersion) throw new Error('Child proposal is not a new version')
  writeSim(box, (state) => {
    const child = state.issues['201']
    if (!child || child.body !== issue.body) throw new Error('Child proposal changed concurrently')
    child.body = proposed.body
    child.updatedAt = date
  })
  return { scope, beforeVersion: before.snapshot.spec.version, afterVersion }
}

/** Publish only the first child mandate against the currently accepted parent revision. */
export async function publishFirstParentChild({
  box,
  checkout,
  env,
}: {
  box: Box
  checkout: string
  env: NodeJS.ProcessEnv
}) {
  const gh = async (cwd: string, args: string[]) =>
    execFileSync('gh', args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const operator = {
    async executeConfirmed(): Promise<never> {
      throw new Error('Child fixture does not confirm operator operations')
    },
  }
  const operations = await createInstalledUwOperations({ cwd: checkout, gh, operator, readAuthor: 'operator' })
  const read = await operations.readUw(parentScope)
  if (read.accepted.status !== 'accepted' || read.graph.status !== 'complete')
    throw new Error('Parent accepted material or graph unavailable')
  const acceptedParent = read.accepted.value
  if (acceptedParent.ref.sourceAccepted.kind === 'mandate') throw new Error('Expected a material parent acceptance')
  const history = historyFor(parentScope, read.histories)
  const scope = scopes[0]
  if (!history || !scope) throw new Error('Parent history or child scope unavailable')
  const parent = selectedMandate(history)
  if (!('kind' in parent) || parent.kind !== 'mandate') throw new Error('Parent mandate unavailable')
  const childHistory = historyFor(scope, read.histories)
  if (childHistory && recordsOf(childHistory).some((record) => record.kind === 'mandate'))
    throw new Error('Child already has a mandate')
  const node = read.graph.nodes.find(
    (item) => item.uw.repository === scope.repository && item.uw.target === scope.target,
  )
  const commitment = acceptedParent.children.find(
    (item) => item.scope.repository === scope.repository && item.scope.target === scope.target,
  )
  if (!node || !commitment) throw new Error('Accepted child commitment unavailable')
  const parsed = parseIssueSpecBody({ uw: scope, raw: node.raw })
  if (parsed.status !== 'conformant' || parsed.snapshot.spec.version !== commitment.specVersion)
    throw new Error('Current child specification differs from the accepted parent commitment')
  const workflow = roxabiWorkflowFixtures()
  const branch = branchFor({ number: 201, title: node.title, labels: [...node.labels] })
  const mandate = workflow.featureMandate(scope, {
    body: node.raw.body,
    ownSpec: workflow.ownSpecFromSnapshot(scope, parsed.snapshot),
    recordId: 'child-mandate-0',
    branch,
    parent: workflow.mandateRef(parent),
    inheritedOwnSpecRefs: [acceptedParent.ref],
  })
  async function publishAndReadBack(parentHistory: NonNullable<typeof history>) {
    const issue = readSim(box).issues['201']
    if (!issue) throw new Error('Child issue unavailable')
    const existing = new Set(issue.comments.map((comment) => comment.body))
    for (const body of workflow.framedBodies([mandate], 'operator', [parentHistory]))
      if (!existing.has(body))
        await gh(checkout, ['api', '--method', 'POST', `repos/${repository}/issues/201/comments`, '-f', `body=${body}`])
    const child = await operations.readUw(scope)
    if (child.accepted.status !== 'accepted' || child.accepted.value.ref.sourceAccepted.recordId !== mandate.recordId)
      throw new Error(`First child mandate was not accepted on readback: ${JSON.stringify(child.accepted)}`)
  }
  await publishAndReadBack(history)
  return { scope, operations, mandate, parent, acceptedParent }
}
