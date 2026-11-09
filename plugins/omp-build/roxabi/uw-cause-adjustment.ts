import { randomUUID } from 'node:crypto'
import type {
  IssueRef,
  IssueWriteObservation,
  IssueWriter,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import {
  assessUwCompletion,
  bindExternalRef,
  buildRecord,
  type GitHubOptions,
  prepareCauseDependencyAdjustment,
  publishConfirmedWorkflowRecord,
  recheckCauseDependencyAdjustment,
  recheckCauseDependencyAdjustmentEffect,
} from '../dist/contracts.js'
import type { PreparedCauseDependencyAdjustment } from '../engine/cause-dependency-adjustment-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { CauseDependencyAdjustmentInputJson } from '../engine/uw-command-schema.ts'
import type { UwCompletionAssessment, UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import type { OperatorPort } from './uw-contract.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { issueRef } from './uw-operation-observation.ts'

export type CauseAdjustmentResult =
  | {
      status: 'adjusted'
      control: { scope: Scope; recordId: string; kind: 'operator-control' }
      completion: UwCompletionAssessment
    }
  | { status: 'refused' | 'deferred' | 'partial'; diagnostics: readonly UwDiagnostic[] }

function problem(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'blockers' }, related: [] }
}

function refs(scopes: readonly Scope[]): IssueRef[] {
  return scopes.map((scope) => {
    const ref = issueRef(scope)
    if (ref === null) throw new Error(`Invalid issue scope ${scope.repository} ${scope.target}`)
    return ref
  })
}

type AdjustmentPorts = {
  operator: OperatorPort
  writer: IssueWriter
  github: GitHubOptions
  readObservation(uw: Scope, additionalScopes: readonly Scope[]): Promise<UwCompletionObservation>
}

type AdjustmentContext = {
  input: AdjustmentPorts
  request: CauseDependencyAdjustmentInputJson
  accepted: PreparedCauseDependencyAdjustment
  operationId: string
  recheckSeeds: Scope[]
  effectState: { mayExist: boolean }
}

async function applyNativeEffect(
  context: AdjustmentContext,
  checked: PreparedCauseDependencyAdjustment,
  fresh: UwCompletionObservation,
  target: IssueRef,
) {
  const { input, request, effectState } = context
  const uw = request.origin
  const effect = checked.proposal.nativeEffect
  const observed = rootObservation(uw, { graph: fresh.graph })
  if (effect.kind !== 'update-blockers') return { ok: true as const, observed }
  const before = checked.proposal.before
  effectState.mayExist = true
  const written = await input.writer.update(
    target,
    {
      repository: uw.repository,
      title: before.title,
      body: before.body,
      labels: { add: [], remove: [] },
      relations: {
        addChildren: [],
        removeChildren: [],
        addBlockers: refs(effect.add),
        removeBlockers: refs(effect.remove),
      },
    },
    before,
  )
  if (written.status !== 'written')
    return {
      ok: false as const,
      result: {
        status: written.status === 'refused' ? 'refused' : 'partial',
        diagnostics: written.diagnostics.map((entry) => problem(uw, entry.code, entry.message)),
      } satisfies CauseAdjustmentResult,
    }
  return { ok: true as const, observed: written.observed }
}

async function readAndCheckEffect(
  context: AdjustmentContext,
  checked: PreparedCauseDependencyAdjustment,
  observed: IssueWriteObservation | null,
) {
  const { input, request, recheckSeeds, accepted, effectState } = context
  const uw = request.origin
  const after = await input.readObservation(uw, recheckSeeds)
  if (checked.proposal.nativeEffect.kind === 'none') observed = rootObservation(uw, { graph: after.graph })
  if (observed === null)
    return {
      ok: false as const,
      result: {
        status: effectState.mayExist ? 'partial' : 'refused',
        diagnostics: [
          problem(uw, 'adjustment-readback-unavailable', 'The origin issue was not observed after the adjustment'),
        ],
      } satisfies CauseAdjustmentResult,
    }
  const actual = {
    ...observed,
    labels: [...observed.labels],
    children: [...observed.children],
    blockers: [...observed.blockers],
  }
  const checkedEffect = recheckCauseDependencyAdjustmentEffect(accepted, actual, after)
  if (!checkedEffect.ok)
    return {
      ok: false as const,
      result: {
        status: effectState.mayExist ? 'partial' : 'refused',
        diagnostics: checkedEffect.diagnostics,
      } satisfies CauseAdjustmentResult,
    }
  return { ok: true as const, actual, after }
}

