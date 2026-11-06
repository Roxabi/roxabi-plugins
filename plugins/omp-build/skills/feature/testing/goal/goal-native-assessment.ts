import { acceptedMetadataOwner } from '../../../../engine/accepted-metadata-owner.ts'
import { canonicalValueDigest } from '../../../../engine/action-input.ts'
import type { Scope } from '../../../../engine/record-values.ts'
import { criterionIdSchema } from '../../../../engine/uw-spec-schema.ts'
import { recordsOf } from '../../../../engine/workflow-control.ts'
import { publishFeatureNativeResult } from '../../../../roxabi/feature-result.ts'
import { sourceRef } from '../../../../roxabi/uw-action-observe.ts'
import type { UwOperations } from '../../../../roxabi/uw-contract.ts'
import { continueFeature } from '../../../../roxabi/workflow.ts'
import { encodeCriterionRecords } from '../../../../testing/criterion-approval.ts'
import { criterionDispositionRecords } from '../../../../testing/criterion-dispositions.ts'
import { criterionEpicReviewGraph } from '../../../../testing/criterion-range-approval.ts'
import { captureNativeTask } from '../../../../testing/native-action-capture.ts'
import type { DeclaredCheckout } from '../../../../testing/native-implementation-world.ts'
import { produceParentIntegration } from '../../../../testing/parent-integration-producer.ts'
import { goalAssessmentJudgment } from './goal-assessment-judgment.ts'
import { assessmentPorts } from './goal-assessment-ports.ts'
import { verifyGoalCheckout } from './goal-integration-checkout.ts'
import { git } from './goal-scenario-sandbox.ts'

/** Assess the actual post-abandonment native cut and confirm the resulting material transition. */
export async function acceptGoalCoverage(
  cwd: string,
  operations: UwOperations,
  parent: Scope,
  children: readonly [Scope, Scope],
) {
  const before = await operations.readUw(parent)
  if (before.observation.status !== 'complete' || before.accepted.status !== 'accepted')
    throw new Error('Goal parent observation is not complete and accepted')
  const own = before.accepted.value.ref
  const rootHistory = before.histories.find(
    (history) => history.source.scope.repository === parent.repository && history.source.scope.target === parent.target,
  )
  const mandate = rootHistory?.operations.find(
    (operation) => operation.record?.kind === 'mandate' && operation.record.recordId === own.sourceAccepted.recordId,
  )?.record
  if (mandate?.kind !== 'mandate') throw new Error('Goal parent mandate is unavailable')
  const { installed, transport, gitPort } = assessmentPorts(cwd, operations, mandate)
  const request = {
    cwd,
    reference: parent.target.slice(parent.target.lastIndexOf('#') + 1),
    control: 'continue' as const,
    principal: false,
    git: gitPort,
    gh: transport,
    uw: installed,
  }
  const pending = await continueFeature(request)
  if (pending.kind !== 'blocked' || !pending.coverageRequest)
    throw new Error(`Expected explicit parent coverage request: ${JSON.stringify(pending)}`)
  const coverage = {
    parent: pending.coverageRequest.parent,
    assignments: pending.coverageRequest.criteria.map((criterion) => ({
      criterion: criterionIdSchema.parse(criterion.id),
      children: [...children] as [Scope, Scope],
    })),
  }
  const started = await continueFeature({
    ...request,
    parentCoverage: coverage,
    parentCoverageBasis: pending.coverageRequest,
  })
  if (started.kind !== 'action' || started.node !== 'assess-spec')
    throw new Error(`Goal assessment did not start: ${JSON.stringify(started)}`)
  const task = started.followUp.tasks.tasks[0]
  const operands = task?.action.inputs.manifest.operands
  if (operands?.action !== 'assess-spec' || operands.origin.kind !== 'native-current')
    throw new Error('Goal assessment operands unavailable')
  const judgment = goalAssessmentJudgment(operands.exactInputs)
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}'])
  const captured = await captureNativeTask({
    batch: started.followUp,
    cwd,
    childId: 'goal-assess-child',
    command: 'inspect goal assessment',
    toolCallId: 'goal-assess',
    output: 'Observed parent and child constraints',
    expectedRuns: 0,
    claim: JSON.parse(JSON.stringify(judgment)),
    git: { repository: parent.repository, commit: head, tree },
  })
  const result = await publishFeatureNativeResult({
    cwd,
    start: started.start,
    result: captured,
    gh: transport,
    git: gitPort,
  })
  if (!result.published) throw new Error(`Goal assessment publication failed: ${JSON.stringify(result)}`)
  const accepted = await installed.acceptMaterial(parent)
  if (accepted.status !== 'accepted') throw new Error(`Goal material acceptance failed: ${JSON.stringify(accepted)}`)
  if (
    canonicalValueDigest(accepted.value.accepted.status === 'accepted' ? accepted.value.accepted.value.ref : null) !==
    canonicalValueDigest(own)
  )
    throw new Error('Metadata-only coverage acceptance changed the parent own-Spec authority')
  return {
    before,
    request: pending.coverageRequest,
    coverage,
    started,
    result,
    accepted: accepted.value,
    operations: installed,
    gh: transport,
    git: gitPort,
  }
}

