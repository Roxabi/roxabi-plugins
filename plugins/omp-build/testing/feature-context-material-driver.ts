import { execFileSync } from 'node:child_process'
import type { Gh } from '../adapters/github/types.ts'
import { acceptedMetadataOwner } from '../engine/accepted-metadata-owner.ts'
import { canonicalValueDigest } from '../engine/canonical-value.ts'
import type { OwnSpecRef } from '../engine/uw-spec-schema.ts'
import type { SpecAssessment } from '../engine/workflow-output-schema.ts'
import type { ContinueFeatureResult } from '../roxabi/feature-contract.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import type { OperatorPort, UwOperations } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { continueFeature } from '../roxabi/workflow.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import { assessmentConstraints } from './feature-assessment-constraints.ts'
import { SCOPE } from './feature-recovery-fixture.ts'
import { captureNativePlanBatch } from './native-plan-capture.ts'

/** Settle an assessment through the production native capture and confirmed material operation. */
export async function acceptContextMaterial(
  cwd: string,
  operator: OperatorPort,
  options: {
    scope?: OwnSpecRef['uw']
    reference?: string
    uw?: UwOperations
    started?: ContinueFeatureResult
    gh?: Gh
    git?: GitRunner
  } = {},
) {
  const scope = options.scope ?? SCOPE
  const uw = options.uw ?? (await createInstalledUwOperations({ cwd, operator }))
  const started =
    options.started ??
    (await continueFeature({
      cwd,
      reference: options.reference ?? '#42',
      control: 'continue',
      principal: false,
      uw,
      ...(options.gh === undefined ? {} : { gh: options.gh }),
      ...(options.git === undefined ? {} : { git: options.git }),
    }))
  if (started.kind !== 'action' || started.node !== 'assess-spec')
    throw new Error(`Material assessment did not start: ${JSON.stringify(started)}`)
  const operands = started.followUp.tasks.tasks[0]?.action.inputs.manifest.operands
  if (operands?.action !== 'assess-spec' || operands.origin.kind !== 'native-current')
    throw new Error('Material assessment operands unavailable')
  const exact = operands.exactInputs
  const task = started.followUp.tasks.tasks[0]
  if (!task || started.followUp.tasks.tasks.length !== 1) throw new Error('Material assessment task unavailable')
  const assessmentStart = started.start
  async function materialJudgment(): Promise<SpecAssessment> {
    const read = await createInstalledUwReadPort({
      cwd,
      ...(options.gh === undefined ? {} : { gh: options.gh }),
      assessmentReplay: {
        uw: scope,
        actionId: task.action.snapshot.actionId,
        fingerprint: task.action.inputs.fingerprint,
        start: assessmentStart,
      },
    }).readUw(scope)
    if (
      read.accepted.status !== 'accepted' ||
      canonicalValueDigest(read.accepted.value.ref) !== canonicalValueDigest(exact.accepted.ref) ||
      canonicalValueDigest(read.accepted.value.children) !== canonicalValueDigest(exact.accepted.children)
    )
      throw new Error(`Assessment accepted metadata changed before judgment: ${JSON.stringify(read.accepted)}`)
    const step = read.accepted.value.chain.at(-1)
    if (step === undefined) throw new Error('Assessment accepted metadata step unavailable')
    const owner = acceptedMetadataOwner(step, read.histories)
    if (!owner.ok) throw new Error(`Assessment accepted metadata unavailable: ${JSON.stringify(owner)}`)
    const unique = assessmentConstraints(exact, owner.value)
    const first = unique[0]
    if (!first) throw new Error('Material assessment constraints unavailable')
    return {
      classification: 'material',
      compatibility: {
        state: 'consistent',
        examined: [first, ...unique.slice(1)],
        references: [],
        reason: 'The declared parent and child constraints remain compatible.',
      },
    }
  }
  const judgment = await materialJudgment()
  const git = (revision: string) => execFileSync('git', ['rev-parse', revision], { cwd, encoding: 'utf8' }).trim()
  const captured = await captureNativePlanBatch({
    batch: started.followUp,
    cwd,
    claims: [{ task: task.name, childId: 'context-material-child', value: judgment }],
    git: { repository: scope.repository, commit: git('HEAD'), tree: git('HEAD^{tree}') },
  })
  const published = await publishFeatureNativeResult({
    cwd,
    start: started.start,
    result: captured,
    ...(options.gh === undefined ? {} : { gh: options.gh }),
    ...(options.git === undefined ? {} : { git: options.git }),
  })
  if (!published.published) throw new Error(`Material assessment publication failed: ${JSON.stringify(published)}`)
  const accepted = await uw.acceptMaterial(scope)
  function acceptedAfter() {
    if (accepted.status !== 'accepted' || accepted.value.accepted.status !== 'accepted')
      throw new Error(`Material acceptance failed: ${JSON.stringify(accepted)}`)
    return accepted.value.accepted.value.ref
  }
  return { before: exact.accepted.ref, after: acceptedAfter(), published }
}
