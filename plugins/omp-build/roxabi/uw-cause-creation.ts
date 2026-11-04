import type { IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { causeCreationProposalSchema, type GitHubOptions } from '../dist/contracts.js'
import type { CauseSisterInput, ReportPromotionInput } from '../engine/cause-disposition-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { commitConfirmedCause } from './uw-cause-commit.ts'
import { loadCauseCreationSource } from './uw-cause-creation-source.ts'
import { type Commit, causeError, hash, type Prepare } from './uw-cause-creation-support.ts'
import { buildCauseFrame } from './uw-cause-frame.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import { confirmCauseIntent } from './uw-cause-intent.ts'
import type { CauseOperationResult, OperatorPort, PreparedUwProposal, UwReadPort } from './uw-contract.ts'

/** Compose the private #897 prepare/commit once; the operator sees the final creation proposal. */
export function createCauseCreation(input: {
  reader: UwReadPort
  github: GitHubOptions
  operator: OperatorPort
  prepare: Prepare
  commit: Commit
  guardedWriter: (guard: CauseEffectGuard) => IssueWriter
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
      const parsed = causeCreationProposalSchema.safeParse(candidate.proposal)
      if (!parsed.success) throw new Error('cause-creation-proposal-invalid')
      const proposal = parsed.data
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
            markKnown: (scope) => {
              known = scope
            },
          })
        },
      )
      return confirmed.status === 'confirmed'
        ? confirmed.value
        : { status: 'refused', diagnostics: confirmed.diagnostics }
    } catch (error) {
      return intentMayExist
        ? { status: 'partial', uw: known ?? uw, diagnostics: causeError(known ?? uw, error) }
        : { status: 'refused', diagnostics: causeError(uw, error) }
    }
  }
  return {
    createSister: (request) => create(structuredClone(request), 'sister'),
    promoteReport: (request) => create(structuredClone(request), 'report-promotion'),
  }
}
