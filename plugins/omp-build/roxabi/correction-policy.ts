import type { Json } from '../dist/contracts.js'
import type { CorrectionExecution } from './correction-execution'
import {
  assessFalsification,
  type CauseAdmission,
  type CorrectionCause,
  type DebtEvidence,
  debtIssueAdmitted,
  type FixFinding,
  type FixPolicy,
  isActionableReviewLabel,
  isBlockingLabel,
  isKnownReviewLabel,
  orderSelectedCauses,
} from './fix-domain'

export type CorrectionOutcome = {
  cause: CorrectionCause
  /** Falsification round, never the apply retry count. */
  attempt: 1 | 2
  /** Canonical durable result enum. */
  outcome: 'applied' | 'failed' | 'reverted' | 'withdrawn'
  /** Explicit binding for lifecycle publication; every outcome was actually started. */
  execution: { causeId: string; falsificationRound: 1 | 2; attempted: true }
  /** A terminal safety failure is persisted as failed but fences the plan. */
  terminalFailure: boolean
  /** Typed terminal refusal before any actual correction effect; never persisted separately. */
  terminalDiagnostics: readonly string[] | null
  commitSHAs: string[]
  /** Original native action contributions, retained verbatim for receipt inputs. */
  sourceContributionIds: readonly string[]
  raw: Json
  applyAttempts: readonly CorrectionApplyAttempt[]
  falsification: { result: 'pass' | 'fail' | 'skipped'; raw: Json; notes: string } | null
}

export type CorrectionApplyAttempt = {
  round: 1 | 2
  attempt: 1 | 2 | 3
  result: 'applied' | 'failed' | 'terminal'
  raw: Json
  sourceContributionIds: readonly string[]
}

export type RetainedCorrectionObligation = {
  cause: CorrectionCause
  findingIds: readonly string[]
  diagnostics: readonly string[]
  source: 'admission' | 'outcome' | 'withheld'
}

export type CorrectionPlanResult = {
  ok: boolean
  outcomes: readonly CorrectionOutcome[]
  retainedObligations: readonly RetainedCorrectionObligation[]
  /** Typed pre-effect terminal reason, retained only when no prior correction effect exists. */
  terminalDiagnostics: readonly string[] | null
  terminal: boolean
}

type SelectedAdmission = Extract<CauseAdmission, { status: 'selected' }>
type AppliedAttempt = { commitSHAs: string[]; raw: Json }
type AppliedRound = { applied: AppliedAttempt; applyAttempts: CorrectionApplyAttempt[] }
type FailedRound = {
  applyAttempts: CorrectionApplyAttempt[]
  terminal: boolean
  diagnostics: string[]
  preEffectRefusal: readonly string[] | null
}

function failureRaw(diagnostics: readonly string[]): Json {
  return { diagnostics: [...diagnostics] }
}

function contributionIds(effect: unknown): string[] {
  if (effect === null || typeof effect !== 'object' || Array.isArray(effect)) return []
  const result = effect as Record<string, unknown>
  const value =
    result.ok === true && result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value)
      ? (result.value as Record<string, unknown>)
      : result
  const ids = value.contributionIds
  return Array.isArray(ids) && ids.every((id): id is string => typeof id === 'string' && id.length > 0)
    ? [...new Set(ids)]
    : []
}

function resultRaw(attempts: readonly CorrectionApplyAttempt[], extra: Record<string, Json>): Json {
  return {
    applyAttempts: attempts.map((entry) => ({
      round: entry.round,
      attempt: entry.attempt,
      result: entry.result,
      raw: entry.raw,
      sourceContributionIds: [...entry.sourceContributionIds],
    })),
    ...extra,
  }
}

function outcome(
  admission: SelectedAdmission,
  attempt: 1 | 2,
  state: CorrectionOutcome['outcome'],
  commitSHAs: readonly string[],
  applyAttempts: readonly CorrectionApplyAttempt[],
  raw: Json,
  falsification: CorrectionOutcome['falsification'],
  actionContributionIds: readonly string[] = [],
): CorrectionOutcome {
  return {
    cause: admission.cause,
    attempt,
    outcome: state,
    terminalDiagnostics: null,
    execution: { causeId: admission.cause.id, falsificationRound: attempt, attempted: true },
    terminalFailure: false,
    commitSHAs: [...commitSHAs],
    sourceContributionIds: [
      ...new Set([...applyAttempts.flatMap((entry) => entry.sourceContributionIds), ...actionContributionIds]),
    ],
    raw,
    applyAttempts: [...applyAttempts],
    falsification,
  }
}

