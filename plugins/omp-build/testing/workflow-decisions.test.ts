import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github.ts'
import { buildRecord } from '../engine/core.ts'
import { type CanonicalRecord, type DecodedHistory, type Json, type Scope, specDigest } from '../engine/schemas.ts'
import {
  actionCompletion,
  planMacro,
  reconstructWorkflow,
  requireLandingMandate,
  selectApplicableMandate,
} from '../engine/workflow.ts'
import { configPinDigest, effectiveWorkflowConfig, WORKFLOW_CONFIG_VERSION } from '../roxabi/workflow-config.ts'
import {
  blockingPlanContribution,
  catalogueProofPin,
  childSnapshot,
  clearPlanContribution,
  epicMandate,
  featureMandate,
  fixOnlyMandate,
  historyFrom,
  hostProductVersion,
  implementStart,
  mandateRef,
  pauseConfirmed,
  pauseRequested,
  planAmendmentRecords,
  planDraftRecords,
  planReviewRecord,
  planReviewStart,
  publishedPlanDigest,
  rejectedImplementResult,
  workflowBinding,
} from './workflow-records.ts'

const SCOPE: Scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
const EPIC: Scope = { repository: 'acme/widgets', target: 'acme/widgets#1' }
const PR: Scope = { repository: 'acme/widgets', target: 'acme/widgets#20' }
const HEAD = '1111111111111111111111111111111111111111'
const BODY = '## Acceptance\n- [ ] Save keeps the selected region'

function shippedPinDigest(): string {
  return configPinDigest(effectiveWorkflowConfig(hostProductVersion(), []))
}

function blank(scope: Scope = SCOPE): DecodedHistory {
  return decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  })
}

function nodeGraph(action: 'implement' | 'stop' | 'fix' | 'review'): Json {
  return {
    version: 1,
    productVersion: hostProductVersion(),
    configVersion: WORKFLOW_CONFIG_VERSION,
    edgeOrder: 'array',
    nodes: [{ id: action, action }],
    edges: [],
    initial: action,
  }
}

function decisions(reviewStep: 'stop' | null = null, ciWatchStatus: 'green' | null = null) {
  return {
    reviewStep,
    epicStep: null,
    epicLand: null,
    ciWatchStatus,
    publish: { status: 'absent' as const, evidence: [] },
    landing: { status: 'absent' as const, evidence: [] },
    watch: { status: 'absent' as const, evidence: [] },
    proof: {
      admission: null,
      candidateGitSHA: null,
      input: null,
      applicability: 'not-applicable' as const,
      evidence: [],
    },
  }
}

function landingInput(
  histories: DecodedHistory[],
  overrides: { digest?: string; inhibit?: 'pause' | 'abandon' | null; parentScopes?: Scope[] } = {},
) {
  return {
    histories,
    native: {
      branch: 'feat/42-save',
      base: 'main',
      pullRequest: PR,
      linkedIssueScopes: [SCOPE],
    },
    parentScopes: overrides.parentScopes ?? [],
    current: {
      productVersion: hostProductVersion(),
      configVersion: WORKFLOW_CONFIG_VERSION,
      configDigest: overrides.digest ?? shippedPinDigest(),
      supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
      proofPins: [catalogueProofPin()],
      specDigest: specDigest(BODY),
      specBody: BODY,
    },
    localInhibit: overrides.inhibit ?? null,
  }
}

function expectAccounted(history: DecodedHistory): void {
  expect(history.operations.length).toBeGreaterThan(0)
  expect(history.operations.every((operation) => operation.authority === 'accounted')).toBe(true)
  expect(history.operations.some((operation) => operation.authority === 'authority')).toBe(false)
}

function boundLanding(mandate: CanonicalRecord, extra: DecodedHistory[] = [], parentScopes?: Scope[]) {
  const issue = historyFrom([mandate], 'operator', 'operator', extra)
  const binding = workflowBinding(PR, mandate, 'feat/42-save', 'main')
  const pullRequest = historyFrom([binding], 'operator', 'operator', [issue, ...extra])
  expectAccounted(issue)
  expectAccounted(pullRequest)
  return landingInput([issue, pullRequest, ...extra], { parentScopes })
}