/** Produce the parent's own zero-evolution integration over the already merged real origin tip. */
export async function integrateGoalParent(
  cwd: string,
  parent: Scope,
  children: readonly Scope[],
  assessment: Awaited<ReturnType<typeof acceptGoalCoverage>>,
) {
  const read = await assessment.operations.readUw(parent)
  if (read.observation.status !== 'complete' || read.accepted.status !== 'accepted')
    throw new Error('Goal parent integration requires an accepted current observation')
  const accepted = read.accepted.value
  const mandate = read.histories
    .flatMap((history) => history.operations)
    .map((operation) => operation.record)
    .find((record) => record?.kind === 'mandate' && record.recordId === accepted.ref.sourceAccepted.recordId)
  if (mandate?.kind !== 'mandate' || mandate.payload.branch !== null)
    throw new Error('Goal parent integration mandate must be branchless')
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const baseTip = git(cwd, ['rev-parse', `refs/remotes/origin/${mandate.payload.base}`])
  const remoteTip = git(cwd, ['ls-remote', 'origin', `refs/heads/${mandate.payload.base}`]).split(/\s+/)[0]
  if (head !== baseTip || remoteTip !== head || git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'HEAD')
    throw new Error('Goal parent must be detached at the actual published integrated base')
  const current: DeclaredCheckout = { branch: null, head, base: mandate.payload.base, baseTip, remoteTip }
  const verify = (facts: DeclaredCheckout) => verifyGoalCheckout(cwd, current, facts)
  return produceParentIntegration(
    {
      parentScope: parent,
      parent: mandate,
      reviews: children.map((uw) => ({ uw })),
      operations: assessment.operations,
      gh: assessment.gh,
      git: assessment.git,
      checkout: verify,
    },
    {
      cwd,
      checkout(commit) {
        if (git(cwd, ['rev-parse', 'HEAD']) !== commit) throw new Error('Goal integration checkout moved')
      },
      tree(commit) {
        return git(cwd, ['rev-parse', `${commit}^{tree}`])
      },
    },
    {
      initial: current,
      candidate: current,
      command: 'bun test goal-parent.test.ts',
      output: 'PASS goal parent integration',
    },
  )
}

