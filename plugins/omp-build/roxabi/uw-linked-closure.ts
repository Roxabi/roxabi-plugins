import type { IssueWritePorts, IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { LandingFactsRead, WorkflowBindingRead } from '../adapters/github-workflow/types.ts'
import type { GitHubOptions } from '../dist/contracts.js'
import { readWorkflowBinding } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import { closeWriteFailure, readCloseProof } from './uw-close-linked.ts'
import type { UwOperationResult, UwOperations, UwRead } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { diagnostic } from './uw-installed-reports.ts'
import { createInstalledObservedUwReadPort } from './uw-read-port.ts'

type CloseLinkedRequest = Parameters<UwOperations['closeLinked']>[0]
type ClosePorts = {
  github: GitHubOptions
  readLanding(pullRequest: Scope): Promise<LandingFactsRead>
  createWriter(read: IssueWritePorts['read']): Pick<IssueWriter, 'setNativeState'>
}
type Binding = Extract<WorkflowBindingRead, { ok: true }>['value'] | Extract<LandingFactsRead, { ok: true }>
type AuthorityRead =
  | { ok: true; read: UwRead }
  | { ok: false; kind: 'semantic' | 'unavailable'; result: UwOperationResult }

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function refused(request: CloseLinkedRequest, code: string, message: string): UwOperationResult {
  return { status: 'refused', diagnostics: [diagnostic(request.uw, code, message)] }
}

function bindingMatches(request: CloseLinkedRequest, bound: Binding): boolean {
  if (bound.binding.kind !== 'workflow-binding') return false
  const binding = bound.binding
  const linked = bound.native.linkedIssueScopes
  return (
    sameScope(request.uw, request.completion.uw) &&
    sameScope(request.mandate.scope, request.uw) &&
    request.pullRequest.repository === request.uw.repository &&
    sameScope(bound.native.pullRequest, request.pullRequest) &&
    linked.length === 1 &&
    linked[0] !== undefined &&
    sameScope(linked[0], request.uw) &&
    sameScope(binding.payload.mandate.scope, request.mandate.scope) &&
    binding.payload.mandate.recordId === request.mandate.recordId &&
    binding.payload.mandate.kind === request.mandate.kind &&
    request.completion.sources.some(
      (ref) =>
        ref.kind === 'workflow-binding' &&
        sameScope(ref.scope, request.pullRequest) &&
        ref.recordId === binding.recordId,
    ) &&
    bound.observed.head === request.completion.code.head
  )
}

function nativeDeliveryMatches(request: CloseLinkedRequest, landing: Extract<LandingFactsRead, { ok: true }>): boolean {
  if (landing.observation.status !== 'complete' || !sameScope(landing.observation.root, request.uw)) return false
  const dossiers = landing.observation.delivery.filter((item) => sameScope(item.uw, request.uw))
  if (dossiers.length !== 1 || !dossiers[0]) return false
  const pulls = dossiers[0].pullRequests.filter((item) => sameScope(item.pullRequest, request.pullRequest))
  const pull = pulls[0]
  return (
    pulls.length === 1 &&
    pull !== undefined &&
    pull.branch === landing.native.branch &&
    pull.base === landing.native.base &&
    pull.head === landing.observed.head &&
    pull.baseTip === landing.observed.baseTip
  )
}

async function readAuthority(request: CloseLinkedRequest, ports: ClosePorts): Promise<AuthorityRead> {
  let landing: LandingFactsRead
  try {
    landing = await ports.readLanding(request.pullRequest)
  } catch {
    return {
      ok: false,
      kind: 'unavailable',
      result: refused(request, 'close-linked-observation-unavailable', 'The common close observation is unavailable'),
    }
  }
  if (!landing.ok) {
    const unavailable = landing.reason === 'unreadable'
    return {
      ok: false,
      kind: unavailable ? 'unavailable' : 'semantic',
      result: refused(
        request,
        unavailable ? 'close-linked-observation-unavailable' : 'close-linked-binding-changed',
        'The current linked observation is unavailable or invalid',
      ),
    }
  }
  if (!bindingMatches(request, landing))
    return {
      ok: false,
      kind: 'semantic',
      result: refused(request, 'close-linked-binding-changed', 'The canonical binding changed before the close effect'),
    }
  if (landing.observation.status !== 'complete')
    return {
      ok: false,
      kind: 'unavailable',
      result: refused(request, 'close-linked-observation-unavailable', 'The common close observation is incomplete'),
    }
  if (!nativeDeliveryMatches(request, landing))
    return {
      ok: false,
      kind: 'semantic',
      result: refused(request, 'close-linked-completion-changed', 'The current native delivery facts are inconsistent'),
    }
  const proof = await readCloseProof(request, createInstalledObservedUwReadPort({ observation: landing.observation }))
  if (proof.ok) return proof
  const unavailable =
    proof.result.status === 'refused' &&
    proof.result.diagnostics.some((item) => item.code === 'close-linked-observation-unavailable')
  return { ...proof, kind: unavailable ? 'unavailable' : 'semantic' }
}

async function closeLinked(request: CloseLinkedRequest, ports: ClosePorts): Promise<UwOperationResult> {
  if (
    !sameScope(request.uw, request.completion.uw) ||
    !sameScope(request.mandate.scope, request.uw) ||
    request.pullRequest.repository !== request.uw.repository
  )
    return refused(
      request,
      'close-linked-binding-changed',
      'The canonical landing binding no longer identifies this UW and reviewed head',
    )
  const bound = await readWorkflowBinding(request.pullRequest, ports.github)
  if (!bound.ok || !bindingMatches(request, bound.value))
    return refused(
      request,
      'close-linked-binding-changed',
      'The canonical landing binding no longer identifies this UW and reviewed head',
    )
  if (bound.value.uwGraph.status !== 'complete')
    return refused(request, 'close-linked-observation-unavailable', 'The native graph is incomplete')
  let expected: ReturnType<typeof rootObservation>
  try {
    expected = rootObservation(request.uw, { graph: bound.value.uwGraph })
  } catch {
    return refused(request, 'close-linked-observation-unavailable', 'The bound UW is missing from the native graph')
  }
  if (expected.nativeState.state === 'CLOSED' && expected.nativeState.stateReason === 'COMPLETED')
    return confirmAlreadyClosed(request, ports)
  if (expected.nativeState.state !== 'OPEN')
    return refused(request, 'close-linked-state-invalid', 'The bound UW is not open or already completed')
  return writeClose(request, ports, expected)
}

async function confirmAlreadyClosed(request: CloseLinkedRequest, ports: ClosePorts): Promise<UwOperationResult> {
  const proof = await readAuthority(request, ports)
  if (!proof.ok) return proof.result
  const state = rootObservation(request.uw, proof.read).nativeState
  if (state.state !== 'CLOSED' || state.stateReason !== 'COMPLETED')
    return refused(request, 'close-linked-state-invalid', 'The bound UW is no longer completed')
  return { status: 'written', value: proof.read }
}

async function writeClose(
  request: CloseLinkedRequest,
  ports: ClosePorts,
  expected: ReturnType<typeof rootObservation>,
): Promise<UwOperationResult> {
  const last: { read: UwRead | null; failure: Extract<AuthorityRead, { ok: false }> | null } = {
    read: null,
    failure: null,
  }
  const writer = ports.createWriter(async (issue) => {
    last.read = null
    last.failure = null
    if (issue.repository !== expected.issue.repository || issue.number !== expected.issue.number) {
      last.failure = {
        ok: false,
        kind: 'semantic',
        result: refused(request, 'close-linked-binding-changed', 'The native issue differs from the linked UW'),
      }
      throw new Error('Linked issue differs')
    }
    const proof = await readAuthority(request, ports)
    if (!proof.ok) {
      last.failure = proof
      throw new Error('Linked close authority unavailable')
    }
    last.read = proof.read
    return rootObservation(request.uw, proof.read)
  })
  const written = await writer.setNativeState(expected.issue, { state: 'CLOSED', stateReason: 'COMPLETED' }, expected)
  if (written.status === 'written' && last.read !== null) return { status: 'written', value: last.read }
  if (written.status === 'written')
    return {
      status: 'partial',
      uw: request.uw,
      diagnostics: [diagnostic(request.uw, 'readback-unconfirmed', 'The full readback is unavailable')],
    }
  const failure = last.failure
  if (failure !== null && written.status === 'refused') return failure.result
  if (failure?.kind === 'semantic' && written.status === 'partial' && written.completed.includes('native-state'))
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
  return closeWriteFailure(request.uw, written)
}

export function createLinkedClosure(ports: ClosePorts): UwOperations['closeLinked'] {
  return (request) => closeLinked(request, ports)
}
