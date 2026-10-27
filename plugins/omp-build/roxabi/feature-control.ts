// Source: plugins/omp-build/roxabi/workflow.ts:60,289-295,707-855
import { randomUUID } from 'node:crypto'
import type { Gh } from '../adapters/github/types.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { Json } from '../engine/record-values.ts'
import type { ControlRecord } from '../engine/workflow-control.ts'
import type { MandateSelection } from '../engine/workflow-mandate.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type ControlTarget, disarmKnownTarget } from './feature-disarm.ts'
import { type Contracts, type History, isRecord, payload, publishRecord, type Scope } from './feature-engine.ts'

type PausedContinuation = Extract<ContinueFeatureResult, { kind: 'paused' }>

const inhibited = new Map<string, 'pause' | 'abandon'>()

// A public pause can synchronously interrupt native work, whose abort then
// triggers the session-stop pause path. Scope-level coalescing ensures both
// sources share one durable pause control.
const pausesInFlight = new Map<string, Promise<PausedContinuation>>()

export function inhibitKey(scope: Scope): string {
  return `${scope.repository} ${scope.target}`
}

export function inhibition(scope: Scope): 'pause' | 'abandon' | undefined {
  return inhibited.get(inhibitKey(scope))
}

export function inhibit(scope: Scope, control: 'pause' | 'abandon'): void {
  inhibited.set(inhibitKey(scope), control)
}

export function releaseInhibition(scope: Scope): void {
  inhibited.delete(inhibitKey(scope))
}

export function inhibitCwd(cwd: string): void {
  inhibited.set(cwd, 'pause')
}

export function cwdInhibition(cwd: string): 'pause' | 'abandon' | undefined {
  return inhibited.get(cwd)
}

export function releaseCwdInhibition(cwd: string): void {
  inhibited.delete(cwd)
}

function pauseKey(mandate: ScopedRecordRef): string {
  return `${inhibitKey(mandate.scope)}\0${mandate.kind}\0${mandate.recordId}`
}

async function pauseConfirmedReadback(
  loaded: Contracts,
  scope: Scope,
  controlId: string,
  requestRecordId: string,
  options: { cwd: string; gh?: Gh },
): Promise<boolean> {
  const reread = await loaded.readComposedWorkflowHistory([scope], options)
  if (!reread.ok || !reread.histories[0]) return false
  return reread.histories[0].operations.some((operation) => {
    const record = operation.record
    if (operation.status !== 'complete' || record?.kind !== 'operator-control') return false
    const body = payload(record)
    if (body.control !== 'pause-confirmed' || body.controlId !== controlId) return false
    if (!isRecord(body.predecessor)) return false
    return body.predecessor.recordId === requestRecordId && body.predecessor.kind === 'operator-control'
  })
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return true
  if (Array.isArray(value)) return value.every(isJson)
  return isRecord(value) && Object.values(value).every(isJson)
}

export function bindsOwnPause(
  loaded: Contracts,
  selection: MandateSelection,
  history: DecodedHistory,
  scope: Scope,
  expected?: ScopedRecordRef,
): boolean {
  if (selection.status !== 'refused' || selection.reason !== 'paused') return false
  const { mandate, confirmation } = selection.pause
  if (
    mandate.scope.repository !== scope.repository ||
    mandate.scope.target !== scope.target ||
    confirmation.scope.repository !== scope.repository ||
    confirmation.scope.target !== scope.target ||
    (expected !== undefined &&
      (mandate.kind !== expected.kind ||
        mandate.recordId !== expected.recordId ||
        mandate.scope.repository !== expected.scope.repository ||
        mandate.scope.target !== expected.scope.target))
  ) {
    return false
  }
  return loaded.bindExternalRef(mandate, history).ok && loaded.bindExternalRef(confirmation, history).ok
}

type PausePublicationInput = {
  loaded: Contracts
  history: History
  scope: Scope
  target: ControlTarget
  gh: Gh
  cwd: string
  parentHistories: readonly History[]
  mandate: ScopedRecordRef
  role: 'feature' | 'epic' | 'fix-only' | null
  branch: string | null
  options: { cwd: string; gh?: Gh }
}

export async function publishConfirmedPause(input: PausePublicationInput): Promise<PausedContinuation> {
  const key = pauseKey(input.mandate)
  const inFlight = pausesInFlight.get(key)
  if (inFlight !== undefined) return inFlight
  const publication = publishPause(input)
  pausesInFlight.set(key, publication)
  try {
    return await publication
  } finally {
    if (pausesInFlight.get(key) === publication) pausesInFlight.delete(key)
  }
}

async function publishPause(input: PausePublicationInput): Promise<PausedContinuation> {
  const admission = await admitPausePublication(input)
  if ('kind' in admission) return admission
  const { history, parents } = admission
  const controlId = randomUUID()
  const requestedId = randomUUID()
  const requested = await publishRecord(
    input.loaded,
    history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: requestedId,
      runId: requestedId,
      operationId: requestedId,
      kind: 'operator-control',
      payload: {
        control: 'pause-requested',
        controlId,
        predecessor: null,
        mandate: input.mandate,
      },
    },
    input.gh,
    input.cwd,
    parents,
  )
  const evidence = await disarmKnownTarget(input.gh, input.cwd, input.target, input.role, input.branch, {
    loaded: input.loaded,
    mandate: input.mandate,
  })
  if (!requested.ok || !evidence.clean) {
    return { kind: 'paused', confirmed: false, reason: requested.ok ? 'pause-unconfirmed' : 'pause-uncertain' }
  }
  if (!isJson(evidence.evidence)) return { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }
  await publishRecord(
    input.loaded,
    history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'operator-control',
      payload: {
        control: 'pause-confirmed',
        controlId,
        predecessor: { scope: input.scope, recordId: requestedId, kind: 'operator-control' },
        mandate: input.mandate,
        disarm: { observed: true, evidence: evidence.evidence },
      } satisfies Extract<ControlRecord['payload'], { control: 'pause-confirmed' }>,
    },
    input.gh,
    input.cwd,
    parents,
  )
  const seen = await pauseConfirmedReadback(input.loaded, input.scope, controlId, requestedId, input.options)
  return seen
    ? { kind: 'paused', confirmed: true, reason: 'pause-confirmed' }
    : { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }
}

async function admitPausePublication(
  input: PausePublicationInput,
): Promise<{ history: History; parents: readonly History[] } | PausedContinuation> {
  const fresh = await input.loaded.readComposedWorkflowHistory([input.scope], input.options)
  if (!fresh.ok || fresh.histories[0] === undefined) {
    return { kind: 'paused', confirmed: false, reason: 'pause-uncertain' }
  }
  const history = fresh.histories[0]
  const parentResult = await mandateParentHistories(input.loaded, history, input.options)
  if (!parentResult.ok || !input.loaded.bindExternalRef(input.mandate, history).ok) {
    return { kind: 'paused', confirmed: false, reason: 'pause-uncertain' }
  }
  const selection = input.loaded.selectApplicableMandate(history, parentResult.parents)
  if (bindsOwnPause(input.loaded, selection, history, input.scope, input.mandate)) {
    return { kind: 'paused', confirmed: true, reason: 'paused' }
  }
  if (
    selection.status !== 'applicable' ||
    selection.mandate.recordId !== input.mandate.recordId ||
    selection.mandate.repository !== input.mandate.scope.repository ||
    selection.mandate.target !== input.mandate.scope.target
  ) {
    return { kind: 'paused', confirmed: false, reason: 'pause-uncertain' }
  }
  return { history, parents: parentResult.parents }
}
