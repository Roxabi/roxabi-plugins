import type { IssueRef, IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { causeCreationProposalSchema, type GitHubOptions } from '../dist/contracts.js'
import type { CauseSisterInput, ReportPromotionInput } from '../engine/cause-disposition-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { commitConfirmedCause } from './uw-cause-commit.ts'
import { loadCauseCreationSource } from './uw-cause-creation-source.ts'
import { type Commit, causeError, hash, type Prepare } from './uw-cause-creation-support.ts'
import { buildCauseFrame } from './uw-cause-frame.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import { confirmCauseIntent } from './uw-cause-intent.ts'
import { prepareCauseParentAcceptance } from './uw-cause-parent-preparation.ts'
import type {
  CauseOperationResult,
  CreatedUwReadPort,
  OperatorPort,
  PreparedUwProposal,
  UwReadPort,
} from './uw-contract.ts'
import type { ProductionReaderOptions } from './uw-input-readers.ts'
import type { UwNativeHost } from './uw-installed-operations.ts'

/** Compose the private #897 prepare/commit once; the operator sees the final creation proposal. */
export function createCauseCreation(input: {
  reader: UwReadPort
  nativeReader: CreatedUwReadPort
  github: GitHubOptions
  operator: OperatorPort
  nativeHost?: UwNativeHost
  actionOptions: ProductionReaderOptions
  prepare: Prepare
  commit: Commit
  guardedWriter: (guard: CauseEffectGuard, composedParent: IssueRef | null) => IssueWriter
}): {
  createSister(request: CauseSisterInput): Promise<CauseOperationResult>
  promoteReport(request: ReportPromotionInput): Promise<CauseOperationResult>
} {
  async function create(
    request: CauseSisterInput | ReportPromotionInput,
    mode: 'sister' | 'report-promotion',
  ): Promise<CauseOperationResult> {
    const ref = mode === 'sister' ? (request as CauseSisterInput).disposition : (request as ReportPromotionInput).report
    const uw = ref.scope
    let known: Scope | null = null
    let intentMayExist = false
    let assessmentMayExist = false
    try {
      const initial = await loadCauseCreationSource(input, request, mode)
      const { source, originalDigest, parentScope } = initial
      const parent = initial.parent
      const { createInput, relation, context } = buildCauseFrame(
        source,
        request,
        mode,
        parentScope,
        parent,
        originalDigest,
      )
      const candidate = input.prepare(createInput, context)
      if ('diagnostics' in candidate) return { status: 'refused', diagnostics: candidate.diagnostics }
      const parsed = causeCreationProposalSchema.safeParse({ ...candidate.proposal, parentAcceptance: null })
      if (!parsed.success) throw new Error('cause-creation-proposal-invalid')
      const parsedProposal = parsed.data
      async function prepareParent() {
        if (parent?.state !== 'active') return { creation: parsedProposal.creation, composed: undefined }
        const host = input.nativeHost
        if (parentScope === null || request.parentCoverage == null || host === undefined)
          throw new Error('cause-parent-assessment-host-unavailable')
        const { creation, parentAcceptance: _parentAcceptance, ...coreFields } = parsedProposal
        const prepared = await prepareCauseParentAcceptance({
          core: coreFields,
          creation,
          parentCoverage: request.parentCoverage,
          parent: parentScope,
          origin: uw,
          originalDigest,
          github: input.github,
          reader: input.reader,
          host,
          actionOptions: input.actionOptions,
          markAssessmentEffect: () => {
            assessmentMayExist = true
          },
        })
        return {
          composed: { ...prepared, host },
          creation: {
            ...parsedProposal.creation,
            parentObservation: {
              ...parent,
              nativeDigest: prepared.consent.nativeObservationDigest,
              historyDigest: prepared.consent.historyDigest,
            },
          },
        }
      }
      const { creation, composed } = await prepareParent()
      const proposal = causeCreationProposalSchema.parse({
        ...parsedProposal,
        creation,
        parentAcceptance: composed?.consent ?? null,
      })
      const prepared: PreparedUwProposal = { proposal, digest: hash(proposal) }
      const confirmed = await input.operator.executeConfirmed(
        prepared,
        async (confirmation): Promise<CauseOperationResult> => {
          const intentResult = await confirmCauseIntent({
            input,
            mode,
            ref,
            source,
            originalDigest,
            parent,
            proposal,
            prepared,
            confirmation,
            composed: composed === undefined ? undefined : { before: composed.before, signal: composed.host.signal },
            markEffect: () => {
              intentMayExist = true
            },
          })
          if (!intentResult.ok) return intentResult.result
          return commitConfirmedCause({
            input,
            confirmedIntent: intentResult,
            confirmation,
            mode,
            ref,
            source,
            originalDigest,
            parentScope,
            createInput,
            relation,
            proposal,
            prepared,
            parentAcceptance:
              composed === undefined
                ? undefined
                : { prepared: composed.prepared, before: composed.before, signal: composed.host.signal },
            markKnown: (scope) => {
              known = scope
            },
          })
        },
      )
      function finishConfirmation(): CauseOperationResult {
        if (confirmed.status === 'confirmed') {
          const result = confirmed.value
          if ((result.status !== 'refused' && result.status !== 'deferred') || !assessmentMayExist) return result
          return {
            status: 'partial',
            uw,
            diagnostics: [
              ...result.diagnostics,
              ...causeError(uw, new Error('parent-assessment-published-creation-unconfirmed')),
            ],
          }
        }
        return assessmentMayExist
          ? {
              status: 'partial',
              uw,
              diagnostics: [
                ...confirmed.diagnostics,
                ...causeError(uw, new Error('parent-assessment-published-creation-unconfirmed')),
              ],
            }
          : confirmed
      }
      return finishConfirmation()
    } catch (error) {
      return intentMayExist || assessmentMayExist
        ? { status: 'partial', uw: known ?? uw, diagnostics: causeError(known ?? uw, error) }
        : { status: 'refused', diagnostics: causeError(uw, error) }
    }
  }
  return {
    createSister: (request) => create(structuredClone(request), 'sister'),
    promoteReport: (request) => create(structuredClone(request), 'report-promotion'),
  }
}