function facts(overrides: Partial<{ sessionCwd: string | null; reviewStop: boolean }> = {}) {
  return {
    specDigest: specDigest(BODY),
    specBody: BODY,
    branch: 'feat/42-save',
    base: 'main',
    candidateGitSHA: HEAD,
    pullRequest: null,
    merged: false,
    sessionCwd: overrides.sessionCwd === undefined ? '/tmp/prepared-worktree' : overrides.sessionCwd,
    preparedWorktree: '/tmp/prepared-worktree',
    productVersion: hostProductVersion(),
    configVersion: WORKFLOW_CONFIG_VERSION,
    configDigest: shippedPinDigest(),
    supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
    proofPins: [catalogueProofPin()],
    explicitSelection: false,
    explicitResume: false,
    successorAntecedent: null,
    endObligationsMet: false,
    localInhibit: null,
  }
}

function factsForMandate(
  mandate: CanonicalRecord,
  overrides: Partial<{ sessionCwd: string | null; reviewStop: boolean }> = {},
) {
  if (mandate.kind !== 'mandate') throw new Error('expected mandate')
  return { ...facts(overrides), configDigest: mandate.payload.config.digest }
}

function shippedMandate(): CanonicalRecord {
  const effective = effectiveWorkflowConfig(hostProductVersion(), [])
  const built = buildRecord({
    version: 1,
    recordId: 'mandate-feature-1',
    runId: 'run00001',
    operationId: 'op-mandate-feature-1',
    repository: SCOPE.repository,
    target: SCOPE.target,
    kind: 'mandate',
    payload: {
      role: 'feature',
      run: null,
      children: null,
      branch: 'feat/42-save',
      base: 'main',
      lineageHead: HEAD,
      config: {
        productVersion: hostProductVersion(),
        version: WORKFLOW_CONFIG_VERSION,
        digest: configPinDigest(effective),
        effective,
      },
      proofPins: [catalogueProofPin()],
      parent: null,
      antecedent: null,
      spec: {
        reference: SCOPE.target,
        body: BODY,
        bodySha256: specDigest(BODY),
        lastEditedAt: '2026-10-21T12:00:00Z',
      },
      permissions: { landing: true, correct: true },
    },
  })
  if (!built.ok) throw new Error(built.diagnostics.map((item) => item.message).join('; '))
  return built.value
}

function shippedFacts(
  pullRequest: { scope: Scope; head: string; base: string; associatedIssue: Scope | null } | null = null,
) {
  return {
    ...facts(),
    pullRequest,
    configVersion: WORKFLOW_CONFIG_VERSION,
    configDigest: shippedPinDigest(),
    supportedConfigVersions: [WORKFLOW_CONFIG_VERSION],
  }
}

function openProof() {
  return {
    ...decisions(),
    proof: { ...decisions().proof, applicability: 'required' as const, admission: null },
  }
}

function eligiblePlan(mandate: CanonicalRecord): CanonicalRecord[] {
  const digest = publishedPlanDigest()
  return [
    mandate,
    ...planDraftRecords(mandate),
    planReviewStart(mandate, 'act-plan-1', digest),
    planReviewRecord(mandate, 'act-plan-1', digest, [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ]),
  ]
}

function admittedImplement(mandate: CanonicalRecord): CanonicalRecord {
  const result = rejectedImplementResult(mandate)
  if (result.kind !== 'action-receipt' || result.payload.phase !== 'result' || result.payload.admission === null) {
    throw new Error('expected a rejected implement result')
  }
  return { ...result, payload: { ...result.payload, admission: { ...result.payload.admission, admitted: true } } }
}

function hasAction(history: DecodedHistory, action: string): boolean {
  return history.operations.some((operation) => {
    const record = operation.record
    return record?.kind === 'action-receipt' && record.payload.action === action
  })
}

describe('workflow records are history, not a caller array', () => {
  it('does not treat a mandate object outside the history as authority', () => {
    const held = featureMandate(SCOPE, { body: BODY })
    expect(held.kind).toBe('mandate')
    expect(selectApplicableMandate(blank(), [])).toMatchObject({ status: 'refused', reason: 'missing' })
  })

  it('refuses a second unrelated mandate instead of picking either', () => {
    const first = featureMandate(SCOPE, { recordId: 'mandate-a', operationId: 'op-mandate-a' })
    const second = featureMandate(SCOPE, {
      recordId: 'mandate-b',
      operationId: 'op-mandate-b',
      branch: 'feat/42-other',
    })
    expect(selectApplicableMandate(historyFrom([first, second]))).toMatchObject({
      status: 'refused',
      reason: 'ambiguous',
    })
  })

  it('pins the mandate product version to installed package metadata', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    const mandate = featureMandate(SCOPE)
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    expect(mandate.payload.config.productVersion).toBe(pkg.version)
  })
})