async function confirmPublishedControl(
  context: AdjustmentContext,
  canonicalRecord: Parameters<typeof publishConfirmedWorkflowRecord>[0],
): Promise<CauseAdjustmentResult> {
  const { input, request, operationId, recheckSeeds } = context
  const uw = request.origin
  const result = await input.readObservation(uw, recheckSeeds)
  const control = { scope: uw, recordId: operationId, kind: 'operator-control' as const }
  const home = result.histories.find(
    (entry) => entry.source.scope.repository === uw.repository && entry.source.scope.target === uw.target,
  )
  const bound = home === undefined ? null : bindExternalRef(control, home)
  if (!bound?.ok || JSON.stringify(bound.value) !== JSON.stringify(canonicalRecord))
    return {
      status: 'partial',
      diagnostics: [
        problem(uw, 'control-readback-unconfirmed', 'Published adjustment did not bind to its exact canonical record'),
      ],
    }
  const completion = assessUwCompletion(result)
  const applied = completion.waits.causeWaits.find(
    (entry) =>
      entry.origin.repository === uw.repository &&
      entry.origin.target === uw.target &&
      entry.receipt.recordId === request.receipt.recordId &&
      entry.receipt.scope.repository === request.receipt.scope.repository &&
      entry.receipt.scope.target === request.receipt.scope.target,
  )
  if (!applied || applied.state === 'held' || applied.control?.recordId !== control.recordId)
    return {
      status: 'partial',
      diagnostics: [
        problem(
          uw,
          'control-authority-unconfirmed',
          'Published adjustment did not authenticate as the terminal causal control',
        ),
      ],
    }
  return { status: 'adjusted', control, completion }
}

async function publishAndConfirm(
  context: AdjustmentContext,
  confirmation: OperatorConfirmationEvidence,
  actual: PreparedCauseDependencyAdjustment['proposal']['before'],
  after: UwCompletionObservation,
): Promise<CauseAdjustmentResult> {
  const { input, request, accepted, operationId, effectState } = context
  const uw = request.origin
  const record = buildRecord({
    ...uw,
    version: 1,
    kind: 'operator-control',
    recordId: operationId,
    runId: operationId,
    operationId,
    payload: {
      control: 'adjust-cause-dependency',
      proposal: accepted.proposal,
      proposalDigest: accepted.digest,
      confirmation,
      execution: { observed: actual },
    },
  })
  if (!record.ok)
    return {
      status: effectState.mayExist ? 'partial' : 'refused',
      diagnostics: record.diagnostics.map((entry) => problem(uw, entry.code, entry.message)),
    }
  const canonicalRecord = record.value
  effectState.mayExist = true
  const publication = await publishConfirmedWorkflowRecord(
    canonicalRecord,
    input.github,
    createPublicationContextResolver(input.github, null),
    after.histories,
  )
  if (publication.status !== 'confirmed')
    return {
      status: 'partial',
      diagnostics: publication.diagnostics.map((entry) => problem(uw, entry.code, entry.message)),
    }
  return confirmPublishedControl(context, canonicalRecord)
}

async function executeAdjustment(
  context: AdjustmentContext,
  confirmation: OperatorConfirmationEvidence,
): Promise<CauseAdjustmentResult> {
  const { input, request, accepted, recheckSeeds } = context
  const uw = request.origin
  const fresh = await input.readObservation(uw, recheckSeeds)
  const checked = recheckCauseDependencyAdjustment(accepted, fresh)
  if (!checked.ok) return { status: 'refused', diagnostics: checked.diagnostics }
  const target = issueRef(uw)
  if (target === null)
    return { status: 'refused', diagnostics: [problem(uw, 'invalid-issue-scope', 'Origin is not a native issue')] }
  const written = await applyNativeEffect(context, checked.value, fresh, target)
  if (!written.ok) return written.result
  const effectRead = await readAndCheckEffect(context, checked.value, written.observed)
  if (!effectRead.ok) return effectRead.result
  return publishAndConfirm(context, confirmation, effectRead.actual, effectRead.after)
}

/** Confirm one causal decision, execute only its explicit native delta, and publish its actual readback. */
export function createCauseAdjustment(
  input: AdjustmentPorts,
): (request: CauseDependencyAdjustmentInputJson) => Promise<CauseAdjustmentResult> {
  return async (request) => {
    const uw = request.origin
    const seeds = request.change.kind === 'replace' ? [request.change.blocker] : []
    const effectState = { mayExist: false }
    try {
      const observation = await input.readObservation(uw, seeds)
      const operationId = `adjust-cause-dependency:${randomUUID()}`
      const prepared = prepareCauseDependencyAdjustment({
        ...request,
        operationId,
        controlId: operationId,
        observation,
      })
      if (!prepared.ok) return { status: 'refused', diagnostics: prepared.diagnostics }
      const accepted = prepared.value
      const recheckSeeds = [...seeds, ...accepted.proposal.nativeGraph.rows.map((row) => row.uw)]
      const context: AdjustmentContext = { input, request, accepted, operationId, recheckSeeds, effectState }
      const confirmed = await input.operator.executeConfirmed(accepted, (confirmation) =>
        executeAdjustment(context, confirmation),
      )
      return confirmed.status === 'confirmed' ? confirmed.value : confirmed
    } catch (error) {
      return {
        status: effectState.mayExist ? 'partial' : 'refused',
        diagnostics: [problem(uw, 'adjustment-unconfirmed', error instanceof Error ? error.message : String(error))],
      }
    }
  }
}
