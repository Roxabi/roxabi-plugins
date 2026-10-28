import { describe, expect, it } from 'vitest'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import { requireLandingMandate } from '../../engine/workflow-landing-admission.ts'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import {
  BODY,
  blank,
  decisions,
  EPIC,
  facts,
  factsForMandate,
  graphConfig,
  PR,
  SCOPE,
} from './support/workflow-decision-fixtures.ts'

const {
  childSnapshot,
  epicMandate,
  featureMandate,
  fixOnlyMandate,
  historyFrom,
  mandateRef,
  pauseConfirmed,
  pauseRequested,
  workflowBinding,
} = roxabiWorkflowFixtures()

function landingInput(
  histories: DecodedHistory[],
  overrides: { digest?: string; inhibit?: 'pause' | 'abandon' | null; parentScopes?: Scope[] } = {},
) {
  const mandate =
    histories
      .flatMap((history) => history.operations)
      .map((operation) => operation.record)
      .find((record): record is MandateRecord => record?.kind === 'mandate') ?? null
  const ownSpec = mandate?.payload.ownSpec
  const current = facts(mandate)
  const uwGraph =
    ownSpec === undefined
      ? { status: 'incomplete' as const, root: SCOPE, nodes: [], observedAt: null, diagnostics: [] }
      : {
          status: 'complete' as const,
          root: ownSpec.uw,
          nodes: [
            {
              uw: ownSpec.uw,
              title: 'Fixture UW',
              raw: ownSpec.snapshot.raw,
              updatedAt: ownSpec.snapshot.raw.lastEditedAt ?? '2026-10-27T12:00:00Z',
              labels: ['size:S'],
              wayfinderLabels: [],
              parent: null,
              children: [],
              blockers: [],
              native: { state: 'OPEN' as const, stateReason: null },
            },
          ],
          observedAt: ownSpec.snapshot.raw.lastEditedAt ?? '2026-10-27T12:00:00Z',
        }
  return {
    histories,
    native: {
      branch: 'feat/42-save',
      base: 'main',
      pullRequest: PR,
      linkedIssueScopes: [SCOPE],
    },
    parentScopes: overrides.parentScopes ?? [],
    uwGraph,
    current: {
      productVersion: current.productVersion,
      configVersion: current.configVersion,
      configDigest: overrides.digest ?? current.configDigest,
      supportedConfigVersions: current.supportedConfigVersions,
      proposedSpec:
        ownSpec === undefined
          ? { ok: false as const, diagnostics: [] }
          : { ok: true as const, snapshot: ownSpec.snapshot },
      currentChildren: { ok: true as const, value: [] },
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

describe('workflow landing decisions', () => {
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
    const fix = fixOnlyMandate(SCOPE, { body: BODY, config: graphConfig('fix') })
    const review = fixOnlyMandate(SCOPE, {
      recordId: 'mandate-review',
      operationId: 'op-mandate-review',
      body: BODY,
      config: graphConfig('review'),
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

  it('admits one accounted binding with a matching authenticated UW graph and identity ledger', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const input = boundLanding(mandate)
    expect(input.parentScopes).toEqual([])
    const decision = requireLandingMandate(input)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.recordId).toBe(mandate.recordId)
    expect(decision.scope).toEqual(SCOPE)
  })

  it('refuses an incomplete graph read after the binding and accepted Spec are valid', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const input = boundLanding(mandate)
    input.uwGraph = { status: 'incomplete', root: SCOPE, nodes: [], observedAt: null, diagnostics: [] }
    expect(requireLandingMandate(input)).toMatchObject({ ok: false, reason: 'uw-not-deliverable' })
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