describe('landing mandate', () => {
  it('treats a mandate without a PR binding as missing, not fix-only', () => {
    const mandate = fixOnlyMandate(SCOPE, { body: BODY })
    const decision = requireLandingMandate(landingInput([historyFrom([mandate]), blank(PR)]))
    expect(decision).toMatchObject({ ok: false, reason: 'missing' })
    expect(decision).not.toMatchObject({ reason: 'fix-only' })
  })

  it('refuses a fix-only mandate when the accounted PR binding names it', () => {
    const mandate = fixOnlyMandate(SCOPE, { body: BODY })
    expect(requireLandingMandate(boundLanding(mandate))).toMatchObject({ ok: false, reason: 'fix-only' })
  })

  it('does not refuse review or fix when the same mandate cannot land', () => {
    const fix = fixOnlyMandate(SCOPE, { body: BODY, graph: nodeGraph('fix') })
    const review = fixOnlyMandate(SCOPE, {
      recordId: 'mandate-review',
      operationId: 'op-mandate-review',
      body: BODY,
      graph: nodeGraph('review'),
    })
    expect(
      reconstructWorkflow({
        evidence: { issue: historyFrom([fix]), pullRequest: null, parents: [] },
        facts: factsForMandate(fix),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', action: 'fix' })
    expect(
      reconstructWorkflow({
        evidence: { issue: historyFrom([review]), pullRequest: null, parents: [] },
        facts: factsForMandate(review),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', action: 'review' })
    expect(requireLandingMandate(boundLanding(fix))).toMatchObject({ ok: false, reason: 'fix-only' })
  })

  it('does not claim paused when the local fence has no confirmed record', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    expect(requireLandingMandate({ ...boundLanding(mandate), localInhibit: 'pause' })).toMatchObject({
      ok: false,
      reason: 'unconfirmed',
    })
  })

  it('refuses when the current config digest is not the pinned digest', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const input = boundLanding(mandate)
    input.current.configDigest = 'ab'.repeat(32)
    expect(requireLandingMandate(input)).toMatchObject({ ok: false, reason: 'config-drift' })
  })

  it('admits one accounted binding and an empty parent list when the mandate has no parent', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const input = boundLanding(mandate)
    expect(input.parentScopes).toEqual([])
    const decision = requireLandingMandate(input)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.recordId).toBe(mandate.recordId)
    expect(decision.scope).toEqual(SCOPE)
    expect(decision.proofPins).toEqual([catalogueProofPin()])
  })

  it('refuses an omitted epic parent as missing, not as an empty parent list', () => {
    const child = featureMandate(SCOPE, { body: BODY })
    const epic = epicMandate(EPIC, [childSnapshot(SCOPE, BODY)])
    const decision = requireLandingMandate(boundLanding(child, [historyFrom([epic])]))
    expect(decision).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('reports a paused parent as paused, not missing', () => {
    const epic = epicMandate(EPIC, [childSnapshot(SCOPE, BODY)])
    const request = pauseRequested(epic)
    const confirmed = pauseConfirmed(epic, request)
    const child = featureMandate(SCOPE, { body: BODY, parent: mandateRef(epic) })
    const decision = requireLandingMandate(boundLanding(child, [historyFrom([epic, request, confirmed])], [EPIC]))
    expect(decision).toMatchObject({ ok: false, reason: 'paused' })
    expect(decision).not.toMatchObject({ reason: 'missing' })
  })

  it('does not permit an absent, foreign, or conflicting binding', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const other = featureMandate(SCOPE, { recordId: 'mandate-other', operationId: 'op-mandate-other' })
    const issue = historyFrom([mandate, other])
    const binding = workflowBinding(PR, mandate, 'feat/42-save', 'main')
    const foreign = historyFrom([binding], 'stranger', 'operator', [issue])
    expect(foreign.operations[0]?.authority).toBe('foreign')
    expect(requireLandingMandate(landingInput([historyFrom([mandate]), foreign]))).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    const second = workflowBinding(PR, other, 'feat/42-save', 'main')
    const conflicting = requireLandingMandate(
      landingInput([issue, historyFrom([binding, second], 'operator', 'operator', [issue])]),
    )
    expect(conflicting).toMatchObject({ ok: false, reason: 'conflict' })
    expect(conflicting.ok).toBe(false)
  })
})

describe('cold reconstruction', () => {
  it('blocks native work when the session cwd is absent', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const decision = reconstructWorkflow({
      evidence: { issue: historyFrom([mandate]), pullRequest: null, parents: [] },
      facts: facts({ sessionCwd: null }),
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'session-cwd' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('does not replay an implement start whose result is missing', () => {
    const mandate = featureMandate(SCOPE, { body: BODY, graph: nodeGraph('implement') })
    const start = implementStart(mandate)
    const decision = reconstructWorkflow({
      evidence: { issue: historyFrom([mandate, start]), pullRequest: null, parents: [] },
      facts: factsForMandate(mandate),
      decisions: decisions(),
    })
    expect(decision.status === 'action' && decision.action === 'implement').toBe(false)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })

  it('reports a confirmed pause and does not call it a review stop', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const request = pauseRequested(mandate)
    const confirmed = pauseConfirmed(mandate, request)
    const decision = reconstructWorkflow({
      evidence: { issue: historyFrom([mandate, request, confirmed]), pullRequest: null, parents: [] },
      facts: facts(),
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'paused', confirmed: true })
    expect(decision).not.toMatchObject({ status: 'terminal', reason: 'bound-stop' })
  })

  it('does not lift a review-bound stop after a later green check', () => {
    const mandate = featureMandate(SCOPE, { body: BODY, graph: nodeGraph('stop') })
    const decision = reconstructWorkflow({
      evidence: { issue: historyFrom([mandate]), pullRequest: null, parents: [] },
      facts: factsForMandate(mandate),
      decisions: decisions('stop', 'green'),
    })
    expect(decision).toMatchObject({ status: 'terminal', reason: 'bound-stop' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })
})

describe('plan and effect admission', () => {
  it('does not treat a bound draft as complete before its review', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const evidence = { issue: historyFrom([mandate, ...planDraftRecords(mandate)]), pullRequest: null, parents: [] }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('needs-review')
    expect(macro.phase).not.toBe('eligible')
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('not-started')
  })

  it('sends a blocking review back to the plan instead of confirming it', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const evidence = {
      issue: historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
      pullRequest: null,
      parents: [],
    }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('needs-amendment')
    expect(macro.blockers).toEqual([
      { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' },
    ])
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).not.toBe('confirmed')
  })

  it('confirms a clear review of the bound plan and does not open another review', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const evidence = {
      issue: historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
      pullRequest: null,
      parents: [],
    }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('eligible')
    expect(macro.amendmentActionId).toBeNull()
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('confirmed')
  })

  it('stays blocked when an amendment misses a declared blocker', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const missed = planAmendmentRecords(mandate, 'act-plan-review-1', [], [])
    const macro = planMacro(
      {
        issue: historyFrom([
          mandate,
          ...draft,
          planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
          review,
          ...missed,
        ]),
        pullRequest: null,
        parents: [],
      },
      mandate,
    )
    expect(macro.phase).toBe('blocked')
    expect(macro.phase).not.toBe('eligible')
    expect(macro.blockers).toEqual([
      { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' },
    ])
  })

  it('confirms the plan only after the amendment covers every declared blocker', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const blocker = { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' }
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const covered = planAmendmentRecords(
      mandate,
      'act-plan-review-1',
      [blocker],
      [{ blocker, stepIds: ['step-1'], reason: 'the stale-region path is now mapped' }],
    )
    const evidence = {
      issue: historyFrom([
        mandate,
        ...draft,
        planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
        review,
        ...covered,
      ]),
      pullRequest: null,
      parents: [],
    }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('eligible')
    expect(macro.amendmentActionId).toBe('act-plan-2')
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('confirmed')
  })

  it('does not treat a clear review of another plan as completion', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', 'ab'.repeat(32), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const macro = planMacro(
      {
        issue: historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', 'ab'.repeat(32)), review]),
        pullRequest: null,
        parents: [],
      },
      mandate,
    )
    expect(macro.phase).not.toBe('eligible')
    expect(macro.phase).toBe('needs-review')
  })

  it('blocks an invalid specialist slot instead of starting another review batch', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    if (
      review.kind !== 'action-receipt' ||
      review.payload.action !== 'plan-review' ||
      review.payload.phase !== 'result'
    ) {
      throw new Error('expected a plan-review result')
    }
    review.payload.contributions[1] = {
      ...review.payload.contributions[1],
      structured: { outcome: 'not-a-review' },
    }
    const evidence = {
      issue: historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
      pullRequest: null,
      parents: [],
    }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('blocked')
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(), decisions: openProof() })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'missing-contribution' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('does not dispatch another plan review when the review start has no result', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const evidence = {
      issue: historyFrom([
        mandate,
        ...planDraftRecords(mandate),
        planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
      ]),
      pullRequest: null,
      parents: [],
    }
    expect(planMacro(evidence, mandate).phase).toBe('uncertain')
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(), decisions: openProof() })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('does not replay an implement start or a rejected implement result', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const started = {
      issue: historyFrom([...eligiblePlan(mandate), implementStart(mandate)]),
      pullRequest: null,
      parents: [],
    }
    const startedDecision = reconstructWorkflow({ evidence: started, facts: shippedFacts(), decisions: openProof() })
    expect(startedDecision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    expect(startedDecision).not.toMatchObject({ status: 'action' })
    const rejected = {
      issue: historyFrom([...eligiblePlan(mandate), implementStart(mandate), rejectedImplementResult(mandate)]),
      pullRequest: null,
      parents: [],
    }
    const rejectedDecision = reconstructWorkflow({ evidence: rejected, facts: shippedFacts(), decisions: openProof() })
    expect(rejectedDecision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(rejectedDecision).not.toMatchObject({ status: 'action' })
    const pull = { scope: PR, head: HEAD, base: 'main', associatedIssue: SCOPE }
    const rejectedBound = {
      issue: rejected.issue,
      pullRequest: historyFrom([workflowBinding(PR, mandate, 'feat/42-save', 'main')], 'operator', 'operator', [
        rejected.issue,
      ]),
      parents: [],
    }
    const rejectedBoundDecision = reconstructWorkflow({
      evidence: rejectedBound,
      facts: shippedFacts(pull),
      decisions: openProof(),
    })
    expect(rejectedBoundDecision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(rejectedBoundDecision).not.toMatchObject({ status: 'action', action: 'proof' })
    expect(actionCompletion('implement', rejected, openProof(), mandate).status).not.toBe('confirmed')
  })

  it('dispatches publish, proof, review, and land from the shipped selectors without a duplicate receipt', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const pull = { scope: PR, head: HEAD, base: 'main', associatedIssue: SCOPE }
    const issue = historyFrom([...eligiblePlan(mandate), implementStart(mandate), admittedImplement(mandate)])
    const bound = historyFrom([workflowBinding(PR, mandate, 'feat/42-save', 'main')], 'operator', 'operator', [issue])
    const published = {
      issue,
      pullRequest: null,
      parents: [],
    }
    expect(hasAction(published.issue, 'publish')).toBe(false)
    expect(reconstructWorkflow({ evidence: published, facts: shippedFacts(), decisions: openProof() })).toMatchObject({
      status: 'action',
      action: 'publish',
    })
    const barePull = { issue: historyFrom([mandate]), pullRequest: blank(PR), parents: [] }
    expect(hasAction(barePull.issue, 'proof')).toBe(false)
    const bareDecision = reconstructWorkflow({ evidence: barePull, facts: shippedFacts(pull), decisions: openProof() })
    expect(bareDecision).toMatchObject({ status: 'action', action: 'plan' })
    expect(bareDecision).not.toMatchObject({ action: 'proof' })
    const proof = { issue, pullRequest: bound, parents: [] }
    expect(hasAction(proof.issue, 'proof')).toBe(false)
    expect(reconstructWorkflow({ evidence: proof, facts: shippedFacts(pull), decisions: openProof() })).toMatchObject({
      status: 'action',
      action: 'proof',
    })
    const review = { issue, pullRequest: bound, parents: [] }
    expect(hasAction(review.issue, 'review')).toBe(false)
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: shippedFacts(pull),
        decisions: { ...openProof(), reviewStep: 'review' },
      }),
    ).toMatchObject({ status: 'action', action: 'review' })
    expect(hasAction(review.issue, 'land')).toBe(false)
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: shippedFacts(pull),
        decisions: { ...openProof(), reviewStep: 'land' },
      }),
    ).toMatchObject({ status: 'action', action: 'land' })
  })

  it('advances proof from the native admission selector without a duplicate proof receipt', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const evidence = { issue: historyFrom([mandate]), pullRequest: blank(PR), parents: [] }
    const completion = actionCompletion(
      'proof',
      evidence,
      {
        ...decisions(),
        proof: {
          admission: { ok: true, candidateGitSHA: HEAD, input: 'candidate-input', recordIds: ['proof-1'] },
          candidateGitSHA: HEAD,
          input: 'candidate-input',
          applicability: 'required',
          evidence: [],
        },
      },
      mandate,
    )
    expect(completion.status).toBe('confirmed')
    expect(evidence.issue.operations.some((operation) => operation.kind === 'proof')).toBe(false)
  })
})
