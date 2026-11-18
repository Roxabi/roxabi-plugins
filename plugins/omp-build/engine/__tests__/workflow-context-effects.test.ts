import { describe, expect, it } from 'vitest'
import {
  blockedOutsideEffectImplement,
  CONTEXT_EFFECTS_CHILD_ID,
  CONTEXT_EFFECTS_SCOPE,
  CONTEXT_EFFECTS_SESSION_ID,
  contextEffectSourceRef,
  contextEffectsObservation,
  contextEffectsToolCall,
  coveringOutsideEffectIntent,
  outsideEffectFixtureChain,
  required,
} from '../../testing/context-effects-unit-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { canonicalValueDigest } from '../canonical-value.ts'
import type { ContextEffectIntent, ContextEffectReview } from '../context-effect-review-schema.ts'
import { contextEffectSources } from '../context-effect-sources.ts'
import {
  contextSuccessionManagedBaselineSchema,
  contextSuccessionReconciliationSchema,
} from '../workflow-context-disposition-schema.ts'
import { inspectContextEffectIntent, validateContextEffectReview } from '../workflow-context-effects.ts'

describe('inspectContextEffectIntent', () => {
  it('admits report and writer call attributing the same named file', () => {
    const { negative, observed, bash, chain } = outsideEffectFixtureChain()
    const intent = coveringOutsideEffectIntent(negative, observed, bash)
    expect(intent.negatives[0]?.reportConclusion).toMatchObject({
      kind: 'local-files',
      resourceKeys: ['outside-file'],
    })
    expect(intent.negatives[0]?.calls[0]?.conclusion).toMatchObject({
      kind: 'local-files',
      resourceKeys: ['outside-file'],
    })
    expect(inspectContextEffectIntent(chain, intent).ok).toBe(true)
  })

  it('admits several writer calls attributing one named file and keeps non-writers explicit', () => {
    const fixtures = roxabiWorkflowFixtures()
    const mandate = fixtures.featureMandate(CONTEXT_EFFECTS_SCOPE, { body: 'C1: persist the region' })
    const first = contextEffectsToolCall({ toolCallId: 'bash-outside-1', toolName: 'bash', ordinal: 0 })
    const second = contextEffectsToolCall({ toolCallId: 'bash-outside-2', toolName: 'bash', ordinal: 1 })
    const read = contextEffectsToolCall({ toolCallId: 'read-1', toolName: 'read', ordinal: 2 })
    const observed = contextEffectsObservation([first, second, read])
    const negative = blockedOutsideEffectImplement(mandate, observed)
    const sources = contextEffectSources([negative])
    if (!sources.ok) throw new Error(JSON.stringify(sources.diagnostics))
    const localFiles = {
      kind: 'local-files' as const,
      resourceKeys: ['outside-file'],
      reason: 'Both Bash writes targeted the same named outside file',
    }
    const intent: ContextEffectIntent = {
      format: 'omp-build-context-effect-intent/1',
      negatives: [
        {
          source: contextEffectSourceRef(negative),
          inventory: required(sources.value.sources[0], 'multi-writer-source').inventory,
          reportConclusion: localFiles,
          calls: [
            {
              childId: observed.childId,
              sessionId: observed.sessionId,
              ordinal: first.ordinal,
              toolCallId: first.toolCallId,
              callDigest: canonicalValueDigest(first),
              conclusion: localFiles,
            },
            {
              childId: observed.childId,
              sessionId: observed.sessionId,
              ordinal: second.ordinal,
              toolCallId: second.toolCallId,
              callDigest: canonicalValueDigest(second),
              conclusion: localFiles,
            },
            {
              childId: observed.childId,
              sessionId: observed.sessionId,
              ordinal: read.ordinal,
              toolCallId: read.toolCallId,
              callDigest: canonicalValueDigest(read),
              conclusion: {
                kind: 'none-identified',
                reason: 'Non-writing conserved call; outside file attributed only on Bash writers',
              },
            },
          ],
        },
      ],
      resources: [
        {
          key: 'outside-file',
          absolutePath: '/tmp/omp-fictional-outside-effect.txt',
          basis: 'accept-named-state',
          expected: { kind: 'absent' },
        },
      ],
    }
    expect(inspectContextEffectIntent([negative], intent).ok).toBe(true)
  })

  it('refuses unresolved report or call conclusions', () => {
    const { negative, observed, bash, chain } = outsideEffectFixtureChain()
    expect(
      inspectContextEffectIntent(
        chain,
        coveringOutsideEffectIntent(negative, observed, bash, {
          report: { kind: 'unresolved', reason: 'operator deferred' },
          call: { kind: 'none-identified', reason: 'no file for this call' },
          resources: [],
        }),
      ).ok,
    ).toBe(false)
    expect(
      inspectContextEffectIntent(
        chain,
        coveringOutsideEffectIntent(negative, observed, bash, {
          report: { kind: 'none-identified', reason: 'report clear' },
          call: { kind: 'unresolved', reason: 'call deferred' },
          resources: [],
        }),
      ).ok,
    ).toBe(false)
  })

  it('refuses pending, deferred, non-Bash-completeness, and duplicate call coverage', () => {
    const fixtures = roxabiWorkflowFixtures()
    const mandate = fixtures.featureMandate(CONTEXT_EFFECTS_SCOPE, { body: 'C1: persist the region' })
    for (const completion of ['pending', 'deferred', 'ambiguous', 'unavailable'] as const) {
      const call = contextEffectsToolCall({
        toolCallId: `bash-${completion}`,
        toolName: 'bash',
        completion,
        resultDigest: completion === 'pending' ? null : 'b'.repeat(64),
        isError: completion === 'pending' ? null : false,
        exitCode: completion === 'pending' ? null : 0,
      })
      const negative = blockedOutsideEffectImplement(mandate, contextEffectsObservation([call]))
      const sources = contextEffectSources([negative])
      expect(sources.ok).toBe(true)
      if (!sources.ok) throw new Error(JSON.stringify(sources.diagnostics))
      const intent: ContextEffectIntent = {
        format: 'omp-build-context-effect-intent/1',
        negatives: [
          {
            source: contextEffectSourceRef(negative),
            inventory: required(sources.value.sources[0], `completion-${completion}-source`).inventory,
            reportConclusion: { kind: 'none-identified', reason: 'no named file' },
            calls: [
              {
                childId: CONTEXT_EFFECTS_CHILD_ID,
                sessionId: CONTEXT_EFFECTS_SESSION_ID,
                ordinal: 0,
                toolCallId: call.toolCallId,
                callDigest: canonicalValueDigest(call),
                conclusion: { kind: 'none-identified', reason: 'no named file' },
              },
            ],
          },
        ],
        resources: [],
      }
      expect(inspectContextEffectIntent([negative], intent).ok).toBe(false)
    }

    const { negative, observed, bash, chain } = outsideEffectFixtureChain()
    const good = coveringOutsideEffectIntent(negative, observed, bash)
    const goodNegative = required(good.negatives[0], 'good-negative')
    const goodCall = required(goodNegative.calls[0], 'good-call')
    const duplicate: ContextEffectIntent = {
      ...good,
      negatives: [
        {
          ...goodNegative,
          calls: [goodCall, goodCall],
        },
      ],
    }
    expect(inspectContextEffectIntent(chain, duplicate).ok).toBe(false)

    const wrongDigest = coveringOutsideEffectIntent(negative, observed, bash, { callDigest: 'c'.repeat(64) })
    expect(inspectContextEffectIntent(chain, wrongDigest).ok).toBe(false)
  })

  it('refuses undefined keys, repeated keys within one conclusion, duplicate definitions, and unreferenced resources', () => {
    const { negative, observed, bash, chain } = outsideEffectFixtureChain()
    // Report/call may share a key (many-to-one), but the key must exist on intent.resources.
    expect(
      inspectContextEffectIntent(
        chain,
        coveringOutsideEffectIntent(negative, observed, bash, {
          resources: [],
        }),
      ).ok,
    ).toBe(false)
    // Repeated keys inside a single conclusion remain invalid.
    expect(
      inspectContextEffectIntent(
        chain,
        coveringOutsideEffectIntent(negative, observed, bash, {
          report: {
            kind: 'local-files',
            resourceKeys: ['outside-file', 'outside-file'],
            reason: 'duplicate keys',
          },
          call: { kind: 'none-identified', reason: 'covered by report' },
          resources: [
            {
              key: 'outside-file',
              absolutePath: '/tmp/omp-fictional-outside-effect.txt',
              basis: 'accept-named-state',
              expected: { kind: 'absent' },
            },
          ],
        }),
      ).ok,
    ).toBe(false)
    // Duplicate resource definitions are refused even when conclusions are otherwise sound.
    expect(
      inspectContextEffectIntent(
        chain,
        coveringOutsideEffectIntent(negative, observed, bash, {
          resources: [
            {
              key: 'outside-file',
              absolutePath: '/tmp/omp-fictional-outside-effect.txt',
              basis: 'accept-named-state',
              expected: { kind: 'absent' },
            },
            {
              key: 'outside-file',
              absolutePath: '/tmp/omp-fictional-outside-effect-dup.txt',
              basis: 'accept-named-state',
              expected: { kind: 'absent' },
            },
          ],
        }),
      ).ok,
    ).toBe(false)
    // Defined resources still need at least one local-files reference.
    expect(
      inspectContextEffectIntent(
        chain,
        coveringOutsideEffectIntent(negative, observed, bash, {
          report: { kind: 'none-identified', reason: 'report clear' },
          call: { kind: 'none-identified', reason: 'call clear' },
          resources: [
            {
              key: 'outside-file',
              absolutePath: '/tmp/omp-fictional-outside-effect.txt',
              basis: 'accept-named-state',
              expected: { kind: 'absent' },
            },
          ],
        }),
      ).ok,
    ).toBe(false)
  })
})

