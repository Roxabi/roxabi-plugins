import { operatorConfirmationEvidenceSchema } from '../dist/contracts.js'
import { canonicalValueDigest } from '../engine/canonical-value.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { ContextSuccessionProposal } from '../engine/workflow-context-disposition-schema.ts'
import type { OperatorPort, UwOperations } from './uw-contract.ts'

/** Host-owned dependencies; none are supplied by command arguments or native results. */
type SuccessionPorts = {
  operator: OperatorPort
  validateBeforeMandate(proposal: ContextSuccessionProposal): Promise<boolean>
  validateBeforeSelection(proposal: ContextSuccessionProposal): Promise<boolean>
  publishMandate(proposal: ContextSuccessionProposal): Promise<boolean>
  publishSelection(proposal: ContextSuccessionProposal, evidence: OperatorConfirmationEvidence): Promise<boolean>
}

type Outcome = { status: 'published' | 'partial' | 'refused' | 'deferred' }
const operators = new WeakMap<UwOperations, OperatorPort>()

/** Installed composition associates the command's genuine operator capability with its UW service. */
export function bindContextSuccessionOperator(operations: UwOperations, operator: OperatorPort): void {
  operators.set(operations, operator)
}

/** Only host code can supply the observers and publishers; no command or native result provides them. */
export function executeHostContextSuccession(
  operations: UwOperations,
  proposal: ContextSuccessionProposal,
  ports: Omit<SuccessionPorts, 'operator'>,
): Promise<Outcome> {
  const operator = operators.get(operations)
  return operator === undefined
    ? Promise.resolve({ status: 'refused' })
    : executeContextSuccession(proposal, { ...ports, operator })
}

/** Confirm the exact proposal before either write; selection requires a second fresh observation. */
export async function executeContextSuccession(
  proposal: ContextSuccessionProposal,
  ports: SuccessionPorts,
): Promise<Outcome> {
  const pinned = structuredClone(proposal)
  const digest = canonicalValueDigest(pinned)
  const confirmed = await ports.operator.executeConfirmed({ proposal: pinned, digest }, (evidence) =>
    publishConfirmedSuccession(pinned, digest, ports, evidence),
  )
  return confirmed.status === 'confirmed' ? confirmed.value : { status: confirmed.status }
}

async function publishConfirmedSuccession(
  pinned: ContextSuccessionProposal,
  digest: string,
  ports: SuccessionPorts,
  evidence: OperatorConfirmationEvidence,
): Promise<Outcome> {
  if (
    !operatorConfirmationEvidenceSchema.safeParse(evidence).success ||
    evidence.operationId !== pinned.operationId ||
    evidence.proposalDigest !== digest ||
    canonicalValueDigest(pinned) !== digest
  )
    return { status: 'refused' }
  try {
    if (!(await ports.validateBeforeMandate(pinned)) || canonicalValueDigest(pinned) !== digest)
      return { status: 'refused' }
  } catch {
    return { status: 'refused' }
  }
  return publishSuccessionWrites(pinned, digest, ports, evidence)
}

async function publishSuccessionWrites(
  pinned: ContextSuccessionProposal,
  digest: string,
  ports: SuccessionPorts,
  evidence: OperatorConfirmationEvidence,
): Promise<Outcome> {
  try {
    if (!(await ports.publishMandate(pinned))) return { status: 'partial' }
    if (!(await ports.validateBeforeSelection(pinned)) || canonicalValueDigest(pinned) !== digest)
      return { status: 'partial' }
    if (!(await ports.publishSelection(pinned, evidence))) return { status: 'partial' }
    return { status: 'published' }
  } catch {
    return { status: 'partial' }
  }
}