async function applyRound(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  round: 1 | 2,
): Promise<AppliedRound | FailedRound> {
  const allowedAttempts = admission.required ? ([1, 2, 3] as const) : ([1] as const)
  const attempts: CorrectionApplyAttempt[] = []
  for (const attempt of allowedAttempts) {
    const applied = await executor.apply(admission.cause, attempt)
    if (applied.ok) {
      attempts.push({
        round,
        attempt,
        result: 'applied',
        raw: applied.value.raw,
        sourceContributionIds: contributionIds(applied),
      })
      return { applied: applied.value, applyAttempts: attempts }
    }
    const terminal = applied.kind === 'terminal'
    attempts.push({
      round,
      attempt,
      result: terminal ? 'terminal' : 'failed',
      raw: failureRaw(applied.diagnostics),
      sourceContributionIds: contributionIds(applied),
    })
    if (terminal)
      return {
        applyAttempts: attempts,
        terminal: true,
        diagnostics: applied.diagnostics,
        preEffectRefusal: applied.preEffectRefusal === undefined ? null : [...applied.preEffectRefusal],
      }
  }
  return {
    applyAttempts: attempts,
    terminal: false,
    diagnostics: [admission.required ? 'correction-apply-failed-after-3' : 'optional-apply-failed'],
    preEffectRefusal: null,
  }
}

function terminalOutcome(
  admission: SelectedAdmission,
  attempt: 1 | 2,
  commitSHAs: readonly string[],
  attempts: readonly CorrectionApplyAttempt[],
  raw: Record<string, Json>,
  falsification: CorrectionOutcome['falsification'] = null,
  actionContributionIds: readonly string[] = [],
  terminalDiagnostics: readonly string[] | null = null,
): CorrectionOutcome {
  return {
    ...outcome(
      admission,
      attempt,
      'failed',
      commitSHAs,
      attempts,
      resultRaw(attempts, {
        ...raw,
        effectsCleanup: 'unproven',
      }),
      falsification,
      actionContributionIds,
    ),
    terminalFailure: true,
    terminalDiagnostics: terminalDiagnostics === null ? null : [...terminalDiagnostics],
  }
}

async function withdrawOptional(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  applied: AppliedAttempt,
  requiredCauses: readonly CorrectionCause[],
  attempt: 1 | 2,
  attempts: readonly CorrectionApplyAttempt[],
  falsification: NonNullable<CorrectionOutcome['falsification']>,
  actionContributionIds: string[],
): Promise<CorrectionOutcome> {
  const reverted = await executor.revert(applied.commitSHAs)
  actionContributionIds.push(...contributionIds(reverted))
  if (!reverted.ok) {
    return terminalOutcome(
      admission,
      attempt,
      applied.commitSHAs,
      attempts,
      {
        apply: applied.raw,
        revert: failureRaw(reverted.diagnostics),
        reason: 'optional-withdrawal-unverified',
      },
      falsification,
      actionContributionIds,
    )
  }
  const revalidated = await executor.revalidateRequiredPaths(requiredCauses)
  actionContributionIds.push(...contributionIds(revalidated))
  if (!revalidated.ok) {
    return terminalOutcome(
      admission,
      attempt,
      applied.commitSHAs,
      attempts,
      {
        apply: applied.raw,
        revert: reverted.value,
        revalidation: failureRaw(revalidated.diagnostics),
        reason: 'required-path-revalidation-failed',
      },
      falsification,
      actionContributionIds,
    )
  }
  return outcome(
    admission,
    attempt,
    'withdrawn',
    applied.commitSHAs,
    attempts,
    resultRaw(attempts, {
      apply: applied.raw,
      revert: reverted.value,
      revalidation: revalidated.value,
    }),
    falsification,
    actionContributionIds,
  )
}

/**
 * Execute exactly the admitted correction. Apply retries (three) are independent
 * from the two falsification rounds, and every native observation is retained.
 */
