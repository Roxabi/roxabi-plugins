import { expect, test } from 'vitest'
import { rawSource } from '../../adapters/github-native/uw-spec.ts'
import { runNestedDeliveryScenario } from '../../testing/nested-delivery-world.ts'
import { specReportSchema } from '../record-values.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import { scopeKey } from '../uw-graph.ts'
import { recordsOf } from '../workflow-control.ts'

test.each(['complete', 'middle-missing-coverage', 'root-missing-child-proof'] as const)(
  'delivers nested parents in order: %s',
  async (mode) => {
    const result = await runNestedDeliveryScenario(mode)
    const {
      root,
      middleScope: middle,
      leaf,
      rootMandate,
      middleMandate,
      leafMandate,
      initial,
      middle: middleRead,
      middleProof,
      leafTrace,
    } = result
    expect(initial.completions.get(scopeKey(leaf))).toMatchObject({ state: 'complete', role: 'leaf' })
    expect(initial.completions.get(scopeKey(middle))?.state).not.toBe('complete')
    expect(initial.completions.get(scopeKey(root))).toMatchObject({
      state: 'not-complete',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'dependency-held' })]),
    })
    expect(leafTrace.effective.inherited.invariants).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ kind: 'invariant', id: 'I1', spec: expect.objectContaining({ uw: middle }) }),
        statement: 'Keep the middle invariant',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ kind: 'invariant', id: 'I1', spec: expect.objectContaining({ uw: root }) }),
        statement: 'Keep the root invariant',
      }),
    ])
    expect(leafTrace.effective.inherited.exclusions).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ spec: expect.objectContaining({ uw: middle }), index: 0 }),
        statement: 'Exclude middle migration',
      }),
      expect.objectContaining({
        ref: expect.objectContaining({ spec: expect.objectContaining({ uw: root }), index: 0 }),
        statement: 'Exclude root migration',
      }),
    ])
    expect(leafTrace.plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action-receipt',
          payload: expect.objectContaining({ action: 'plan', phase: 'result' }),
        }),
        expect.objectContaining({
          kind: 'action-receipt',
          payload: expect.objectContaining({ action: 'plan-review', phase: 'result' }),
        }),
      ]),
    )
    for (const record of leafTrace.plan) {
      if (record.kind !== 'action-receipt') throw new Error('Expected plan receipt')
      expect(record.payload.inputs.manifest.spec).toEqual({ kind: 'accepted', effective: leafTrace.effective })
    }
    expect(leafTrace.start.payload.inputs.manifest.spec).toEqual({ kind: 'accepted', effective: leafTrace.effective })
    expect(leafTrace.implementation.payload.inputs.manifest.spec).toEqual({
      kind: 'accepted',
      effective: leafTrace.effective,
    })
    expect(leafTrace.reviewInputs.manifest.spec).toEqual({ kind: 'accepted', effective: leafTrace.effective })
    expect(middleProof.identity).toEqual(['C1', 'I1'])
    expect(middleProof.admission.deliverable).toMatchObject({ ok: true })
    expect(middleProof.output.code).toEqual(middleProof.integratedCode)
    expect(middleProof.reviewInputs.manifest.deliveryData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'integration', record: middleProof.ref, selector: '/payload/structured/code' }),
        expect.objectContaining({
          role: 'implementation',
          record: middleProof.ref,
          selector: '/payload/structured/criteria/0',
        }),
      ]),
    )
    if (mode === 'middle-missing-coverage') {
      expect(middleRead.completions.get(scopeKey(leaf))).toMatchObject({ state: 'complete' })
      expect(middleRead.completions.get(scopeKey(middle))).toMatchObject({
        state: 'not-complete',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'integration-coverage-not-cited' })]),
      })
      expect(middleRead.completions.get(scopeKey(root))).toMatchObject({
        state: 'not-complete',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'dependency-held' })]),
      })
      return
    }
    const { final, rootProof } = result
    if (!final || !rootProof) throw new Error('Root delivery result unavailable')
    expect(middleRead.completions.get(scopeKey(middle))).toMatchObject({
      state: 'complete',
      role: 'parent',
      code: middleProof.code,
      sources: expect.arrayContaining([middleProof.ref]),
    })
    expect(middleRead.completions.get(scopeKey(root))?.state).not.toBe('complete')
    if (mode === 'root-missing-child-proof') {
      const rootHistory = final.observation.histories.find(
        (history) => scopeKey(history.source.scope) === scopeKey(root),
      )
      if (!rootHistory) throw new Error('Root review history unavailable')
      const rows = recordsOf(rootHistory).flatMap((record) => {
        if (record.kind !== 'contribution') return []
        const report = specReportSchema.safeParse(record.payload.structured)
        return report.success ? report.data.specRows : []
      })
      const verdict = rows.find((row) => row.target.id === 'C1' && scopeKey(row.target.spec.uw) === scopeKey(root))
      if (!verdict) throw new Error('Root criterion review unavailable')
      const examined = verdict.examined[0]
      if (examined?.codeLink.method !== 'test') throw new Error('Root test evidence unavailable')
      expect(examined.evidence.receipt).toEqual(rootProof.ref)
      const refs = examined.codeLink.after.references.filter((ref) => ref.source === 'record')
      expect(refs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            record: expect.objectContaining({ kind: 'mandate', recordId: rootMandate.recordId }),
            selector: '/payload/coverage/assignments/0',
          }),
          expect.objectContaining({
            record: expect.objectContaining({ kind: 'mandate', recordId: rootMandate.recordId }),
            selector: '/payload',
          }),
        ]),
      )
      expect(rootProof.childCompletion.sources).toContainEqual({
        scope: root,
        kind: 'mandate',
        recordId: rootMandate.recordId,
      })
      expect(refs.some((ref) => ref.record.recordId === middleProof.ref.recordId)).toBe(false)
      expect(refs.some((ref) => scopeKey(ref.record.scope) === scopeKey(middle) && ref.record.kind === 'review')).toBe(
        false,
      )
      expect(final.completion.completions.get(scopeKey(middle))).toMatchObject({ state: 'complete', role: 'parent' })
      expect(final.completion.completions.get(scopeKey(leaf))).toMatchObject({ state: 'complete', role: 'leaf' })
      expect(final.completion.completions.get(scopeKey(root))).toMatchObject({
        state: 'not-complete',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'integration-coverage-not-cited' })]),
      })
      return
    }
    expect(final.completion.completions.get(scopeKey(root))).toMatchObject({
      state: 'complete',
      role: 'parent',
      code: rootProof.code,
      sources: expect.arrayContaining([rootProof.ref]),
    })
    expect(final.completion.completions.get(scopeKey(middle))).toMatchObject({
      state: 'complete',
      role: 'parent',
      code: middleProof.code,
    })
    expect(final.completion.completions.get(scopeKey(leaf))).toMatchObject({ state: 'complete', role: 'leaf' })
    const ownRef = (scope: typeof root, mandate: typeof rootMandate) => ({
      uw: scope,
      version: mandate.payload.ownSpec.version,
      sourceAccepted: { scope, kind: 'mandate', recordId: mandate.recordId },
    })
    const rootRef = ownRef(root, rootMandate),
      middleRef = ownRef(middle, middleMandate),
      leafRef = ownRef(leaf, leafMandate)
    expect(final.completion.completions.get(scopeKey(leaf))).toMatchObject({
      versionVector: [leafRef, middleRef, rootRef],
    })
    expect(final.completion.completions.get(scopeKey(middle))).toMatchObject({ versionVector: [middleRef, rootRef] })
    expect(final.completion.completions.get(scopeKey(root))).toMatchObject({ versionVector: [rootRef] })
    const rootPin = rootProof.startInputs.manifest.acceptedSources.find(
      (pin) =>
        pin.record.recordId === rootMandate.recordId &&
        pin.record.scope.target === root.target &&
        pin.record.kind === 'mandate',
    )
    expect(rootPin).toBeDefined()
    expect(rootProof.startInputs.stageSources).not.toContainEqual(rootPin)
    expect(rootProof.childCompletion.sources).toContainEqual(rootRef.sourceAccepted)
    expect(rootProof.childCompletion.versionVector).toContainEqual(rootRef)
    expect(rootProof.output.children[0]?.sources).toContainEqual(rootRef.sourceAccepted)
    expect(rootProof.output.code).toEqual(rootProof.integratedCode)
    expect(rootProof.identity).toEqual(['C1', 'I1'])
    expect(rootProof.admission.deliverable).toMatchObject({ ok: true })
    const withoutMiddle = {
      ...final.observation,
      delivery: final.observation.delivery.map((item) =>
        item.uw.target === middle.target ? { ...item, integrations: [] } : item,
      ),
    }
    const held = assessUwCompletion(withoutMiddle)
    expect(held.completions.get(scopeKey(leaf))).toMatchObject({ state: 'complete' })
    expect(held.completions.get(scopeKey(middle))).toMatchObject({
      state: 'not-complete',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'integration-result-ambiguous' })]),
    })
    expect(held.completions.get(scopeKey(root))).toMatchObject({
      state: 'not-complete',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'dependency-held' })]),
    })
    const withoutRoot = {
      ...final.observation,
      delivery: final.observation.delivery.map((item) =>
        item.uw.target === root.target ? { ...item, integrations: [] } : item,
      ),
    }
    const rootHeld = assessUwCompletion(withoutRoot)
    expect(rootHeld.completions.get(scopeKey(middle))).toMatchObject({ state: 'complete' })
    expect(rootHeld.completions.get(scopeKey(root))).toMatchObject({
      state: 'not-complete',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'integration-result-ambiguous' })]),
    })
    const changedTier = {
      ...final.observation,
      graph: {
        ...final.observation.graph,
        nodes: final.observation.graph.nodes.map((node) =>
          node.uw.target === middle.target ? { ...node, labels: ['size:F-lite'] } : node,
        ),
      },
    }
    expect(assessUwCompletion(changedTier).completions.get(scopeKey(root))).toMatchObject({
      state: 'indeterminate',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'child-tier-mismatch', message: expect.stringContaining(middle.target) }),
      ]),
    })
    const changedSource = {
      ...final.observation,
      graph: {
        ...final.observation.graph,
        nodes: final.observation.graph.nodes.map((node) =>
          node.uw.target === middle.target
            ? {
                ...node,
                raw: rawSource(
                  middle.target,
                  node.raw.body.replace('Deliver the assigned work', 'Deliver the revised work'),
                  node.raw.lastEditedAt,
                ),
              }
            : node,
        ),
      },
    }
    expect(assessUwCompletion(changedSource).completions.get(scopeKey(root))).toMatchObject({
      state: 'indeterminate',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'effective-child-engagement-mismatch',
          message: expect.stringContaining(middle.target),
        }),
      ]),
    })
  },
  60_000,
)
