import type { IntegrationOutput } from '../engine/uw-integration-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { NonImplementPublication } from './feature-action-publication-context.ts'
import { bindClaimedCommands, conservedDeclarations } from './feature-implementation-admission.ts'
import { integrationAuthority } from './feature-integration-authority.ts'
import { integrationLineage } from './feature-integration-lineage.ts'
import { observeIntegration, refuse } from './feature-integration-observation.ts'
import type { IntegrationPublicationInput } from './feature-integration-result.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { proveAuthorizedPublishedBase } from './feature-publication.ts'
import { verifyParentCheckout } from './workflow-checkout.ts'

function integrationMandate(context: NonImplementPublication) {
  const mandateRef = context.opened.payload.mandate
  if (!('recordId' in mandateRef)) refuse('integration-mandate-unbound')
  const mandate = context.history.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'mandate' &&
      operation.record.recordId === mandateRef.recordId,
  )?.record
  if (mandate?.kind !== 'mandate' || mandate.payload.branch !== null) refuse('integration-parent-branch-bound')
  return { mandateRef, mandate }
}

function integrationCommands(structured: IntegrationOutput, child: NativeBatchResult['children'][number], cwd: string) {
  const commands = bindClaimedCommands(structured, child.bashCalls ?? [], cwd)
  if (!commands.ok || !conservedDeclarations(structured, child.commandRuns ?? []))
    refuse('integration-evidence-unconserved')
  return commands.commands
}

export type IntegrationAdmission = {
  admitted: boolean
  commits: string[]
  paths: string[]
  commands: { toolCallId: string; command: string; exitCode: number; cwd: string }[]
  remoteBranch: string | null
  remoteTip: string | null
  published: boolean
  reason: string
}

export async function admitIntegration(
  input: IntegrationPublicationInput,
  context: NonImplementPublication,
  child: NativeBatchResult['children'][number],
  structured: IntegrationOutput,
) {
  const { manifest, uw, read, accepted, childCommits } = await observeIntegration(input, context.opened, structured)
  const { mandateRef, mandate } = integrationMandate(context)
  const anchor = await resolveParentWorktreeAnchor({ subject: uw, read })
  if (!anchor.ok) refuse(anchor.reason)
  const checkout = await verifyParentCheckout({ git: input.git, cwd: input.cwd, uw: anchor.anchor })
  if (!checkout.ok) refuse(checkout.reason)
  const lineage = await integrationLineage({
    git: input.git,
    cwd: input.cwd,
    base: mandate.payload.base,
    expectedBase: structured.code.base,
    initialHead: manifest.code.head,
    head: structured.code.head,
    target: uw.target,
    childCommits,
  })
  if (!lineage.ok) refuse(lineage.reason)
  const commands = integrationCommands(structured, child, input.cwd)
  const authorized = integrationAuthority(input, context, mandateRef, uw, read, accepted)
  const publication = await proveAuthorizedPublishedBase(
    input.git,
    input.cwd,
    input.gh,
    uw.repository,
    mandate.payload.base,
    structured.code.head,
    authorized,
  )
  if (!publication.ok) {
    if (publication.reason === 'integration-start-resolved') refuse(publication.reason)
    return {
      admitted: false,
      commits: lineage.commits,
      paths: lineage.paths,
      commands,
      remoteBranch: null,
      remoteTip: null,
      published: false,
      reason: publication.reason,
    }
  }
  const finalAuthority = await authorized()
  if (!finalAuthority.ok) {
    if (finalAuthority.reason === 'integration-start-resolved') refuse(finalAuthority.reason)
    return {
      admitted: false,
      commits: lineage.commits,
      paths: lineage.paths,
      commands,
      remoteBranch: null,
      remoteTip: publication.remoteTip,
      published: false,
      reason: finalAuthority.reason,
    }
  }
  return {
    admitted: true,
    commits: lineage.commits,
    paths: lineage.paths,
    commands,
    remoteBranch: null,
    remoteTip: publication.remoteTip,
    published: true,
    reason: structured.reason,
  }
}
