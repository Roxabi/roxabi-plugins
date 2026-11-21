import { describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { readUwCompletionObservation } from '../../adapters/github-workflow/uw-observation.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import { requireLandingMandate } from '../../engine/workflow-landing-admission.ts'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import {
  type FixtureNativeWorld,
  fixtureReviewClassCatalogues,
  observeFixtureNativeWorld,
} from '../action-input-fixtures.ts'
import { readDeclaredNativeWorld } from '../declared-native-observation.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import {
  blank,
  decisions,
  EPIC,
  facts,
  factsForMandate,
  graphConfig,
  PR,
  SCOPE,
} from './support/workflow-decision-fixtures.ts'

const workflow = roxabiWorkflowFixtures()
const {
  epicMandate,
  featureMandate,
  fixOnlyMandate,
  historyFrom,
  mandateRef,
  pauseConfirmed,
  pauseRequested,
  workflowBinding,
} = workflow

const body = strictSpecBody('Save keeps the selected region')
const editedAt = '2026-10-21T12:00:00Z'
const parsed = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, body, editedAt) })
if (parsed.status !== 'conformant') throw new Error('Expected conformant native Spec')
const nativeSnapshot = parsed.snapshot
const ownSpec = workflow.ownSpecFromSnapshot(SCOPE, parsed.snapshot)
const parsedParent = parseIssueSpecBody({ uw: EPIC, raw: rawSource(EPIC.target, body, editedAt) })
if (parsedParent.status !== 'conformant') throw new Error('Expected conformant native parent Spec')
const parentOwnSpec = workflow.ownSpecFromSnapshot(EPIC, parsedParent.snapshot)
const childCommitment = {
  scope: SCOPE,
  snapshot: parsed.snapshot,
  specVersion: parsed.snapshot.spec.version,
  tier: 'S' as const,
}
const rootNode = {
  scope: SCOPE,
  title: 'Save the selected region',
  body,
  updatedAt: editedAt,
  labels: ['size:S'],
  parent: null,
  children: [],
  blockers: [],
  state: 'OPEN' as const,
  stateReason: null,
}
const parentNodes: FixtureNativeWorld['nodes'] = [
  { ...rootNode, parent: EPIC },
  {
    scope: EPIC,
    title: 'Parent epic',
    body,
    updatedAt: editedAt,
    labels: ['size:S'],
    parent: null,
    children: [SCOPE],
    blockers: [],
    state: 'OPEN',
    stateReason: null,
  },
]
const nativePulls: FixtureNativeWorld['pullRequests'] = [
  {
    scope: PR,
    branch: 'feat/42-save',
    base: 'main',
    head: '1'.repeat(40),
    baseTip: 'b'.repeat(40),
    state: 'OPEN',
    mergeCommit: null,
    author: 'operator',
  },
]

async function landingInput(
  histories: DecodedHistory[],
  mandate: MandateRecord | null,
  nodes: FixtureNativeWorld['nodes'],
  parentScopes: Scope[],
) {
  const current = facts(mandate)
  const observation = await readDeclaredNativeWorld(
    {
      root: SCOPE,
      nodes,
      histories,
      pullRequests: nativePulls,
      commits: [],
      comparisons: [
        { repository: SCOPE.repository, base: 'b'.repeat(40), head: 'b'.repeat(40), status: 'identical', commits: [] },
      ],
    },
    fixtureReviewClassCatalogues,
  )
  return {
    histories: observation.histories,
    authorityHistories: observation.histories,
    catalogues: observation.catalogues,
    observation,
    native: { branch: 'feat/42-save', base: 'main', pullRequest: PR, linkedIssueScopes: [SCOPE] },
    parentScopes,
    uwGraph: observation.graph,
    current: {
      productVersion: current.productVersion,
      configVersion: current.configVersion,
      configDigest: current.configDigest,
      supportedConfigVersions: current.supportedConfigVersions,
      proposedSpec: { ok: true as const, snapshot: nativeSnapshot },
      currentChildren: { ok: true as const, value: [] },
    },
    localInhibit: null,
  }
}

