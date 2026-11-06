import { execFileSync } from 'node:child_process'
import { rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { criterionIdSchema } from '../engine/uw-spec-schema.ts'
import { acceptedConstraints, proposedConstraints } from '../engine/workflow-constraint-compatibility.ts'
import type { SpecAssessment } from '../engine/workflow-output-schema.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import { continueFeature } from '../roxabi/workflow.ts'
import { captureNativePlanBatch } from './native-plan-capture.ts'
import type { withUnplannedInheritedWorld } from './native-unplanned-inherited-world.ts'

type ScenarioWorld = Parameters<Parameters<typeof withUnplannedInheritedWorld>[1]>[0]

/** Update the live child proposal, then actually assess and confirm its parent's new commitment. */
export async function confirmNewParentEngagement(
  input: ScenarioWorld & {
    commit: string
    tree: string
    statement: string
  },
) {
  const { world, scenario } = input
  const old = scenario.leafMandate.payload.ownSpec.snapshot.spec
  const content = canonicalSpec({
    ...old,
    criteria: old.criteria.map((item) => ({ ...item, statement: input.statement })),
  })
  if (!content.ok) throw new Error('Changed native child specification is invalid')
  const body = renderIssueSpecBody(content.value, { complexity: 1 })
  const editedAt = '2026-10-29T12:00:00Z'
  world.observeGraph({
    ...scenario.graph,
    nodes: scenario.graph.nodes.map((node) =>
      node.uw.target === scenario.leaf.target
        ? { ...node, raw: rawSource(node.uw.target, body, editedAt), updatedAt: editedAt, labels: ['size:F-lite'] }
        : node,
    ),
  })
  execFileSync('git', ['-C', world.cwd, 'checkout', '--quiet', '--detach', input.commit])
  world.checkout({
    branch: null,
    head: input.commit,
    base: 'main',
    baseTip: input.commit,
    remoteTip: input.commit,
  })
  const request = {
    cwd: world.cwd,
    reference: '203',
    control: 'continue' as const,
    principal: false,
    git: world.git,
    gh: world.gh,
    uw: world.operations,
  }
  const pending = await continueFeature(request)
  if (pending.kind !== 'blocked' || !pending.coverageRequest)
    throw new Error(`Expected actual parent coverage request: ${JSON.stringify(pending)}`)
  const coverage = {
    parent: pending.coverageRequest.parent,
    assignments: pending.coverageRequest.criteria.map((criterion) => ({
      criterion: criterionIdSchema.parse(criterion.id),
      children: [scenario.leaf] as [typeof scenario.leaf],
    })),
  }
  const started = await continueFeature({
    ...request,
    parentCoverage: coverage,
    parentCoverageBasis: pending.coverageRequest,
  })
  if (started.kind !== 'action' || started.node !== 'assess-spec')
    throw new Error(`Parent assessment did not start: ${JSON.stringify(started)}`)
  const task = started.followUp.tasks.tasks[0]
  const operands = task?.action.inputs.manifest.operands
  if (!task || operands?.action !== 'assess-spec' || operands.origin.kind !== 'native-current')
    throw new Error('Parent assessment lacks actual sealed native operands')
  const inputs = task.action.inputs
  const manifest = inputs.manifest
  const replay = await world.operations.replayActionInputs({
    reviewed: inputs,
    request: {
      actionId: task.action.snapshot.actionId,
      purpose: manifest.purpose,
      subject: manifest.subject,
      code: manifest.code,
      stageSources: inputs.stageSources,
      expandedContext: manifest.expandedContext,
      operands,
    },
  })
  if (!replay.ok) throw new Error(`Pending parent assessment cannot replay: ${JSON.stringify(replay)}`)
  const exact = operands.exactInputs
  if (exact.attachedChildren.length || exact.attachedWayfinders.length)
    throw new Error('Unexpected attached child in parent assessment')
  const acceptedChildConstraints = () =>
    exact.accepted.children.flatMap((child) => {
      const source = exact.childOwnSources.find(
        (entry) => entry.uw.repository === child.scope.repository && entry.uw.target === child.scope.target,
      )
      if (!source?.own || source.own.version !== child.specVersion)
        throw new Error('Parent accepted child source is unavailable')
      return acceptedConstraints(source.own, child.snapshot.spec, true)
    })
  const proposedChildConstraints = () =>
    exact.proposed.children.flatMap((child) => {
      if ('kind' in child) throw new Error('Unexpected newly created child')
      const prior = exact.accepted.children.find(
        (entry) => entry.scope.repository === child.scope.repository && entry.scope.target === child.scope.target,
      )
      if (
        !prior ||
        prior.specVersion !== child.specVersion ||
        prior.tier !== child.tier ||
        canonicalValueDigest(prior.snapshot.spec) !== canonicalValueDigest(child.snapshot.spec)
      )
        return proposedConstraints(child.scope, child.snapshot.spec)
      return []
    })
  const collectConstraints = () => {
    const constraints = [
      ...acceptedConstraints(exact.accepted.ref, exact.accepted.snapshot.spec, true),
      ...proposedConstraints(exact.accepted.ref.uw, exact.proposed.snapshot.spec),
    ]
    for (const ref of exact.accepted.inheritedOwnSpecRefs) {
      if (canonicalValueDigest(ref) !== canonicalValueDigest(scenario.middleMandate.payload.inheritedOwnSpecRefs[0]))
        throw new Error('Unexpected inherited assessment authority')
      constraints.push(...acceptedConstraints(ref, scenario.rootMandate.payload.ownSpec.snapshot.spec, false))
    }
    constraints.push(...acceptedChildConstraints())
    constraints.push(...proposedChildConstraints())
    return [...new Map(constraints.map((constraint) => [canonicalValueDigest(constraint), constraint])).values()]
  }
  const unique = collectConstraints()
  const first = unique[0]
  if (!first) throw new Error('Parent assessment has no constraints')
  const judgment: SpecAssessment = {
    classification: 'material',
    compatibility: {
      state: 'consistent',
      examined: [first, ...unique.slice(1)],
      references: [],
      reason: 'The observed parent and child constraints are compatible.',
    },
  }
  const captured = await captureNativePlanBatch({
    batch: started.followUp,
    cwd: world.cwd,
    git: { repository: scenario.middle.repository, commit: input.commit, tree: input.tree },
    claims: [{ task: task.name, childId: 'parent-engagement-assessment', value: judgment }],
  })
  const published = await publishFeatureNativeResult({
    cwd: world.cwd,
    start: started.start,
    result: captured,
    gh: world.gh,
    git: world.git,
  })
  if (!published.published) throw new Error(`Parent assessment publication refused: ${JSON.stringify(published)}`)
  const accepted = await world.operations.acceptMaterial(scenario.middle)
  if (accepted.status !== 'accepted')
    throw new Error(`Parent commitment confirmation refused: ${JSON.stringify(accepted)}`)
  execFileSync('git', ['-C', world.cwd, 'checkout', '--quiet', '-B', 'feature/202-leaf', input.commit])
  world.checkout({
    branch: 'feature/202-leaf',
    head: input.commit,
    base: 'main',
    baseTip: input.commit,
    remoteTip: input.commit,
  })
  return { body, content: content.value, assessment: started, published, accepted: accepted.value }
}
