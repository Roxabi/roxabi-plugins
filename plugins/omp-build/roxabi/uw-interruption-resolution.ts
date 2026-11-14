import { createHash, randomUUID } from 'node:crypto'
import {
  admitInterruptionResolution,
  bindExternalRef,
  buildRecord,
  type GitHubOptions,
  INTERRUPTION_RESOLUTION_FORMAT,
  interruptionResolutionCandidate,
  interruptionResolutionDigest,
  interruptionResolutionRecordId,
  publishConfirmedWorkflowRecord,
  selectApplicableMandate,
  startResolution,
} from '../dist/contracts.js'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { ResolutionProposal, ResolutionRecord } from '../engine/workflow-interruption-proof.ts'
import { startDispatch } from './feature-start-executions.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import type {
  InterruptionResolutionResult,
  OperatorPort,
  PreparedInterruptionResolution,
  ResolveInterruptionRequest,
  UwReadPort,
} from './uw-contract.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sameScope = (a: Scope, b: Scope) => a.repository === b.repository && a.target === b.target
const ref = (record: CanonicalRecord) => ({
  scope: { repository: record.repository, target: record.target },
  recordId: record.recordId,
  kind: record.kind,
})
const problem = (uw: Scope, code: string, message: string): UwDiagnostic => ({
  code,
  message,
  location: { kind: 'native', uw, connection: 'state' },
  related: [],
})
const ownsConfirmedPause = (
  selection: ReturnType<typeof selectApplicableMandate>,
  mandate: ResolveInterruptionRequest['mandate'],
) =>
  selection.status === 'refused' &&
  selection.reason === 'paused' &&
  selection.pause.mandate.recordId === mandate.recordId &&
  sameScope(selection.pause.mandate.scope, mandate.scope)

async function observeAuthority(reader: UwReadPort, request: ResolveInterruptionRequest) {
  const uw = request.mandate.scope
  const read = await reader.readUw(uw)
  if (read.observation.status !== 'complete')
    return {
      ok: false as const,
      diagnostics: [problem(uw, 'interruption-authority-unavailable', 'Complete causal observation is required')],
    }
  const histories = read.observation.histories
  const home = histories.find((h) => sameScope(h.source.scope, uw))
  const startHome = histories.find((h) => sameScope(h.source.scope, request.start.scope))
  if (!home || !startHome || histories.some((h) => !h.source.complete))
    return {
      ok: false as const,
      diagnostics: [
        problem(uw, 'interruption-authority-unavailable', 'Complete mandate and START histories are required'),
      ],
    }
  const bound = bindExternalRef(request.mandate, home)
  if (!bound.ok || bound.value.kind !== 'mandate')
    return {
      ok: false as const,
      diagnostics: [problem(uw, 'interruption-authority-unavailable', 'Mandate cannot be authenticated')],
    }
  const selection = selectApplicableMandate(
    home,
    histories.filter((h) => h !== home),
    {
      histories,
      catalogues: read.observation.catalogues,
      observation: read.observation,
    },
  )
  if (!ownsConfirmedPause(selection, request.mandate))
    return {
      ok: false as const,
      diagnostics: [
        problem(uw, 'interruption-not-paused', 'The selected mandate does not own the current confirmed pause'),
      ],
    }
  const candidate = interruptionResolutionCandidate({ histories, mandate: bound.value, start: request.start })
  if (!candidate.ok)
    return { ok: false as const, diagnostics: candidate.diagnostics.map((d) => problem(uw, d.code, d.message)) }
  return { ok: true as const, histories, candidate: candidate.value }
}

async function observeInterruption(reader: UwReadPort, request: ResolveInterruptionRequest) {
  const uw = request.mandate.scope
  const authority = await observeAuthority(reader, request)
  if (!authority.ok) return authority
  const { histories, candidate } = authority
  const observed = await request.observe(candidate)
  if (!observed.ok) return observed
  const currentDispatch = startDispatch(request.start)
  if (currentDispatch?.kind !== 'not-activated' && currentDispatch?.kind !== 'closed-before-admission')
    return {
      ok: false as const,
      diagnostics: [problem(uw, 'interruption-dispatch-unproven', 'Native dispatch was not positively prevented')],
    }
  if (JSON.stringify(observed.value.runtime) !== JSON.stringify(candidate.runtime))
    return {
      ok: false as const,
      diagnostics: [problem(uw, 'config-drift', 'Runtime does not match the mandate configuration')],
    }
  return { ok: true as const, histories, candidate, observation: observed.value, dispatch: currentDispatch }
}

type SuccessfulObservation = Extract<Awaited<ReturnType<typeof observeInterruption>>, { ok: true }>

function buildAdmittedResolution(
  request: ResolveInterruptionRequest,
  proposal: ResolutionProposal,
  digest: string,
  operationId: string,
  confirmation: ResolutionRecord['payload']['confirmation'],
  histories: SuccessfulObservation['histories'],
) {
  const uw = request.mandate.scope
  const built = buildRecord({
    ...request.start.scope,
    version: 1,
    recordId: interruptionResolutionRecordId(request.start.recordId),
    runId: operationId,
    operationId,
    kind: 'operator-control',
    payload: { ...proposal, proposalDigest: digest, confirmation },
  })
  if (!built.ok)
    return { ok: false as const, diagnostics: built.diagnostics.map((d) => problem(uw, d.code, d.message)) }
  const record = built.value as ResolutionRecord
  const admitted = admitInterruptionResolution(record, histories)
  if (!admitted.ok)
    return { ok: false as const, diagnostics: admitted.diagnostics.map((d) => problem(uw, d.code, d.message)) }
  return { ok: true as const, record }
}