/** Publish a canonical independent review pinned to the actual admitted parent result and current coverage. */
export async function publishGoalParentReview(
  parent: Scope,
  produced: Awaited<ReturnType<typeof integrateGoalParent>>,
  assessment: Awaited<ReturnType<typeof acceptGoalCoverage>>,
) {
  const read = produced.beforeReview
  if (
    read.observation.status !== 'complete' ||
    read.accepted.status !== 'accepted' ||
    read.accepted.value.coverage === null
  )
    throw new Error('Goal review requires current accepted coverage')
  const accepted = read.accepted.value
  const coverage = accepted.coverage
  if (coverage === null) throw new Error('Goal accepted coverage is absent')
  const observation = read.observation
  const history = read.histories.find(
    (item) => item.source.scope.repository === parent.repository && item.source.scope.target === parent.target,
  )
  const mandate =
    history &&
    recordsOf(history).find(
      (record) => record.kind === 'mandate' && record.recordId === accepted.ref.sourceAccepted.recordId,
    )
  if (!history || !mandate || mandate.kind !== 'mandate') throw new Error('Goal review mandate history is missing')
  const metadataStep = accepted.chain.at(-1)
  if (!metadataStep) throw new Error('Goal review has no accepted metadata head')
  const owner = acceptedMetadataOwner(metadataStep, observation.histories)
  if (!owner.ok) throw new Error(`Goal coverage source is unavailable: ${JSON.stringify(owner.diagnostics)}`)
  const metadata = coverage.assignments.map((assignment, index) => ({
    source: 'record' as const,
    record: owner.value.record,
    selector: `${owner.value.selector}/coverage/assignments/${index}`,
    digest: canonicalValueDigest(assignment),
  }))
  const childRefs = produced.completions.map((completion) => {
    const ref = completion.sources[0]
    if (!ref) throw new Error('Goal child has no proof source')
    const pinned = sourceRef(observation.histories, ref)
    if (!pinned.ok) throw new Error(`Goal child proof is not authenticated: ${JSON.stringify(pinned.diagnostics)}`)
    return pinned.value
  })
  const prepared = await assessment.operations.prepareAction({
    actionId: 'goal-parent-integration-review',
    purpose: 'review',
    subject: produced.receipt.payload.inputs.manifest.subject,
    code: { ...produced.output.code, referenceCommit: produced.output.code.head },
    stageSources: [],
    expandedContext: [],
  })
  if (!prepared.ok) throw new Error(`Goal review preparation failed: ${JSON.stringify(prepared.diagnostics)}`)
  const inputs = prepared.value.inputs
  const pin = inputs.manifest.deliveryData.filter((item) => item.role === 'integration')
  if (
    pin.length !== 1 ||
    !pin[0] ||
    canonicalValueDigest({
      source: pin[0].source,
      record: pin[0].record,
      selector: pin[0].selector,
      digest: pin[0].digest,
    }) !== canonicalValueDigest(produced.integrationPin)
  )
    throw new Error('Goal review did not capture the actual integration pin')
  const code = produced.output.code
  const range = `${code.base}..${code.head}`
  const review = criterionEpicReviewGraph({
    mandate,
    inputs,
    head: code.head,
    range,
    issueRecords: recordsOf(history),
    prefix: 'goal-parent-integration',
    coverageReferences: [...metadata, ...childRefs],
  })
  const external = observation.histories.filter(
    (item) => item.source.scope.repository !== parent.repository || item.source.scope.target !== parent.target,
  )
  const projection = { catalogues: read.catalogues, acceptedPolicy: null }
  const prefix = encodeCriterionRecords(
    [review.root, review.spec, review.panel, review.synthesis, review.synthesisContribution, review.decision],
    parent,
    projection,
    'operator',
    external,
    history,
  )
  const decision = recordsOf(prefix.history).find((record) => record.recordId === review.decision.recordId)
  if (decision?.kind !== 'decision') throw new Error('Goal review decision is not authenticated')
  const assessed = criterionDispositionRecords(
    inputs,
    decision,
    [prefix.history, ...external],
    read.catalogues,
    observation.graph,
  )
  const dispositions = encodeCriterionRecords(
    assessed.dispositions,
    parent,
    projection,
    'operator',
    external,
    prefix.history,
  )
  const final = {
    ...review.review,
    payload: {
      ...review.review.payload,
      causeDispositionRefs: assessed.dispositions.map((item) => ({
        scope: parent,
        kind: 'cause-disposition' as const,
        recordId: item.recordId,
      })),
    },
  }
  const sealed = encodeCriterionRecords([final], parent, projection, 'operator', external, dispositions.history)
  const number = parent.target.slice(parent.target.lastIndexOf('#') + 1)
  for (const comment of [...prefix.comments, ...dispositions.comments, ...sealed.comments])
    await assessment.gh(produced.cwd, [
      'api',
      '--method',
      'POST',
      `repos/${parent.repository}/issues/${number}/comments`,
      '-f',
      `body=${comment.body}`,
    ])
  return { range, inputs, decisionId: decision.recordId }
}
