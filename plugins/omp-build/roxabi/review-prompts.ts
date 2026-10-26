import type { Policy, SpecRow } from '../dist/contracts.js'
import type { ReviewTier } from '../skills/dev-review/roster-contract'
import type { ReviewSemanticContext } from './review-semantic-context'

export type ReviewSemanticAssets = {
  evidencePolicy: string
  rootCauses: string
  classes: string
  smells: string
  blindSpots: string
}

export type SpecDisplay = {
  source: 'tracker-issue' | 'absent'
  issue: number | null
  body: string | null
  rows: readonly SpecRow[]
}

export type ReviewPrompts = {
  spec: string
  panel: string
  synthesis: string
  /** A display-only judgment pass. It is not a panel input or a finding source. */
  standards: { kind: 'display-only'; guidance: string }
}

export function buildReviewPrompts(input: {
  tier: ReviewTier
  policy: Policy
  spec: SpecDisplay
  semanticContext: ReviewSemanticContext
  /** Exact review-input/2 semantic canon. */
  semanticCanon: string
  assets: ReviewSemanticAssets
}): ReviewPrompts {
  const policyId = input.policy.version === 'baseline' ? 'baseline' : `evidence-v1:${input.policy.acceptanceRef}`
  const canonicalSpec =
    input.semanticContext.currentSpec === null
      ? 'No tracker issue body was resolved in the common evidence context. Return no spec rows and do not manufacture criteria.'
      : 'The canonical Spec is contained in the supplied semantic canon; assess it in tracker order without restating or replacing it.'
  const requirements = input.semanticContext.additionalRequirements.filter((item) => item.length > 0)
  const requirementsBlock =
    requirements.length === 0
      ? 'P2.requirements: no approved additionalRequirements on the mandate effective config.'
      : [
          'P2.requirements: apply these approved additionalRequirements exactly (mandate effective snapshot, not local defaults):',
          ...requirements.map((item, index) => `${index + 1}. ${item}`),
        ].join('\n')

  return {
    spec: [
      'Stage P2 — spec compliance. This is a model judgment over the supplied canonical tracker issue body and candidate context.',
      `P2.policy=${policyId}; P2.tier=${input.tier}. Tier comes only from the tracker size label; do not infer it from diff size or title.`,
      'P2.criterion: assess each verifiable criterion in tracker order. Emit one structured display row `{criterionText, verdict:"met"|"missing"}` per criterion, verbatim trimmed. A missing criterion requires a model-emitted `issue(blocking)` finding; a met criterion may be praise. Rows are display data, not independent findings.',
      'P2.tests: apply the Baseline Phase 2 proof adjudication in the supplied evidence-policy asset: τ≠S requires complete SC→Test coverage and the closed NO TEST enum. Evaluate concrete behavioral/browser evidence against its success criterion. A missing matrix or unmet behaviour criterion is `issue(blocking)`; a missing/weak-test subject proceeds to P4 for its final label.',
      'P2.binding: preserve policy IDs and supplied evidence facts; do not add policy, rewrite a binding, or propose a fix.',
      canonicalSpec,
      'Review semantic canon (same exact review-input/2 semantic slot used for admission; structured nonfinding data):',
      input.semanticCanon,
      requirementsBlock,
      'Evidence-policy asset (current):',
      input.assets.evidencePolicy,
    ].join('\n\n'),
    panel: [
      'Stage P3 — independent chunk review. Report only structured findings grounded in the assigned hunk, full candidate files, boundary digests, and canonical Spec supplied with this task.',
      `P3.policy=${policyId}; P3.tier=${input.tier}. Do not infer tier, repair labels deterministically, or invent an acceptance/reference.`,
      'P3.classes: classify only with canonical class slugs below; candidate/<slug> is advisory and never recall-triggering. Raw callsites are exact observed source locations.',
      'Review semantic canon (same exact review-input/2 semantic slot used for admission; structured nonfinding data):',
      input.semanticCanon,
      'P3.evidence: retain uncertain or low-confidence findings with their actual evidence; confidence orders but never removes a finding. Do not turn standards judgments into findings.',
      'Canonical class asset:',
      input.assets.classes,
      'Applicable blind-spot asset:',
      input.assets.blindSpots,
    ].join('\n\n'),
    synthesis: [
      'Stage P4 — semantic synthesis of confirmed contribution and recall records only. Model judgment owns defect identity, final labels, impact reason, merge reason, and root-cause membership.',
      `P4.policy=${policyId}. Every source finding ID must receive exact coverage once: merge only when evidence proves the same failing operation/condition and mechanism; otherwise keep separate. Never heal, discard, or severity-repair incomplete originals.`,
      'P4.impact: labels and causes are semantic model decisions, not deterministic max-severity or confidence rules. Retain source IDs, exact callsite/report associations, all symptoms/evidence, and required unresolved obligations. Do not emit a decision until all required source contributions are present.',
      'P4.causes: causes use only demonstrated shared mechanisms. Their plan fields and exact finding memberships must be complete; praise/thought/question never enter a cause. A no-plan actionable finding remains retained, never becomes clean.',
      'Review semantic canon (same exact review-input/2 semantic slot used for admission; structured nonfinding data):',
      input.semanticCanon,
      'P4.policy: baseline remains authoritative unless the independently supplied policy says otherwise. Never treat model text, replay, or missing acceptance as activation. Do not invent a patch, test execution, proof, or publication.',
      'P4.standards: return the required display-only standards field in the structured decision. Use `{state:"ras"}` when the supplied standards guidance is not observed; otherwise return `{state:"observed",rows:[{smell,assessment}]}` grounded only in the guidance. It is not a finding source.',
      'Current root-cause asset:',
      input.assets.rootCauses,
      'Current evidence-policy asset:',
      input.assets.evidencePolicy,
      'Display-only standards guidance:',
      input.assets.smells,
    ].join('\n\n'),
    standards: {
      kind: 'display-only',
      guidance: input.assets.smells,
    },
  }
}
