import type { IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { GitHubOptions } from '../dist/contracts.js'
import { canonicalValueDigest, readWorkflowBinding } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { closeWriteFailure, readCloseProof } from './uw-close-linked.ts'
import type { UwOperationResult, UwOperations, UwReadPort } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { diagnostic } from './uw-installed-reports.ts'

type CloseLinkedRequest = Parameters<UwOperations['closeLinked']>[0]
type ClosePorts = { reader: UwReadPort; writer: IssueWriter; github: GitHubOptions }

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function closeRequestMatchesScope(request: CloseLinkedRequest): boolean {
  return (
    sameScope(request.uw, request.completion.uw) &&
    sameScope(request.mandate.scope, request.uw) &&
    request.pullRequest.repository === request.uw.repository
  )
}

async function checkCloseBinding(
  request: CloseLinkedRequest,
  github: GitHubOptions,
): Promise<UwGraphObservation | null> {
  const bound = await readWorkflowBinding(request.pullRequest, github)
  if (!bound.ok || bound.value.binding.kind !== 'workflow-binding') return null
  const bindingRecord = bound.value.binding
  const binding = bindingRecord.payload
  const matches =
    sameScope(bound.value.history.source.scope, request.uw) &&
    sameScope(binding.mandate.scope, request.mandate.scope) &&
    request.completion.sources.some(
      (ref) =>
        ref.kind === 'workflow-binding' &&
        sameScope(ref.scope, request.pullRequest) &&
        ref.recordId === bindingRecord.recordId,
    ) &&
    binding.mandate.recordId === request.mandate.recordId &&
    binding.mandate.kind === request.mandate.kind &&
    bound.value.observed.head === request.completion.code.head
  return matches ? bound.value.uwGraph : null
}

function sameCloseGraph(proof: UwGraphObservation, fresh: UwGraphObservation): boolean {
  if (proof.status !== 'complete' || fresh.status !== 'complete' || !sameScope(proof.root, fresh.root)) return false
  const observed = new Map(proof.nodes.map((node) => [`${node.uw.repository}\0${node.uw.target}`, node]))
  return (
    fresh.nodes.length > 0 &&
    fresh.nodes.every((node) => {
      const previous = observed.get(`${node.uw.repository}\0${node.uw.target}`)
      return previous !== undefined && canonicalValueDigest(previous) === canonicalValueDigest(node)
    })
  )
}

async function confirmCloseReadback(
  request: CloseLinkedRequest,
  reader: UwReadPort,
  github: GitHubOptions,
): Promise<UwOperationResult> {
  try {
    const after = await reader.readUw(request.uw)
    const final = after.completion.completions.get(`${request.uw.repository}\0${request.uw.target}`)
    const native = rootObservation(request.uw, after).nativeState
    if (
      after.observation.status !== 'complete' ||
      native.state !== 'CLOSED' ||
      native.stateReason !== 'COMPLETED' ||
      final?.state !== 'complete' ||
      canonicalValueDigest(final) !== canonicalValueDigest(request.completion) ||
      !(await checkCloseBinding(request, github))
    )
      return {
        status: 'partial',
        uw: request.uw,
        diagnostics: [
          diagnostic(
            request.uw,
            'close-linked-readback-mismatch',
            'Close effect was written but fresh proof or binding changed',
          ),
        ],
      }
    return { status: 'written', value: after }
  } catch (error) {
    return {
      status: 'partial',
      uw: request.uw,
      diagnostics: [diagnostic(request.uw, 'close-linked-readback-failed', String(error))],
    }
  }
}

async function closeLinked(
  request: CloseLinkedRequest,
  { reader, writer, github }: ClosePorts,
): Promise<UwOperationResult> {
  const refused = (code: string, message: string) => ({
    status: 'refused' as const,
    diagnostics: [diagnostic(request.uw, code, message)],
  })
  if (!closeRequestMatchesScope(request) || !(await checkCloseBinding(request, github)))
    return refused(
      'close-linked-binding-changed',
      'The canonical landing binding no longer identifies this UW and reviewed head',
    )
  const proof = await readCloseProof(request, reader)
  if (!proof.ok) return proof.result
  const before = proof.read
  const expected = rootObservation(request.uw, before)
  if (expected.nativeState.state === 'CLOSED' && expected.nativeState.stateReason === 'COMPLETED')
    return { status: 'written', value: before }
  if (expected.nativeState.state !== 'OPEN')
    return refused('close-linked-state-invalid', 'The bound UW is not open or already completed')
  const finalGraph = await checkCloseBinding(request, github)
  if (finalGraph === null)
    return refused('close-linked-binding-changed', 'The canonical binding changed before the close effect')
  if (!sameCloseGraph(before.observation.graph, finalGraph))
    return refused('close-linked-completion-changed', 'The native graph changed after the common completion proof')
  const written = await writer.setNativeState(expected.issue, { state: 'CLOSED', stateReason: 'COMPLETED' }, expected)
  if (written.status !== 'written') return closeWriteFailure(request.uw, written)
  return confirmCloseReadback(request, reader, github)
}

export function createLinkedClosure(ports: ClosePorts): UwOperations['closeLinked'] {
  return (request) => closeLinked(request, ports)
}
