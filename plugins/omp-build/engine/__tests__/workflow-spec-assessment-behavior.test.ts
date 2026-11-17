import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { canonicalJson, configPinDigest, effectiveWorkflowConfig } from '../../roxabi/workflow-config-digest.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { resolveSpecIdentityLedger } from '../uw-identity.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { resolveOwnSpecAuthority } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  nativeEvidence,
  nativeInitialBody,
  nativeMandate,
  parsedNativeSpec,
  workflowFixtures,
} from './workflow-spec-assessment-native-fixture.ts'
import { assessFixture, currentFacts, decisions, mandateAssessmentState } from './workflow-spec-assessment-support.ts'
import { facts, history, must, SCOPE } from './workflow-test-support.ts'

describe('workflow Spec assessment behavior', () => {
  test('accepts equivalent same-scope observations and refuses conflicting native history claims', () => {
    const mandate = nativeMandate()
    const original = history([mandate])
    const independentlyDecoded = decodeHistory(original.source)
    const unique = resolveAcceptedSpec(mandate, [original])
    expect(unique).toMatchObject({ ok: true })
    expect(independentlyDecoded).not.toBe(original)
    expect(resolveAcceptedSpec(mandate, [original, independentlyDecoded])).toEqual(unique)
    expect(resolveAcceptedSpec(mandate, [original, original])).toEqual(unique)

    const variants = [
      decodeHistory({
        ...original.source,
        comments: original.source.comments.map((comment, index) =>
          index === 0 ? { ...comment, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' } : comment,
        ),
      }),
      decodeHistory({ ...original.source, stopAuthor: 'different-stop-author' }),
      decodeHistory({ ...original.source, complete: false }),
      decodeHistory({ ...original.source, diagnostics: [{ code: 'incomplete', message: 'Page unavailable' }] }),
    ]
    for (const conflicting of variants) {
      const refusal = {
        ok: false,
        reason: 'incomplete',
        evidence: [{ code: 'ambiguous', message: 'Conflicting histories claim the same scope' }],
      }
      expect(resolveAcceptedSpec(mandate, [original, conflicting])).toMatchObject(refusal)
      expect(resolveAcceptedSpec(mandate, [original, independentlyDecoded, conflicting])).toMatchObject(refusal)
    }
  })

  test('allows only an authenticated current assessment replay without weakening other starts', async () => {
    const mandated = nativeMandate()
    const initial = mandateAssessmentState(mandated)
    const proposed = {
      snapshot: initial.snapshot,
      tier: initial.tier,
      children: initial.children,
      inheritedOwnSpecRefs: initial.inheritedOwnSpecRefs,
      coverage: initial.coverage,
    }
    const assessment = assessFixture(mandated, 'replay', initial, proposed, 'editorial', [history([mandated])])
    const start = assessment.start
    if (start.kind !== 'action-receipt' || start.payload.action !== 'assess-spec' || start.payload.phase !== 'start')
      throw new Error('expected assessment start')
    const context = {
      uw: SCOPE,
      actionId: start.payload.actionId,
      fingerprint: start.payload.inputs.fingerprint,
      start: { scope: SCOPE, kind: 'action-receipt' as const, recordId: start.recordId },
    }
    const issue = history([mandated, start])
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({ ok: false, reason: 'incomplete' })
    expect(resolveAcceptedSpec(mandated, [issue], context)).toMatchObject({ ok: true })
    const resolved = resolveAcceptedSpec(mandated, [issue], context)
    if (!resolved.ok) throw new Error('expected authenticated replay')
    const ledger = { uw: SCOPE, history: issue, histories: [issue], accepted: resolved.spec }
    expect(resolveSpecIdentityLedger(ledger)).toMatchObject({ ok: false })
    expect(resolveSpecIdentityLedger({ ...ledger, assessmentReplay: context })).toMatchObject({ ok: true })
    expect(resolveSpecIdentityLedger({ ...ledger, assessmentReplay: { ...context, actionId: 'other' } })).toMatchObject(
      { ok: false },
    )
    const historical = must(parseRecord({ ...mandated, recordId: 'historical-mandate', operationId: 'historical-op' }))
    const abandonHistorical = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-historical',
        runId: 'run-1',
        operationId: 'abandon-historical-op',
        kind: 'operator-control',
        payload: {
          control: 'abandon',
          controlId: 'abandon-historical',
          mandate: { scope: SCOPE, kind: 'mandate', recordId: historical.recordId },
          predecessor: null,
        },
      }),
    )
    const foreignStart = {
      ...start,
      recordId: 'foreign-start',
      operationId: 'foreign-op',
      payload: { ...start.payload, mandate: { ...start.payload.mandate, recordId: historical.recordId } },
    }
    const combined = history([historical, abandonHistorical, mandated, start, foreignStart])
    const foreignParts = new Set(
      combined.operations.find((entry) => entry.recordId === foreignStart.recordId)?.parts.map((part) => part.nativeId),
    )
    const withForeign = decodeHistory({
      ...combined.source,
      comments: combined.source.comments.map((comment) =>
        foreignParts.has(comment.nativeId) ? { ...comment, author: 'stranger' } : comment,
      ),
    })
    expect(
      resolveSpecIdentityLedger({
        uw: SCOPE,
        history: withForeign,
        histories: [withForeign],
        accepted: resolved.spec,
        assessmentReplay: context,
      }),
    ).toMatchObject({ ok: true })
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: nativeInitialBody,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [issue],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    expect(resolveOwnSpecAuthority(issue, [], causal)).toMatchObject({ ok: false })
    expect(resolveOwnSpecAuthority(issue, [], causal, new Set(), context)).toMatchObject({ ok: true })
    expect(resolveAcceptedSpec(mandated, [issue], { ...context, actionId: 'other' })).toMatchObject({ ok: false })
    expect(resolveAcceptedSpec(mandated, [issue], { ...context, fingerprint: '0'.repeat(64) })).toMatchObject({
      ok: false,
    })

    const duplicate = must(parseRecord({ ...start, recordId: 'duplicate-start', operationId: 'duplicate-start-op' }))
    expect(resolveAcceptedSpec(mandated, [history([mandated, start, duplicate])], context)).toMatchObject({ ok: false })
    const other = assessFixture(mandated, 'another-pending', initial, proposed, 'editorial', [history([mandated])])
    expect(resolveAcceptedSpec(mandated, [history([mandated, start, other.start])], context)).toMatchObject({
      ok: false,
    })
    const conflicting = must(
      buildRecord({
        ...assessment.result,
        payload: {
          ...assessment.result.payload,
          start: { ...assessment.result.payload.start, recordId: 'other-start' },
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, start, conflicting])], context)).toMatchObject({
      ok: false,
    })

    const operation = issue.operations.find((entry) => entry.recordId === start.recordId)
    if (operation === undefined) throw new Error('missing start operation')
    const altered = (changes: Partial<typeof operation>) => ({
      ...issue,
      operations: issue.operations.map((entry) => (entry === operation ? { ...entry, ...changes } : entry)),
    })
    expect(resolveAcceptedSpec(mandated, [altered({ authority: 'authority' })], context)).toMatchObject({ ok: false })
    expect(resolveAcceptedSpec(mandated, [altered({ authority: 'foreign' })], context)).toMatchObject({ ok: false })
    expect(
      resolveAcceptedSpec(
        mandated,
        [
          altered({
            parts: operation.parts.map((part) => ({ ...part, author: 'other' })),
          }),
        ],
        context,
      ),
    ).toMatchObject({ ok: false })
    expect(resolveAcceptedSpec(mandated, [altered({ parts: [] })], context)).toMatchObject({ ok: false })
    expect(
      resolveAcceptedSpec(
        mandated,
        [
          altered({
            parts: operation.parts.map((part) => ({ ...part, nativeId: null })),
          }),
        ],
        context,
      ),
    ).toMatchObject({ ok: false })
    expect(
      resolveAcceptedSpec(
        mandated,
        [
          altered({
            parts: operation.parts.map((part) => ({ ...part, updatedAt: '2025-01-01T00:00:01Z' })),
          }),
        ],
        context,
      ),
    ).toMatchObject({ ok: false })
    const invalidInputs = { ...start.payload.inputs, fingerprint: '0'.repeat(64) }
    const invalidStart = { ...start, payload: { ...start.payload, inputs: invalidInputs } }
    expect(
      resolveAcceptedSpec(mandated, [history([mandated, invalidStart])], {
        ...context,
        fingerprint: invalidInputs.fingerprint,
      }),
    ).toMatchObject({ ok: false })
  })

  test('does not dispatch assessment when a pinned graph reaches it without current Spec facts', async () => {
    const baseline = nativeMandate()
    const graph = {
      version: 1,
      productVersion: baseline.payload.config.productVersion,
      configVersion: baseline.payload.config.version,
      edgeOrder: 'array' as const,
      nodes: [{ id: 'assess-spec', action: 'assess-spec' as const }],
      edges: [],
      initial: 'assess-spec',
    }
    const mandated = workflowFixtures.featureMandate(SCOPE, {
      body: nativeInitialBody,
      ownSpec: workflowFixtures.ownSpecFromSnapshot(SCOPE, parsedNativeSpec(nativeInitialBody)),
      config: {
        version: baseline.payload.config.version,
        digest: baseline.payload.config.digest,
        effective: { graph },
      },
    })
    const decision = reconstructWorkflow({
      evidence: await nativeEvidence(history([mandated]), nativeInitialBody, 'S'),
      facts: facts({
        productVersion: mandated.payload.config.productVersion,
        configVersion: mandated.payload.config.version,
        configDigest: mandated.payload.config.digest,
        supportedConfigVersions: [mandated.payload.config.version],
      }),
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'unknown-outcome' })
    expect(decision).not.toMatchObject({ status: 'action', action: 'assess-spec' })
  })

  test('recovers only the selected assessment negative with newly pinned context', async () => {
    const mandated = nativeMandate()
    const accepted = mandateAssessmentState(mandated)
    const proposed = {
      snapshot: accepted.snapshot,
      tier: 'F-lite' as const,
      children: accepted.children,
      inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
      coverage: accepted.coverage,
    }
    const assessment = assessFixture(mandated, 'assessment-context', accepted, proposed, 'editorial', [
      history([mandated]),
    ])
    if (
      assessment.start.kind !== 'action-receipt' ||
      assessment.start.payload.action !== 'assess-spec' ||
      assessment.start.payload.phase !== 'start'
    )
      throw new Error('expected assessment start')
    const { inputs: _recordInputs, ...negativeDraft } = assessment.result
    const negative = must(
      buildRecord({
        ...negativeDraft,
        payload: {
          ...assessment.result.payload,
          structured: {
            outcome: 'missing-context',
            missing: [
              { locator: { kind: 'information-request', description: 'Policy' }, reason: 'Not available', targets: [] },
            ],
          },
        },
      }),
    )
    if (negative.kind !== 'action-receipt' || negative.payload.phase !== 'result') throw new Error('expected result')
    const issue = history([mandated, assessment.start, negative])
    const evidence = await nativeEvidence(issue, nativeInitialBody, 'F-lite')
    const original = assessment.start.payload.inputs
    const negativeRef = {
      source: 'record' as const,
      record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: negative.recordId },
      selector: '/payload',
      digest: canonicalValueDigest(negative.payload),
    }
    const added = {
      source: 'git-file' as const,
      repository: SCOPE.repository,
      commit: 'b'.repeat(40),
      path: 'policy.txt',
      digest: 'a'.repeat(64),
    }
    const manifest = { ...original.manifest, expandedContext: [negativeRef, added] }
    const inputs = { ...original, manifest, fingerprint: actionInputDigest(manifest) }
    const baseFacts = currentFacts(mandated, assessment.proposed)
    const base = { evidence, facts: baseFacts, decisions: decisions() }
    expect(reconstructWorkflow(base)).toMatchObject({
      status: 'terminal',
      reason: 'spec-ambiguous',
      evidence: expect.arrayContaining([
        { code: 'action-context-missing', message: 'Spec assessment requires authenticated expanded context' },
      ]),
    })
    const recovery = { negative: negativeRef.record, actionId: 'fresh-assessment', inputs }
    expect(reconstructWorkflow({ ...base, facts: { ...baseFacts, contextRecovery: recovery } })).toMatchObject({
      status: 'action',
      action: 'assess-spec',
    })
    expect(
      reconstructWorkflow({ ...base, facts: { ...baseFacts, contextRecovery: { ...recovery, inputs: original } } }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })
    const lineageOnlyManifest = { ...original.manifest, expandedContext: [negativeRef] }
    const lineageOnlyInputs = {
      ...original,
      manifest: lineageOnlyManifest,
      fingerprint: actionInputDigest(lineageOnlyManifest),
    }
    expect(
      reconstructWorkflow({
        ...base,
        facts: { ...baseFacts, contextRecovery: { ...recovery, inputs: lineageOnlyInputs } },
      }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })

    const foreignRecovery = {
      ...recovery,
      negative: { ...recovery.negative, scope: { ...SCOPE, target: 'acme/app#999' } },
    }
    expect(
      reconstructWorkflow({ ...base, facts: { ...baseFacts, contextRecovery: foreignRecovery } }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })

    const negativeParts = new Set(
      issue.operations
        .find((operation) => operation.recordId === negative.recordId)
        ?.parts.map((part) => part.nativeId),
    )
    const foreignIssue = decodeHistory({
      ...issue.source,
      comments: issue.source.comments.map((comment) =>
        negativeParts.has(comment.nativeId) ? { ...comment, author: 'foreign' } : comment,
      ),
    })
    expect(
      reconstructWorkflow({
        ...base,
        evidence: await nativeEvidence(foreignIssue, nativeInitialBody, 'F-lite'),
        facts: { ...baseFacts, contextRecovery: recovery },
      }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })

    const competing = must(
      buildRecord({ ...negative, recordId: 'competing-negative', operationId: 'competing-negative-op' }),
    )
    const competingIssue = history([mandated, assessment.start, negative, competing])
    expect(
      reconstructWorkflow({
        ...base,
        evidence: await nativeEvidence(competingIssue, nativeInitialBody, 'F-lite'),
        facts: { ...baseFacts, contextRecovery: recovery },
      }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })

    expect(
      reconstructWorkflow({
        ...base,
        facts: { ...baseFacts, productVersion: 'different-product-version', contextRecovery: recovery },
      }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })
    expect(
      reconstructWorkflow({
        ...base,
        facts: { ...baseFacts, configVersion: 'different-config-version', contextRecovery: recovery },
      }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })
    expect(
      reconstructWorkflow({
        ...base,
        facts: { ...baseFacts, configDigest: '0'.repeat(64), contextRecovery: recovery },
      }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })
    const currentConfig = effectiveWorkflowConfig(baseFacts.productVersion, [])
    const changedVersion = 'omp-build-workflow/recovery-drift'
    const changedGraph = { ...currentConfig.graph, configVersion: changedVersion }
    const changedEffective = {
      ...currentConfig,
      compatibility: changedVersion,
      graph: changedGraph,
      graphDigest: createHash('sha256')
        .update(
          canonicalJson({
            version: changedVersion,
            nodes: changedGraph.nodes,
            edges: changedGraph.edges,
          }),
        )
        .digest('hex'),
    }
    expect(
      reconstructWorkflow({
        ...base,
        facts: {
          ...baseFacts,
          configVersion: changedVersion,
          configDigest: configPinDigest(changedEffective),
          supportedConfigVersions: [mandated.payload.config.version, changedVersion],
          contextRecovery: recovery,
        },
      }),
    ).toMatchObject({ status: 'blocked', reason: 'config-drift' })
    const changedSpec = {
      ...assessment.proposed,
      snapshot: {
        ...assessment.proposed.snapshot,
        spec: { ...assessment.proposed.snapshot.spec, version: '0'.repeat(64) },
      },
    }
    expect(
      reconstructWorkflow({
        ...base,
        facts: { ...baseFacts, currentSpec: changedSpec, contextRecovery: recovery },
      }),
    ).not.toMatchObject({ status: 'action', action: 'assess-spec' })
  })
})
