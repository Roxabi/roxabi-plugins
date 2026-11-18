import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { causalRefusal } from './causal-refusal.ts'
import { prepareRefusal } from './delivery-action.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContextHandoffRequest, ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { scopeNumber } from './feature-delivery-facts.ts'
import { establishFirstMandate } from './feature-initial-mandate.ts'
import { plannerSuccessionInspection } from './feature-planner-succession.ts'
import { prepareSelectionSession } from './feature-selection-checkout.ts'
import { specEntrySelection } from './feature-selection-spec-entry.ts'
import { createSuccessorSelection } from './feature-selection-successor.ts'
import { composeObservedUwCausalContext } from './fix-uw-histories.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'
import { assessmentSuccessionInspection } from './uw-assessment-prestart.ts'
import type { UwOperations, UwRead, UwReadPort } from './uw-contract.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'
import { readSelectionIssueSpec, type SelectionIssueSpec } from './uw-spec'

export type SelectedFeature = {
  authority: FeatureAuthority
  number: number
  reader: UwReadPort | null
  issue: SelectionIssueSpec
  uwRead: UwRead | null
  mandate: MandateRecord | null
  acceptedSpec: AcceptedOwnSpec | null
  assessmentReplay?: AssessmentReplayContext
  assessmentInspection?: AcceptedSpecInspection
  mandateRef: ScopedRecordRef | null
  /** This call published the first or successor Mandate, consuming supplied coverage intent. */
  mandatePublished: boolean
}

type SelectionState = Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'>

export async function selectFeatureMandate(
  control: FeatureControl,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  uw?: UwOperations,
  reader: UwReadPort | undefined = uw,
  parentCoverage?: import('../engine/workflow-mandate-schema.ts').ParentCoverage | null,
  parentCoverageBasis?: import('./feature-contract.ts').ParentCoverageRequest,
  contextHandoff?: ContextHandoffRequest,
  assessmentReplay?: AssessmentReplayContext,
  assessmentInspection?: AcceptedSpecInspection,
): Promise<SelectedFeature | ContinueFeatureResult> {
  const { context, identity, scope } = authority
  const number = scopeNumber(scope)
  if (number === 0) return { kind: 'blocked', reason: 'issue-unreadable' }
  const issue = await readSelectionIssueSpec(context.cwd, scope.repository, number, context.gh)
  if (issue === null) return { kind: 'blocked', reason: 'issue-unreadable' }
  const uwRead = reader === undefined ? null : await reader.readUw(scope)
  const branch =
    authority.target.status === 'pull-request'
      ? authority.target.pullRequest.branch
      : branchFor({ number, title: issue.title, labels: issue.labels })
  const entry = specEntrySelection(control, authority, uwRead)
  if (entry !== null) return entry
  const sessionCwd = identity.ok ? identity.sessionTop : null
  const updated = await updateMandateSelection(
    control,
    authority,
    uwRead,
    reader,
    uw,
    branch,
    parentCoverage,
    parentCoverageBasis,
    contextHandoff,
  )
  if ('kind' in updated) return updated
  const selected = await finishSelection(
    authority,
    updated,
    exactMandateRef,
    issue,
    number,
    uwRead,
    reader,
    assessmentReplay,
    assessmentInspection,
  )
  if ('kind' in selected) return selected
  const prepared = await prepareSelectionSession(
    control,
    selected,
    branch,
    sessionCwd,
    updated.state,
    assessmentReplay !== undefined,
  )
  return prepared ?? selected
}

async function finishSelection(
  authority: FeatureAuthority,
  { state: updated, mandatePublished }: { state: SelectionState; mandatePublished: boolean },
  exactMandateRef: ScopedRecordRef | undefined,
  issue: SelectionIssueSpec,
  number: number,
  uwRead: UwRead | null,
  reader: UwReadPort | undefined,
  assessmentReplay?: AssessmentReplayContext,
  assessmentInspection?: AcceptedSpecInspection,
): Promise<SelectedFeature | ContinueFeatureResult> {
  const observed = await observeSelectedCausal(authority, updated, mandatePublished, uwRead, reader, assessmentReplay)
  if ('kind' in observed) return observed
  const { selectionReader, currentRead, selectionCausal } = observed
  const { context, scope } = authority
  const current = currentAccountedMandate(updated.history)
  const proof = current.ok
    ? await plannerSuccessionInspection(current.value, selectionCausal)
    : { ok: true as const, value: undefined }
  if (!proof.ok) return { kind: 'blocked', reason: prepareRefusal(proof.diagnostics), diagnostics: proof.diagnostics }
  assessmentInspection = assessmentSuccessionInspection(proof.value)
  const applicable = context.engine.selectApplicableMandate(
    updated.history,
    updated.parentHistories,
    selectionCausal,
    new Set(),
    assessmentInspection,
    selectionCausal.historical,
  )
  const exactProblem = exactSelectionProblem(applicable, exactMandateRef)
  if (exactProblem !== null) return exactProblem
  const own = context.engine.resolveOwnSpecAuthority(
    updated.history,
    updated.parentHistories,
    selectionCausal,
    new Set(),
    assessmentReplay,
    assessmentInspection,
    selectionCausal.historical,
  )
  const mandate = own.ok ? own.value.mandate : null
  const mandateRef: ScopedRecordRef | null =
    exactMandateRef ?? (mandate === null ? null : { scope, recordId: mandate.recordId, kind: 'mandate' })
  return {
    authority: { ...authority, ...updated, causal: selectionCausal, selection: applicable },
    number,
    reader: selectionReader ?? null,
    issue,
    uwRead: currentRead,
    mandate,
    acceptedSpec: own.ok ? own.value.accepted : null,
    ...(assessmentReplay === undefined ? {} : { assessmentReplay }),
    ...(assessmentInspection === undefined ? {} : { assessmentInspection }),
    mandateRef,
    mandatePublished,
  }
}

