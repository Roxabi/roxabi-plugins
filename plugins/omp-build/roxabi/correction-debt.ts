import type { CorrectionOutcome, RetainedCorrectionObligation } from './correction-policy-contract'
import {
  type CauseAdmission,
  type CorrectionCause,
  type DebtEvidence,
  debtIssueAdmitted,
  type FixFinding,
  type FixPolicy,
  isActionableReviewLabel,
  isBlockingLabel,
  isKnownReviewLabel,
} from './fix-domain'

export type DebtObligation = {
  kind: 'blocking-cause' | 'blocking-finding' | 'nonblocking-bundle' | 'retained-nonblocking' | 'retained-unknown'
  findingIds: readonly string[]
  causeIds: readonly string[]
  retentionDiagnostics: readonly string[]
  evidence: readonly DebtEvidence[]
  issueAdmitted: boolean
}

export type DebtGroupingInput = {
  policy: FixPolicy
  findings: readonly FixFinding[]
  causes: readonly CorrectionCause[]
  admissions: readonly CauseAdmission[]
  outcomes: readonly CorrectionOutcome[]
  retainedObligations: readonly RetainedCorrectionObligation[]
  evidenceFor: (input: { causeIds: readonly string[]; findingIds: readonly string[] }) => DebtEvidence
}

function malformed(admission: CauseAdmission | undefined): boolean {
  return (
    admission?.status === 'retained' &&
    admission.diagnostics.some(
      (diagnostic) =>
        diagnostic === 'seven-field-plan-incomplete' ||
        diagnostic === 'paths-invalid' ||
        diagnostic === 'members-invalid' ||
        diagnostic.startsWith('member-unknown:') ||
        diagnostic.startsWith('member-duplicate:'),
    )
  )
}

function debtAdmission(policy: FixPolicy, evidence: readonly DebtEvidence[]): boolean {
  return policy.version === 'baseline' || (evidence.length > 0 && evidence.every(debtIssueAdmitted))
}

function addDebtGroup(
  input: DebtGroupingInput,
  groups: DebtObligation[],
  kind: DebtObligation['kind'],
  causeIds: readonly string[],
  findingIds: readonly string[],
  diagnostics: readonly string[],
): void {
  const evidence = [input.evidenceFor({ causeIds, findingIds })]
  groups.push({
    kind,
    causeIds: [...causeIds],
    findingIds: [...findingIds],
    retentionDiagnostics: [...diagnostics],
    evidence,
    issueAdmitted: debtAdmission(input.policy, evidence),
  })
}

type NonblockingDebt = {
  causeIds: string[]
  findingIds: string[]
  diagnostics: string[]
  evidence: DebtEvidence[]
}

function retainMalformedCauseMembers(
  input: DebtGroupingInput,
  groups: DebtObligation[],
  handled: Set<string>,
  nonblocking: NonblockingDebt,
  blockingMembers: readonly string[],
  knownMembers: readonly string[],
  diagnostics: readonly string[],
): void {
  for (const findingId of blockingMembers) {
    addDebtGroup(input, groups, 'blocking-finding', [], [findingId], [...diagnostics, 'malformed-cause-cited-blocker'])
    handled.add(findingId)
  }
  for (const findingId of knownMembers) {
    if (blockingMembers.includes(findingId)) continue
    nonblocking.findingIds.push(findingId)
    nonblocking.diagnostics.push(...diagnostics, 'malformed-cause-cited-nonblock')
    nonblocking.evidence.push(input.evidenceFor({ causeIds: [], findingIds: [findingId] }))
    handled.add(findingId)
  }
}

function unhandledActionableMembers(
  cause: CorrectionCause,
  findingById: ReadonlyMap<string, FixFinding>,
  handled: ReadonlySet<string>,
): string[] {
  return cause.findingIds.filter((findingId) => {
    const finding = findingById.get(findingId)
    return finding !== undefined && isActionableReviewLabel(finding.label) && !handled.has(findingId)
  })
}

function causeDiagnostics(
  admission: CauseAdmission | undefined,
  planRetention: RetainedCorrectionObligation | undefined,
  result: CorrectionOutcome | undefined,
): string[] {
  return [
    ...(admission?.status === 'retained' ? admission.diagnostics : []),
    ...(planRetention?.source === 'admission' ? [] : (planRetention?.diagnostics ?? [])),
    ...(result !== undefined && result.outcome !== 'applied' ? [`correction-${result.outcome}`] : []),
  ]
}

function retainBlockingCauseDebt(
  input: DebtGroupingInput,
  findingById: ReadonlyMap<string, FixFinding>,
  groups: DebtObligation[],
  handled: Set<string>,
  nonblocking: NonblockingDebt,
  causeId: string,
  admission: CauseAdmission | undefined,
  knownMembers: readonly string[],
  diagnostics: readonly string[],
): boolean {
  const blockingMembers = knownMembers.filter((findingId) => isBlockingLabel(findingById.get(findingId)?.label ?? null))
  if (blockingMembers.length === 0) return false
  if (malformed(admission))
    retainMalformedCauseMembers(input, groups, handled, nonblocking, blockingMembers, knownMembers, diagnostics)
  else {
    addDebtGroup(input, groups, 'blocking-cause', [causeId], knownMembers, diagnostics)
    for (const findingId of knownMembers) handled.add(findingId)
  }
  return true
}