async function publishAndReadback(
  record: ResolutionRecord,
  histories: SuccessfulObservation['histories'],
  request: ResolveInterruptionRequest,
  input: { reader: UwReadPort; github: GitHubOptions },
): Promise<InterruptionResolutionResult> {
  const uw = request.mandate.scope
  const published = await publishConfirmedWorkflowRecord(
    record,
    input.github,
    createPublicationContextResolver(input.github, null),
    histories,
  )
  if (published.status !== 'confirmed')
    return { status: 'partial', uw, diagnostics: published.diagnostics.map((d) => problem(uw, d.code, d.message)) }
  const readback = await input.reader.readUw(uw)
  if (readback.observation.status !== 'complete')
    return {
      status: 'partial',
      uw,
      diagnostics: [problem(uw, 'interruption-readback-unconfirmed', 'Resolution readback is incomplete')],
    }
  const authenticated = startResolution(readback.observation.histories, request.start)
  if (
    !authenticated.ok ||
    authenticated.value === null ||
    JSON.stringify(authenticated.value.record) !== JSON.stringify(record)
  )
    return {
      status: 'partial',
      uw,
      diagnostics: [
        problem(uw, 'interruption-readback-unconfirmed', 'Published resolution could not be authenticated'),
      ],
    }
  return { status: 'resolved', start: request.start, resolution: { ...ref(record), kind: 'operator-control' } }
}

type InterruptionPorts = { operator: OperatorPort; reader: UwReadPort; github: GitHubOptions }

export function createUwInterruptionResolution(input: InterruptionPorts) {
  return (request: ResolveInterruptionRequest): Promise<InterruptionResolutionResult> =>
    resolveInterruptionRequest(input, request)
}

async function resolveInterruptionRequest(
  input: InterruptionPorts,
  request: ResolveInterruptionRequest,
): Promise<InterruptionResolutionResult> {
  const uw = request.mandate.scope
  let mayExist = false
  const refused = (code: string, message: string): InterruptionResolutionResult => ({
    status: 'refused',
    diagnostics: [problem(uw, code, message)],
  })
  try {
    const dispatch = startDispatch(request.start)
    if (dispatch?.kind !== 'not-activated' && dispatch?.kind !== 'closed-before-admission')
      return refused('interruption-dispatch-unproven', 'Native dispatch was not positively prevented')
    const observe = () => observeInterruption(input.reader, request)
    const first = await observe()
    if (!first.ok) return { status: 'refused', diagnostics: first.diagnostics }
    if (hash(first.dispatch) !== hash(dispatch))
      return refused('proposal-stale', 'Dispatch observation changed before confirmation')
    const operationId = `resolve-interruption:${randomUUID()}`
    const c = first.candidate
    const proposal: ResolutionProposal = {
      control: 'resolve-interruption',
      controlId: operationId,
      mandate: request.mandate,
      predecessor: ref(c.pause),
      action: c.action,
      actionId: c.actionId,
      start: request.start,
      result: c.result === null ? null : ref(c.result),
      executor: { kind: 'not-dispatched' },
      runtime: first.observation.runtime,
    }
    const digest = interruptionResolutionDigest(proposal)
    const prepared: PreparedInterruptionResolution = {
      proposal: {
        ...proposal,
        format: INTERRUPTION_RESOLUTION_FORMAT,
        operationId,
        uw,
        historyDigest: hash(first.histories),
      },
      digest,
    }
    const isStale = (fresh: Awaited<ReturnType<typeof observe>>) =>
      !fresh.ok ||
      hash(fresh.histories) !== prepared.proposal.historyDigest ||
      hash(fresh.candidate) !== hash(first.candidate) ||
      hash(fresh.observation) !== hash(first.observation) ||
      hash(fresh.dispatch) !== hash(first.dispatch)
    const confirmed = await input.operator.executeConfirmed(
      prepared,
      async (confirmation): Promise<InterruptionResolutionResult> => {
        const fresh = await observe()
        if (!fresh.ok || isStale(fresh))
          return refused('proposal-stale', 'Interruption authority or observation changed after confirmation')
        const built = buildAdmittedResolution(request, proposal, digest, operationId, confirmation, fresh.histories)
        if (!built.ok) return { status: 'refused', diagnostics: built.diagnostics }
        if (hash(startDispatch(request.start) ?? null) !== hash(first.dispatch))
          return refused('proposal-stale', 'Dispatch observation changed before publication')
        mayExist = true
        return publishAndReadback(built.record, fresh.histories, request, input)
      },
    )
    return confirmed.status === 'confirmed' ? confirmed.value : confirmed
  } catch (error) {
    return failedResolution(uw, mayExist, error)
  }
}

function failedResolution(uw: Scope, mayExist: boolean, error: unknown): InterruptionResolutionResult {
  const diagnostics = [
    problem(uw, 'interruption-resolution-unconfirmed', error instanceof Error ? error.message : String(error)),
  ]
  return mayExist ? { status: 'partial', uw, diagnostics } : { status: 'refused', diagnostics }
}