async function observeSelectedCausal(
  authority: FeatureAuthority,
  updated: SelectionState,
  mandatePublished: boolean,
  uwRead: UwRead | null,
  reader: UwReadPort | undefined,
  assessmentReplay?: AssessmentReplayContext,
) {
  const { context, scope } = authority
  let selectionReader = reader
  if (mandatePublished) {
    const refreshed = await selectionReaderAfterPublication(authority, updated, assessmentReplay)
    if ('kind' in refreshed) return refreshed
    selectionReader = refreshed.reader ?? reader
  }
  const currentRead =
    selectionReader !== undefined && updated.history !== authority.history
      ? await selectionReader.readUw(scope)
      : uwRead
  const causal =
    currentRead === null
      ? updated.causal
      : await composeObservedUwCausalContext(currentRead, [updated.history, ...updated.parentHistories], {
          cwd: context.cwd,
          gh: context.gh,
        })
  if ('ok' in causal && !causal.ok) return { kind: 'blocked' as const, ...causalRefusal(causal) }
  const selectionCausal = 'ok' in causal ? causal.value : causal
  return { selectionReader, currentRead, selectionCausal }
}

async function selectionReaderAfterPublication(
  authority: FeatureAuthority,
  updated: SelectionState,
  assessmentReplay?: AssessmentReplayContext,
): Promise<{ reader?: UwReadPort } | ContinueFeatureResult> {
  const current = currentAccountedMandate(updated.history)
  const proof = current.ok
    ? await plannerSuccessionInspection(current.value, updated.causal)
    : { ok: true as const, value: undefined }
  if (!proof.ok) return { kind: 'blocked', reason: prepareRefusal(proof.diagnostics), diagnostics: proof.diagnostics }
  const inspection = assessmentSuccessionInspection(proof.value)
  if (inspection === undefined) return {}
  return {
    reader: createInstalledUwReadPort({
      cwd: authority.context.cwd,
      gh: authority.context.gh,
      assessmentReplay,
      assessmentInspection: inspection,
    }),
  }
}

function exactSelectionProblem(
  selection: FeatureAuthority['selection'],
  ref: ScopedRecordRef | undefined,
): ContinueFeatureResult | null {
  if (ref === undefined) return null
  if (selection.status !== 'applicable') return { kind: 'blocked', reason: `exact-mandate-${selection.reason}` }
  if (selection.mandate === null || selection.mandate.recordId !== ref.recordId)
    return { kind: 'blocked', reason: 'exact-mandate-not-applicable' }
  return null
}

async function updateMandateSelection(
  control: FeatureControl,
  authority: FeatureAuthority,
  uwRead: UwRead | null,
  reader: UwReadPort | undefined,
  uw: UwOperations | undefined,
  branch: string,
  parentCoverage?: import('../engine/workflow-mandate-schema.ts').ParentCoverage | null,
  parentCoverageBasis?: import('./feature-contract.ts').ParentCoverageRequest,
  contextHandoff?: ContextHandoffRequest,
): Promise<{ state: SelectionState; mandatePublished: boolean } | ContinueFeatureResult> {
  const state: SelectionState = authority
  if (
    control === 'new' &&
    state.selection.status === 'refused' &&
    (state.selection.reason === 'abandoned' || state.selection.reason === 'revoked')
  ) {
    const successor = await createSuccessorSelection({
      authority,
      uwRead,
      reader,
      uw,
      branch,
      parentCoverage,
      parentCoverageBasis,
      contextHandoff,
      ...state,
    })
    if ('kind' in successor) return successor
    return { state: successor, mandatePublished: true }
  }
  if (contextHandoff !== undefined) return { kind: 'blocked', reason: 'context-handoff-successor-required' }
  if (
    state.selection.status === 'refused' &&
    state.selection.reason === 'missing' &&
    (control === 'select' || control === 'continue')
  ) {
    const established = await establishFirstMandate({
      authority,
      uwRead,
      reader,
      branch,
      history: state.history,
      parentCoverage,
      parentCoverageBasis,
    })
    if ('kind' in established) return established
    return { state: { ...state, ...established }, mandatePublished: true }
  }
  return { state, mandatePublished: false }
}