export async function executeCorrection(
  admission: SelectedAdmission,
  executor: CorrectionExecution,
  requiredCauses: readonly CorrectionCause[] = [],
): Promise<CorrectionOutcome> {
  const firstRound = await applyRound(admission, executor, 1)
  if (!('applied' in firstRound)) {
    if (!admission.required && !firstRound.terminal) {
      const revalidated = await executor.revalidateRequiredPaths(requiredCauses)
      const actionContributionIds = contributionIds(revalidated)
      if (!revalidated.ok) {
        return terminalOutcome(
          admission,
          1,
          [],
          firstRound.applyAttempts,
          {
            diagnostics: firstRound.diagnostics,
            revalidation: failureRaw(revalidated.diagnostics),
            reason: 'optional-apply-failure-required-path-revalidation-failed',
          },
          null,
          actionContributionIds,
        )
      }
      return outcome(
        admission,
        1,
        'failed',
        [],
        firstRound.applyAttempts,
        resultRaw(firstRound.applyAttempts, {
          diagnostics: firstRound.diagnostics,
          revalidation: revalidated.value,
        }),
        null,
        actionContributionIds,
      )
    }
    if (firstRound.terminal) {
      return terminalOutcome(
        admission,
        1,
        [],
        firstRound.applyAttempts,
        {
          diagnostics: firstRound.diagnostics,
          reason: 'terminal-apply-effect',
        },
        null,
        [],
        firstRound.preEffectRefusal,
      )
    }
    return outcome(
      admission,
      1,
      'failed',
      [],
      firstRound.applyAttempts,
      resultRaw(firstRound.applyAttempts, { diagnostics: firstRound.diagnostics }),
      null,
    )
  }

  let round: 1 | 2 = 1
  let current = firstRound.applied
  let applyAttempts = firstRound.applyAttempts
  const falsificationAttempts: Json[] = []
  const actionContributionIds: string[] = []
  while (true) {
    if (current.commitSHAs.length !== 1) {
      const reverted = await executor.revert(current.commitSHAs)
      actionContributionIds.push(...contributionIds(reverted))
      return terminalOutcome(
        admission,
        round,
        current.commitSHAs,
        applyAttempts,
        {
          apply: current.raw,
          revert: reverted.ok ? reverted.value : failureRaw(reverted.diagnostics),
          reason: 'correction-commit-cardinality-invalid',
        },
        null,
        actionContributionIds,
      )
    }

    const proof = await executor.falsify(admission.cause, current.commitSHAs)
    actionContributionIds.push(...contributionIds(proof))
    if (!proof.ok) {
      return terminalOutcome(
        admission,
        round,
        current.commitSHAs,
        applyAttempts,
        {
          apply: current.raw,
          falsification: failureRaw(proof.diagnostics),
          reason: 'native-falsification-unusable',
        },
        null,
        actionContributionIds,
      )
    }
    const assessment = assessFalsification(proof.value.facts, proof.value.skippedReason)
    const falsification = { result: assessment.result, raw: proof.value.raw, notes: assessment.notes }
    falsificationAttempts.push({ round, result: assessment.result, notes: assessment.notes, raw: proof.value.raw })
    if (assessment.result !== 'fail') {
      return outcome(
        admission,
        round,
        'applied',
        current.commitSHAs,
        applyAttempts,
        resultRaw(applyAttempts, {
          apply: current.raw,
          falsificationAttempts,
        }),
        falsification,
        actionContributionIds,
      )
    }

    if (!admission.required)
      return withdrawOptional(
        admission,
        executor,
        current,
        requiredCauses,
        round,
        applyAttempts,
        falsification,
        actionContributionIds,
      )

    const reverted = await executor.revert(current.commitSHAs)
    actionContributionIds.push(...contributionIds(reverted))
    if (!reverted.ok) {
      return terminalOutcome(
        admission,
        round,
        current.commitSHAs,
        applyAttempts,
        {
          apply: current.raw,
          revert: failureRaw(reverted.diagnostics),
          reason: 'falsification-revert-unverified',
        },
        falsification,
        actionContributionIds,
      )
    }
    if (round === 2) {
      return outcome(
        admission,
        round,
        'reverted',
        current.commitSHAs,
        applyAttempts,
        resultRaw(applyAttempts, {
          apply: current.raw,
          revert: reverted.value,
          falsificationAttempts,
        }),
        falsification,
        actionContributionIds,
      )
    }

    round = 2
    const secondRound = await applyRound(admission, executor, round)
    applyAttempts = [...applyAttempts, ...secondRound.applyAttempts]
    if (!('applied' in secondRound)) {
      if (secondRound.terminal) {
        return terminalOutcome(
          admission,
          round,
          [],
          applyAttempts,
          {
            firstRound: { apply: current.raw, falsification, revert: reverted.value },
            diagnostics: secondRound.diagnostics,
            reason: 'terminal-retry-apply-effect',
          },
          falsification,
          actionContributionIds,
          null,
        )
      }
      return outcome(
        admission,
        round,
        'failed',
        [],
        applyAttempts,
        resultRaw(applyAttempts, {
          firstRound: { apply: current.raw, falsification, revert: reverted.value },
          diagnostics: secondRound.diagnostics,
        }),
        falsification,
        actionContributionIds,
      )
    }
    current = secondRound.applied
  }
}