describe('validateContextEffectReview', () => {
  it('refuses wrong named state and accepts host-verified matching absent state', () => {
    const { negative, observed, bash, chain } = outsideEffectFixtureChain()
    const intent = coveringOutsideEffectIntent(negative, observed, bash)
    const sources = contextEffectSources(chain)
    if (!sources.ok) throw new Error(JSON.stringify(sources.diagnostics))
    const namespace = {
      kind: 'confirmation-local-observer' as const,
      id: 'observer-1',
      sessionId: 'confirm-session',
      agentId: 'confirm-agent',
    }
    const matching: ContextEffectReview = {
      format: 'omp-build-context-effect-review/1',
      namespace,
      intent,
      sources: sources.value.sources,
      resources: [
        {
          key: 'outside-file',
          namespaceId: namespace.id,
          absolutePath: '/tmp/omp-fictional-outside-effect.txt',
          canonicalParent: '/tmp',
          leaf: 'omp-fictional-outside-effect.txt',
          ancestry: [
            { path: '/', identity: { device: '1', inode: '1' } },
            { path: '/tmp', identity: { device: '1', inode: '2' } },
          ],
          file: null,
          state: { kind: 'absent' },
        },
      ],
    }
    expect(validateContextEffectReview(chain, matching).ok).toBe(true)

    const matchingResource = required(matching.resources[0], 'matching-resource')
    const matchingSource = required(matching.sources[0], 'matching-source')
    const wrongState: ContextEffectReview = {
      ...matching,
      resources: [
        {
          ...matchingResource,
          file: { identity: { device: '1', inode: '9' }, modifiedNs: '1', changedNs: '1' },
          state: {
            kind: 'regular-file',
            sha256: 'd'.repeat(64),
            bytes: 12,
            mode: 0o644,
          },
        },
      ],
    }
    expect(validateContextEffectReview(chain, wrongState).ok).toBe(false)

    const wrongSources: ContextEffectReview = {
      ...matching,
      sources: [
        {
          ...matchingSource,
          inventory: { kind: 'captured', digest: 'e'.repeat(64) },
        },
      ],
    }
    expect(validateContextEffectReview(chain, wrongSources).ok).toBe(false)

    const duplicateObservations: ContextEffectReview = {
      ...matching,
      resources: [matchingResource, matchingResource],
    }
    expect(validateContextEffectReview(chain, duplicateObservations).ok).toBe(false)
  })

  it('treats unavailable inventory as no synthesized calls', () => {
    const fixtures = roxabiWorkflowFixtures()
    const mandate = fixtures.featureMandate(CONTEXT_EFFECTS_SCOPE, { body: 'C1: persist the region' })
    const negative = blockedOutsideEffectImplement(mandate)
    const sources = contextEffectSources([negative])
    expect(sources).toMatchObject({
      ok: true,
      value: { sources: [{ inventory: { kind: 'unavailable' }, observations: [] }] },
    })
    if (!sources.ok) throw new Error(JSON.stringify(sources.diagnostics))
    const intent: ContextEffectIntent = {
      format: 'omp-build-context-effect-intent/1',
      negatives: [
        {
          source: contextEffectSourceRef(negative),
          inventory: { kind: 'unavailable' },
          reportConclusion: { kind: 'none-identified', reason: 'no conserved observation inventory' },
          calls: [],
        },
      ],
      resources: [],
    }
    expect(inspectContextEffectIntent([negative], intent).ok).toBe(true)
    const unavailableNegative = required(intent.negatives[0], 'unavailable-negative')
    expect(
      inspectContextEffectIntent([negative], {
        ...intent,
        negatives: [
          {
            ...unavailableNegative,
            calls: [
              {
                childId: CONTEXT_EFFECTS_CHILD_ID,
                sessionId: CONTEXT_EFFECTS_SESSION_ID,
                ordinal: 0,
                toolCallId: 'invented',
                callDigest: 'f'.repeat(64),
                conclusion: { kind: 'none-identified', reason: 'invented' },
              },
            ],
          },
        ],
      }).ok,
    ).toBe(false)
  })
})

