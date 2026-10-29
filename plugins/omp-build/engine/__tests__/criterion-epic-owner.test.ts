import { describe, expect, test } from 'vitest'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { criterionEpicReviewGraph } from '../../testing/criterion-range-approval.ts'
import { reviewRoot } from '../../testing/record-builders.ts'
import { shippedMandate } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { selectedDeclarations } from '../criterion-decision-selection.ts'
import { validateProspectiveRecord } from '../history-graph.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { Diagnostic } from '../record-values.ts'
import { reviewCandidateCode } from '../review-inventory-input.ts'
import { mandateScope } from '../workflow-control.ts'
import { history } from './workflow-test-support.ts'

function epicFixture() {
  const mandate = shippedMandate()
  const base = acceptedActionInputs(mandate, 'review')
  const head = base.manifest.code.head
  const scope = mandateScope(mandate)
  const pin = {
    source: 'record' as const,
    record: { scope, kind: 'mandate' as const, recordId: mandate.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(mandate.payload),
  }
  const manifest = {
    ...base.manifest,
    code: { ...base.manifest.code, repository: scope.repository },
    acceptedSources: [pin],
  }
  const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  const graph = criterionEpicReviewGraph({ mandate, inputs, head, range: `${base.manifest.code.base}..${head}` })
  const observed = history([...graph.issueRecords, ...graph.records], scope)
  if (graph.decision.payload.judgment.purpose !== 'review') throw new Error('Expected epic review')
  return { mandate, pin, graph, observed, judgment: graph.decision.payload.judgment }
}

function selection(inputs: ActionInputs, observed: DecodedHistory) {
  const diagnostics: Diagnostic[] = []
  const selected = selectedDeclarations([observed], inputs, diagnostics)
  return { selected, diagnostics }
}

describe('epic review owner admission', () => {
  test('admits current criterion evidence for an authenticated UW-range review', () => {
    const fixture = epicFixture()
    const { selected, diagnostics } = selection(fixture.graph.inputs, fixture.observed)
    expect(validateProspectiveRecord(fixture.graph.root, history([], mandateScope(fixture.mandate)))).toEqual([])
    expect(diagnostics).toEqual([])
    expect(selected.declarations).toHaveLength(1)
    expect(selected.evidence).toHaveLength(1)
    expect(reviewCandidateCode(fixture.judgment, fixture.observed)).toEqual({
      repository: fixture.mandate.repository,
      commit: fixture.graph.inputs.manifest.code.head,
    })
    const pull = {
      ...fixture.observed,
      source: {
        ...fixture.observed.source,
        scope: { repository: fixture.mandate.repository, target: 'acme/widgets#99' },
      },
    }
    expect(reviewCandidateCode(fixture.judgment, pull)).toBeNull()
  })

  test('refuses a PR inventory or wrong range even when its history shares the UW scope', () => {
    const fixture = epicFixture()
    const { graph, mandate, judgment } = fixture
    const rootFor = (subject: { kind: 'pull-request' } | { kind: 'epic-range'; range: string }) =>
      reviewRoot({
        id: graph.root.recordId,
        scope: mandateScope(mandate),
        head: graph.inputs.manifest.code.head,
        inputSnapshot: graph.inputs,
        subject,
      })
    for (const root of [
      rootFor({ kind: 'pull-request' }),
      rootFor({ kind: 'epic-range', range: `${'f'.repeat(40)}..${graph.inputs.manifest.code.head}` }),
    ]) {
      const records = graph.records.map((record) => (record.recordId === root.recordId ? root : record))
      expect(validateProspectiveRecord(root, history([], mandateScope(mandate))).map((item) => item.code)).toContain(
        'unbound',
      )
      const observed = history([...graph.issueRecords, ...records], mandateScope(mandate))
      expect(reviewCandidateCode(judgment, observed)).toBeNull()
    }
  })

  test('refuses missing, duplicate, foreign-scope, or mismatched mandate pins', () => {
    const fixture = epicFixture()
    const { inputs } = fixture.graph
    const manifests = [
      { ...inputs.manifest, acceptedSources: [] },
      { ...inputs.manifest, acceptedSources: [fixture.pin, fixture.pin] },
      {
        ...inputs.manifest,
        acceptedSources: [
          {
            ...fixture.pin,
            record: { ...fixture.pin.record, scope: { ...fixture.pin.record.scope, target: 'acme/widgets#other' } },
          },
        ],
      },
      { ...inputs.manifest, acceptedSources: [{ ...fixture.pin, digest: 'a'.repeat(64) }] },
      {
        ...inputs.manifest,
        acceptedSources: [{ ...fixture.pin, record: { ...fixture.pin.record, recordId: 'wrong-owner' } }],
      },
    ]
    for (const manifest of manifests) {
      const changed = { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
      expect(selection(changed, fixture.observed).selected.declarations).toEqual([])
    }
  })

  test('refuses a foreign or edited native mandate', () => {
    const fixture = epicFixture()
    for (const mode of ['foreign', 'edited'] as const) {
      const observed = {
        ...fixture.observed,
        operations: fixture.observed.operations.map((operation) => {
          if (operation.recordId !== fixture.mandate.recordId) return operation
          if (mode === 'foreign') return { ...operation, authority: 'foreign' as const }
          return {
            ...operation,
            parts: operation.parts.map((part) => ({ ...part, updatedAt: '2026-10-22T00:00:00Z' })),
          }
        }),
      }
      expect(selection(fixture.graph.inputs, observed).selected.declarations).toEqual([])
    }
  })
})