function retainedFromOutcome(outcome: CorrectionOutcome): RetainedCorrectionObligation | null {
  if (outcome.outcome === 'applied') return null
  return {
    cause: outcome.cause,
    findingIds: [...outcome.cause.findingIds],
    diagnostics: [`correction-${outcome.outcome}`, ...(outcome.terminalFailure ? ['terminal-effect'] : [])],
    source: 'outcome',
  }
}

function retainWithoutAttempt(
  admission: SelectedAdmission,
  diagnostics: readonly string[],
): RetainedCorrectionObligation {
  return {
    cause: admission.cause,
    findingIds: [...admission.cause.findingIds],
    diagnostics: [...diagnostics],
    source: 'withheld',
  }
}

/** Run a whole posted plan without losing retained admissions or later safe required causes. */
export async function executeCorrectionPlan(
  admissions: readonly CauseAdmission[],
  executor: CorrectionExecution,
): Promise<CorrectionPlanResult> {
  const retained = new Map<string, RetainedCorrectionObligation>()
  for (const admission of admissions) {
    if (admission.status === 'retained') {
      retained.set(admission.cause.id, {
        cause: admission.cause,
        findingIds: [...admission.cause.findingIds],
        diagnostics: [...admission.diagnostics],
        source: 'admission',
      })
    }
  }

  const outcomes: CorrectionOutcome[] = []
  const outcomesByCause = new Map<string, CorrectionOutcome>()
  const appliedRequiredCauses: CorrectionCause[] = []
  let terminal = false
  let terminalDiagnostics: readonly string[] | null = null
  for (const admission of orderSelectedCauses(admissions)) {
    if (admission.status !== 'selected') continue
    if (terminal) {
      retained.set(admission.cause.id, retainWithoutAttempt(admission, ['prior-correction-terminal']))
      continue
    }
    if (!admission.required && typeof admission.cause.authorization === 'object') {
      const parent = outcomesByCause.get(admission.cause.authorization.optionalNeighborOf)
      if (parent?.outcome !== 'applied') {
        retained.set(admission.cause.id, retainWithoutAttempt(admission, ['optional-parent-not-applied-after-gate']))
        continue
      }
    }
    const current = await executeCorrection(admission, executor, appliedRequiredCauses)
    outcomes.push(current)
    outcomesByCause.set(current.cause.id, current)
    if (admission.required && current.outcome === 'applied') appliedRequiredCauses.push(admission.cause)
    const retainedOutcome = retainedFromOutcome(current)
    if (retainedOutcome !== null) retained.set(current.cause.id, retainedOutcome)
    if (current.terminalFailure) {
      terminal = true
      if (!outcomes.some((outcome) => outcome.outcome === 'applied' || outcome.commitSHAs.length !== 0))
        terminalDiagnostics = current.terminalDiagnostics
    }
  }
  return { ok: !terminal, outcomes, retainedObligations: [...retained.values()], terminal, terminalDiagnostics }
}

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