async function decisionEvidence(issue: DecodedHistory) {
  const causal = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [rootNode],
    histories: [issue],
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
  return { issue, pullRequest: null, parents: [], causal }
}

function expectAccounted(history: DecodedHistory): void {
  expect(history.operations.length).toBeGreaterThan(0)
  expect(history.operations.every((operation) => operation.authority === 'accounted')).toBe(true)
  expect(history.operations.some((operation) => operation.authority === 'authority')).toBe(false)
}

function boundLanding(
  mandate: MandateRecord,
  nodes: FixtureNativeWorld['nodes'],
  extra: DecodedHistory[],
  parentScopes: Scope[],
) {
  const issue = historyFrom([mandate], 'operator', 'operator', extra)
  const binding = workflowBinding(PR, mandate, 'feat/42-save', 'main')
  const pullRequest = historyFrom([binding], 'operator', 'operator', [issue, ...extra])
  expectAccounted(issue)
  expectAccounted(pullRequest)
  return landingInput([issue, pullRequest, ...extra], mandate, nodes, parentScopes)
}

describe('workflow landing decisions', () => {
  it('treats a mandate without a PR binding as missing, not fix-only', async () => {
    const mandate = fixOnlyMandate(SCOPE, { body, ownSpec, branch: 'feat/42-save' })
    const decision = requireLandingMandate(
      await landingInput([historyFrom([mandate]), blank(PR)], mandate, [rootNode], []),
    )
    expect(decision).toMatchObject({ ok: false, reason: 'missing' })
    expect(decision).not.toMatchObject({ reason: 'fix-only' })
  })

  it('refuses a fix-only mandate when the accounted PR binding names it', async () => {
    const mandate = fixOnlyMandate(SCOPE, { body, ownSpec, branch: 'feat/42-save' })
    expect(requireLandingMandate(await boundLanding(mandate, [rootNode], [], []))).toMatchObject({
      ok: false,
      reason: 'fix-only',
    })
  })

  it('does not refuse review or fix when the same mandate cannot land', async () => {
    const fix = fixOnlyMandate(SCOPE, { body, ownSpec, branch: 'feat/42-save', config: graphConfig('fix') })
    const review = fixOnlyMandate(SCOPE, {
      recordId: 'mandate-review',
      operationId: 'op-mandate-review',
      body,
      branch: 'feat/42-save',
      ownSpec,
      config: graphConfig('review'),
    })
    expect(
      reconstructWorkflow({
        evidence: await decisionEvidence(historyFrom([fix])),
        facts: factsForMandate(fix),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', action: 'fix' })
    expect(
      reconstructWorkflow({
        evidence: await decisionEvidence(historyFrom([review])),
        facts: factsForMandate(review),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', action: 'review' })
    expect(requireLandingMandate(await boundLanding(fix, [rootNode], [], []))).toMatchObject({
      ok: false,
      reason: 'fix-only',
    })
  })

  it('does not claim paused when the local fence has no confirmed record', async () => {
    const mandate = featureMandate(SCOPE, { body, ownSpec })
    expect(
      requireLandingMandate({ ...(await boundLanding(mandate, [rootNode], [], [])), localInhibit: 'pause' }),
    ).toMatchObject({
      ok: false,
      reason: 'unconfirmed',
    })
  })

  it('refuses when the current config digest is not the pinned digest', async () => {
    const mandate = featureMandate(SCOPE, { body, ownSpec })
    const input = await boundLanding(mandate, [rootNode], [], [])
    input.current.configDigest = 'ab'.repeat(32)
    expect(requireLandingMandate(input)).toMatchObject({ ok: false, reason: 'config-drift' })
  })

  it('admits one accounted binding with a matching authenticated UW graph and identity ledger', async () => {
    const mandate = featureMandate(SCOPE, { body, ownSpec })
    const input = await boundLanding(mandate, [rootNode], [], [])
    expect(input.parentScopes).toEqual([])
    const decision = requireLandingMandate(input)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.recordId).toBe(mandate.recordId)
    expect(decision.scope).toEqual(SCOPE)
  })

  it('refuses an incomplete graph read after the binding and accepted Spec are valid', async () => {
    const mandate = featureMandate(SCOPE, { body, ownSpec })
    const input = await boundLanding(mandate, [rootNode], [], [])
    const observation = await readUwCompletionObservation(
      SCOPE,
      {
        cwd: '/fixture',
        readAuthor: 'operator',
        gh: async () => {
          throw new Error('Native graph is unavailable')
        },
      },
      async () => fixtureReviewClassCatalogues(),
      [SCOPE],
      input.histories,
    )
    expect(observation.status).toBe('incomplete')
    expect(requireLandingMandate({ ...input, observation, uwGraph: observation.graph })).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
  })

  it('refuses an omitted epic parent as missing, not as an empty parent list', async () => {
    const child = featureMandate(SCOPE, { body, ownSpec })
    const epic = epicMandate(EPIC, [childCommitment], { body, ownSpec: parentOwnSpec })
    const decision = requireLandingMandate(await boundLanding(child, parentNodes, [historyFrom([epic])], []))
    expect(decision).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('reports a paused parent as paused, not missing', async () => {
    const epic = epicMandate(EPIC, [childCommitment], { body, ownSpec: parentOwnSpec })
    const request = pauseRequested(epic)
    const confirmed = pauseConfirmed(epic, request)
    const child = featureMandate(SCOPE, {
      body,
      ownSpec,
      parent: mandateRef(epic),
      inheritedOwnSpecRefs: [
        {
          uw: EPIC,
          version: epic.payload.ownSpec.version,
          sourceAccepted: { scope: EPIC, recordId: epic.recordId, kind: 'mandate' },
        },
      ],
    })
    const decision = requireLandingMandate(
      await boundLanding(child, parentNodes, [historyFrom([epic, request, confirmed])], [EPIC]),
    )
    expect(decision).toMatchObject({ ok: false, reason: 'paused' })
    expect(decision).not.toMatchObject({ reason: 'missing' })
  })

  it('does not permit an absent, foreign, or conflicting binding', async () => {
    const mandate = featureMandate(SCOPE, { body, ownSpec })
    const other = featureMandate(SCOPE, { body, ownSpec, recordId: 'mandate-other', operationId: 'op-mandate-other' })
    const issue = historyFrom([mandate, other])
    const binding = workflowBinding(PR, mandate, 'feat/42-save', 'main')
    const foreign = historyFrom([binding], 'stranger', 'operator', [issue])
    expect(foreign.operations[0]?.authority).toBe('foreign')
    const foreignInput = await landingInput([historyFrom([mandate]), foreign], mandate, [rootNode], [])
    expect(foreignInput.observation.status).toBe('incomplete')
    if (foreignInput.observation.status !== 'incomplete') throw new Error('Expected foreign binding refusal')
    expect(foreignInput.observation.diagnostics).toContainEqual(expect.objectContaining({ code: 'foreign' }))
    expect(requireLandingMandate(foreignInput)).toMatchObject({ ok: false, reason: 'incomplete' })
    const second = workflowBinding(PR, other, 'feat/42-save', 'main')
    const conflictingInput = await landingInput(
      [issue, historyFrom([binding, second], 'operator', 'operator', [issue])],
      mandate,
      [rootNode],
      [],
    )
    expect(conflictingInput.observation.status).toBe('complete')
    const conflictingDecision = requireLandingMandate(conflictingInput)
    expect(conflictingDecision).toMatchObject({ ok: false, reason: 'conflict' })
    if (conflictingDecision.ok) throw new Error('Expected conflicting binding refusal')
    expect(conflictingDecision.evidence).toContainEqual(expect.objectContaining({ code: 'conflicting' }))
  })
})