function retainNonblockingCauseDebt(
  input: DebtGroupingInput,
  nonblocking: NonblockingDebt,
  handled: Set<string>,
  causeId: string,
  knownMembers: readonly string[],
  diagnostics: readonly string[],
): void {
  nonblocking.causeIds.push(causeId)
  nonblocking.evidence.push(input.evidenceFor({ causeIds: [causeId], findingIds: knownMembers }))
  nonblocking.diagnostics.push(...diagnostics)
  for (const findingId of knownMembers) {
    nonblocking.findingIds.push(findingId)
    handled.add(findingId)
  }
}

function retainCauseDebt(
  input: DebtGroupingInput,
  findingById: ReadonlyMap<string, FixFinding>,
  admissionByCause: ReadonlyMap<string, CauseAdmission>,
  outcomeByCause: ReadonlyMap<string, CorrectionOutcome>,
  retainedByCause: ReadonlyMap<string, RetainedCorrectionObligation>,
  groups: DebtObligation[],
  handled: Set<string>,
  nonblocking: NonblockingDebt,
): void {
  for (const cause of input.causes) {
    const admission = admissionByCause.get(cause.id)
    const result = outcomeByCause.get(cause.id)
    const planRetention = retainedByCause.get(cause.id)
    const knownMembers = unhandledActionableMembers(cause, findingById, handled)
    const retained =
      admission?.status === 'retained' ||
      planRetention !== undefined ||
      (result !== undefined && result.outcome !== 'applied')
    if (!retained) {
      for (const findingId of knownMembers) handled.add(findingId)
      continue
    }
    if (knownMembers.length === 0) continue
    const diagnostics = causeDiagnostics(admission, planRetention, result)
    if (
      retainBlockingCauseDebt(
        input,
        findingById,
        groups,
        handled,
        nonblocking,
        cause.id,
        admission,
        knownMembers,
        diagnostics,
      )
    )
      continue
    retainNonblockingCauseDebt(input, nonblocking, handled, cause.id, knownMembers, diagnostics)
  }
}

function retainUnclaimedFindings(
  input: DebtGroupingInput,
  groups: DebtObligation[],
  claims: ReadonlyMap<string, number>,
  handled: Set<string>,
  nonblocking: NonblockingDebt,
): void {
  for (const finding of input.findings) {
    if (handled.has(finding.id)) continue
    if (isBlockingLabel(finding.label))
      addDebtGroup(
        input,
        groups,
        'blocking-finding',
        [],
        [finding.id],
        claims.has(finding.id) ? ['finding-membership-unresolved'] : ['finding-uncited'],
      )
    else {
      nonblocking.findingIds.push(finding.id)
      nonblocking.diagnostics.push(claims.has(finding.id) ? 'finding-membership-unresolved' : 'finding-uncited')
      nonblocking.evidence.push(input.evidenceFor({ causeIds: [], findingIds: [finding.id] }))
    }
    handled.add(finding.id)
  }
}

/** Mechanical retention only: never infer a class, repair a binding, or upgrade a label. */
export function groupCorrectionDebt(input: DebtGroupingInput): DebtObligation[] {
  const findingById = new Map(input.findings.map((finding) => [finding.id, finding]))
  const admissionByCause = new Map(input.admissions.map((admission) => [admission.cause.id, admission]))
  const outcomeByCause = new Map(input.outcomes.map((item) => [item.cause.id, item]))
  const retainedByCause = new Map(input.retainedObligations.map((item) => [item.cause.id, item]))
  const claims = new Map<string, number>()
  for (const cause of input.causes)
    for (const findingId of cause.findingIds) claims.set(findingId, (claims.get(findingId) ?? 0) + 1)

  const groups: DebtObligation[] = []
  const handled = new Set<string>()
  const nonblocking: NonblockingDebt = { causeIds: [], findingIds: [], diagnostics: [], evidence: [] }
  for (const finding of input.findings) {
    if (isKnownReviewLabel(finding.label) && isActionableReviewLabel(finding.label)) continue
    handled.add(finding.id)
    if (!isKnownReviewLabel(finding.label))
      addDebtGroup(input, groups, 'retained-unknown', [], [finding.id], ['finding-label-unknown-or-missing'])
  }
  retainCauseDebt(input, findingById, admissionByCause, outcomeByCause, retainedByCause, groups, handled, nonblocking)
  retainUnclaimedFindings(input, groups, claims, handled, nonblocking)
  if (nonblocking.findingIds.length > 0 || nonblocking.causeIds.length > 0) {
    const issueAdmitted = debtAdmission(input.policy, nonblocking.evidence)
    groups.push({
      kind: input.policy.version === 'baseline' || issueAdmitted ? 'nonblocking-bundle' : 'retained-nonblocking',
      causeIds: [...nonblocking.causeIds],
      findingIds: [...nonblocking.findingIds],
      retentionDiagnostics: [...nonblocking.diagnostics],
      evidence: nonblocking.evidence,
      issueAdmitted,
    })
  }
  return groups
}
