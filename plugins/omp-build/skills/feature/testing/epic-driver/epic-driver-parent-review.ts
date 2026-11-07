import type { Gh } from '../../../../adapters/github/types.ts'
import { acceptedMetadataOwner } from '../../../../engine/accepted-metadata-owner.ts'
import { canonicalValueDigest } from '../../../../engine/action-input.ts'
import type { MandateRecord } from '../../../../engine/workflow-control.ts'
import { recordsOf } from '../../../../engine/workflow-control.ts'
import { sourceRef } from '../../../../roxabi/uw-action-observe.ts'
import type { UwOperations } from '../../../../roxabi/uw-contract.ts'
import type { GitRunner } from '../../../../roxabi/workflow-checkout.ts'
import type { DeclaredCheckout } from '../../../../testing/native-implementation-world.ts'
import { produceParentIntegration } from '../../../../testing/parent-integration-producer.ts'
import { git } from './epic-driver-sandbox.ts'

export type EpicParentWorld = {
  epic: string
  parent: MandateRecord
  native: { gh: Gh; git: GitRunner; operations: UwOperations }
}

/** Integrate the actual completed child, then independently capture current review inputs. */
export async function prepareEpicParentReview(world: EpicParentWorld) {
  const scope = { repository: 'o/r', target: 'o/r#1' }
  const child = { repository: 'o/r', target: 'o/r#2' }
  const cwd = world.epic
  const initial = observeParentCheckout(cwd)
  const head = initial.head
  const produced = await produceParentIntegration(
    {
      ...world.native,
      parentScope: scope,
      parent: world.parent,
      reviews: [{ uw: child }],
      checkout: (declared) => assertParentCheckout(cwd, declared),
    },
    {
      cwd,
      checkout(commit) {
        if (git(cwd, 'rev-parse', 'HEAD') !== commit) throw new Error('Unexpected parent checkout')
      },
      tree(commit) {
        return git(cwd, 'rev-parse', `${commit}^{tree}`)
      },
    },
    { initial, candidate: initial, command: 'bun test parent.test.ts', output: 'PASS parent integration' },
  )
  const { beforeReview, completions, integrationRecordId, integrationPin, output, installed } = produced
  if (beforeReview.observation.status !== 'complete') throw new Error('Parent observation is incomplete')
  const observation = beforeReview.observation
  const history = beforeReview.histories.find(
    (item) => item.source.scope.repository === scope.repository && item.source.scope.target === scope.target,
  )
  const records = history && recordsOf(history)
  const integration = records?.find((record) => record.recordId === integrationRecordId)
  if (
    !history ||
    !records ||
    integration?.kind !== 'action-receipt' ||
    integration.payload.action !== 'integrate' ||
    integration.payload.phase !== 'result' ||
    integration.payload.structured?.outcome !== 'integrated'
  )
    throw new Error('Actual parent integration result unavailable')
  if (beforeReview.accepted.status !== 'accepted' || beforeReview.accepted.value.coverage === null)
    throw new Error('Actual parent coverage unavailable')
  const accepted = beforeReview.accepted.value
  const ownerStep = accepted.chain.at(-1)
  if (!ownerStep) throw new Error('Accepted metadata chain is empty')
  const owner = acceptedMetadataOwner(ownerStep, observation.histories)
  if (!owner.ok) throw new Error(`Accepted metadata owner unavailable: ${JSON.stringify(owner.diagnostics)}`)
  const coverage = accepted.coverage
  if (coverage === null) throw new Error('Actual parent coverage unavailable')
  const assignments = coverage.assignments
  const metadata = assignments.map((assignment, index) => ({
    source: 'record' as const,
    record: owner.value.record,
    selector: `${owner.value.selector}/coverage/assignments/${index}`,
    digest: canonicalValueDigest(assignment),
  }))
  const childRefs = completions.flatMap((completion) =>
    completion.sources.map((source) => {
      const pin = sourceRef(observation.histories, source)
      if (!pin.ok) throw new Error(`Child completion source unavailable: ${JSON.stringify(pin.diagnostics)}`)
      return pin.value
    }),
  )
  const range = `${output.code.base}..${output.code.head}`
  const prefix = `epic-${head.slice(0, 8)}`
  const reviewHead = git(cwd, 'rev-parse', 'HEAD')
  if (reviewHead !== head) throw new Error('Parent review HEAD changed after integration')
  const prepared = await installed.prepareAction({
    actionId: `${prefix}-root`,
    purpose: 'review',
    subject: { kind: 'uw', uw: scope, pullRequest: null, binding: null },
    code: { ...output.code, referenceCommit: reviewHead },
    stageSources: [],
    expandedContext: [],
  })
  if (!prepared.ok) throw new Error(`Fresh parent review refused: ${JSON.stringify(prepared.diagnostics)}`)
  const selected = prepared.value.inputs.manifest.deliveryData.filter((ref) => ref.role === 'integration')
  const selection = selected[0]
  if (selected.length !== 1 || selection === undefined)
    throw new Error('Fresh parent review lacks its unique integration pin')
  const { role: _role, ...selectedPin } = selection
  if (canonicalValueDigest(selectedPin) !== canonicalValueDigest(integrationPin))
    throw new Error('Parent review selected another integration')
  return {
    mandate: world.parent,
    inputs: prepared.value.inputs,
    issueRecords: records,
    integrationPin,
    coverageReferences: [...metadata, ...childRefs],
    head,
    range,
    prefix,
    history,
    observation,
  }
}

/** Observe the detached published base before opening integration. */
function observeParentCheckout(cwd: string): DeclaredCheckout {
  const head = git(cwd, 'rev-parse', 'HEAD')
  const baseTip = git(cwd, 'rev-parse', 'refs/remotes/origin/main')
  const remoteTip = git(cwd, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0]
  if (!remoteTip) throw new Error('Parent origin base is unavailable')
  if (git(cwd, 'branch', '--show-current') !== '' || head !== baseTip || head !== remoteTip)
    throw new Error('Parent checkout is not detached at the published base')
  return { branch: null, head, base: 'main', baseTip, remoteTip }
}

/** Recheck the declared checkout against Git at each producer transition. */
function assertParentCheckout(cwd: string, declared: DeclaredCheckout): void {
  const observedHead = git(cwd, 'rev-parse', 'HEAD')
  const observedBranch = git(cwd, 'branch', '--show-current') || null
  const observedBase = git(cwd, 'rev-parse', 'refs/remotes/origin/main')
  const remote = git(cwd, 'ls-remote', 'origin', `refs/heads/${declared.base}`).split(/\s+/)[0] || null
  if (
    observedHead !== declared.head ||
    observedBranch !== declared.branch ||
    observedBase !== declared.baseTip ||
    remote !== declared.remoteTip
  )
    throw new Error('Declared parent checkout does not match actual Git observations')
}