describe('managed baseline vs historical effectReview', () => {
  const head = '1'.repeat(40)
  const managed = {
    kind: 'unchanged-delivery-baseline' as const,
    scope: 'workflow-owned-delivery-state' as const,
    code: { repository: 'acme/app', base: head, head, referenceCommit: head },
    repository: 'acme/app',
    branch: 'feat/42-save',
    status: { code: 0 as const, stdout: '' as const },
    remote: {
      base: { ref: 'refs/heads/main', tip: head },
      candidate: { ref: 'refs/heads/feat/42-save', tip: head },
    },
    delivery: { uw: CONTEXT_EFFECTS_SCOPE, pullRequests: [], integrations: [], commits: [] },
    cuts: [{ scope: CONTEXT_EFFECTS_SCOPE, count: 0, last: null }],
    historyDigest: 'a'.repeat(64),
    bindingDigest: 'b'.repeat(64),
  }

  it('keeps cold/current managed samples free of historical effectReview', () => {
    expect(contextSuccessionManagedBaselineSchema.safeParse(managed).success).toBe(true)
    expect(
      contextSuccessionManagedBaselineSchema.safeParse({
        ...managed,
        effectReview: { format: 'omp-build-context-effect-review/1' },
      }).success,
    ).toBe(false)
  })

  it('still requires authenticated effectReview on the full succession reconciliation', () => {
    expect(contextSuccessionReconciliationSchema.safeParse(managed).success).toBe(false)
    const { negative, observed, bash, chain } = outsideEffectFixtureChain()
    const intent = coveringOutsideEffectIntent(negative, observed, bash)
    const sources = contextEffectSources(chain)
    if (!sources.ok) throw new Error(JSON.stringify(sources.diagnostics))
    const effectReview: ContextEffectReview = {
      format: 'omp-build-context-effect-review/1',
      namespace: {
        kind: 'confirmation-local-observer',
        id: 'observer-1',
        sessionId: 'confirm-session',
        agentId: 'confirm-agent',
      },
      intent,
      sources: sources.value.sources,
      resources: [
        {
          key: 'outside-file',
          namespaceId: 'observer-1',
          absolutePath: '/tmp/omp-fictional-outside-effect.txt',
          canonicalParent: '/tmp',
          leaf: 'omp-fictional-outside-effect.txt',
          ancestry: [
            { path: '/', identity: { device: '1', inode: '1' } },
            { path: '/tmp', identity: { device: '1', inode: '2' } },
          ],
          file: null,
          state: { kind: 'absent' },
        },
      ],
    }
    expect(validateContextEffectReview(chain, effectReview).ok).toBe(true)
    expect(contextSuccessionReconciliationSchema.safeParse({ ...managed, effectReview }).success).toBe(true)
  })
})