/**
 * Mechanical retention only: model labels, memberships, causes and admissions are
 * consumed as posted. This never infers a class, repairs a binding or upgrades a label.
 */
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
  const nonblockingFindingIds: string[] = []
  const nonblockingCauseIds: string[] = []
  const nonblockingDiagnostics: string[] = []
  const nonblockingEvidence: DebtEvidence[] = []
  const add = (
    kind: DebtObligation['kind'],
    causeIds: readonly string[],
    findingIds: readonly string[],
    diagnostics: readonly string[],
  ) => {
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

  for (const finding of input.findings) {
    if (isKnownReviewLabel(finding.label) && isActionableReviewLabel(finding.label)) continue
    handled.add(finding.id)
    if (!isKnownReviewLabel(finding.label))
      add('retained-unknown', [], [finding.id], ['finding-label-unknown-or-missing'])
  }

  for (const cause of input.causes) {
    const admission = admissionByCause.get(cause.id)
    const result = outcomeByCause.get(cause.id)
    const planRetention = retainedByCause.get(cause.id)
    const retained =
      admission?.status === 'retained' ||
      planRetention !== undefined ||
      (result !== undefined && result.outcome !== 'applied')
    const knownMembers = cause.findingIds.filter((findingId) => {
      const finding = findingById.get(findingId)
      return finding !== undefined && isActionableReviewLabel(finding.label) && !handled.has(findingId)
    })
    if (!retained) {
      for (const findingId of knownMembers) handled.add(findingId)
      continue
    }
    if (knownMembers.length === 0) continue
    const blockingMembers = knownMembers.filter((findingId) =>
      isBlockingLabel(findingById.get(findingId)?.label ?? null),
    )
    const diagnostics = [
      ...(admission?.status === 'retained' ? admission.diagnostics : []),
      ...(planRetention?.source === 'admission' ? [] : (planRetention?.diagnostics ?? [])),
      ...(result !== undefined && result.outcome !== 'applied' ? [`correction-${result.outcome}`] : []),
    ]
    if (blockingMembers.length > 0) {
      if (malformed(admission)) {
        for (const findingId of blockingMembers) {
          add('blocking-finding', [], [findingId], [...diagnostics, 'malformed-cause-cited-blocker'])
          handled.add(findingId)
        }
        for (const findingId of knownMembers) {
          if (blockingMembers.includes(findingId)) continue
          nonblockingFindingIds.push(findingId)
          nonblockingDiagnostics.push(...diagnostics, 'malformed-cause-cited-nonblock')
          nonblockingEvidence.push(input.evidenceFor({ causeIds: [], findingIds: [findingId] }))
          handled.add(findingId)
        }
      } else {
        add('blocking-cause', [cause.id], knownMembers, diagnostics)
        for (const findingId of knownMembers) handled.add(findingId)
      }
      continue
    }
    nonblockingCauseIds.push(cause.id)
    nonblockingEvidence.push(input.evidenceFor({ causeIds: [cause.id], findingIds: knownMembers }))
    nonblockingDiagnostics.push(...diagnostics)
    for (const findingId of knownMembers) {
      nonblockingFindingIds.push(findingId)
      handled.add(findingId)
    }
  }

  for (const finding of input.findings) {
    if (handled.has(finding.id)) continue
    if (isBlockingLabel(finding.label)) {
      add(
        'blocking-finding',
        [],
        [finding.id],
        claims.has(finding.id) ? ['finding-membership-unresolved'] : ['finding-uncited'],
      )
    } else {
      nonblockingFindingIds.push(finding.id)
      nonblockingDiagnostics.push(claims.has(finding.id) ? 'finding-membership-unresolved' : 'finding-uncited')
      nonblockingEvidence.push(input.evidenceFor({ causeIds: [], findingIds: [finding.id] }))
    }
    handled.add(finding.id)
  }

  if (nonblockingFindingIds.length > 0 || nonblockingCauseIds.length > 0) {
    const issueAdmitted = debtAdmission(input.policy, nonblockingEvidence)
    groups.push({
      kind: input.policy.version === 'baseline' || issueAdmitted ? 'nonblocking-bundle' : 'retained-nonblocking',
      causeIds: [...nonblockingCauseIds],
      findingIds: [...nonblockingFindingIds],
      retentionDiagnostics: [...nonblockingDiagnostics],
      evidence: nonblockingEvidence,
      issueAdmitted,
    })
  }
  return groups
}
