import { expect, it } from 'vitest'
import { rawSource } from '../../adapters/github-native/uw-spec.ts'
import { authenticatedReview } from '../../testing/cause-input-fixture.ts'
import { synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { submission } from '../../testing/record-builders.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import { assessCauseDispositions } from '../cause-disposition.ts'
import { parseRecord } from '../record-construction.ts'
import { recordsOf } from '../workflow-control.ts'
import { cataloguesForInputs, withPinnedCatalogue } from './cause-catalogue-fixture.ts'
import { history, must } from './workflow-test-support.ts'

function assessClass(originalClass: string, downgrade = false, catalogue: 'valid' | 'absent' | 'forged' = 'valid') {
  const { graph: seed, context } = authenticatedReview()
  const binding = recordsOf(seed.history).find((record) => record.kind === 'workflow-binding')
  if (binding?.kind !== 'workflow-binding') throw new Error('Expected authenticated binding')
  const mandate = roxabiWorkflowFixtures().featureMandate(context.original, {
    recordId: 'mandate-42',
    body: 'Save the selected region',
  })
  const pinned = withPinnedCatalogue(seed.inputs)
  const plugin = pinned.manifest.plugin
  const files =
    catalogue === 'absent'
      ? []
      : catalogue === 'forged'
        ? plugin.files.map((file) => ({ ...file, digest: 'f'.repeat(64) }))
        : plugin.files
  const manifest = { ...pinned.manifest, plugin: { ...plugin, files } }
  const inputs = { ...pinned, manifest, fingerprint: actionInputDigest(manifest) }
  const graph = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'admission-source', label: 'issue', inputs })
  const sourceAction = { actionId: 'authenticated-panel-action', inputs: graph.inputs }
  const root = must(
    parseRecord({
      ...graph.root,
      payload: {
        ...graph.root.payload,
        slots: graph.root.payload.slots.map((slot) =>
          slot.slotId === 'panel-0' ? { ...slot, action: sourceAction } : slot,
        ),
      },
    }),
  )
  const original = graph.panel.payload.findings?.[0]
  const cause = graph.decision.payload.judgment.causes[0]
  const pin = graph.inputs.manifest.repositoryReferences[0]
  if (
    !original ||
    original.data === null ||
    typeof original.data !== 'object' ||
    Array.isArray(original.data) ||
    !cause ||
    !pin
  )
    throw new Error('Expected source finding, cause and pinned evidence')
  const data = { ...original.data, classes: [originalClass], rawCallsites: [{ file: 'src/region.ts', line: 41 }] }
  const output = { findings: [data] }
  const panel = must(
    parseRecord({
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        host: { ...graph.panel.payload.host, action: sourceAction },
        findings: [{ ...original, data }],
        structured: output,
        rawAttempts: [
          submission({ id: `child-${graph.panel.recordId}`, structuredOutput: { status: 'valid', data: output } }),
        ],
      },
    }),
  )
  const supported = (value: boolean) => ({
    state: 'supported' as const,
    value,
    reason: 'Pinned source establishes this judgment',
    references: [pin],
  })
  const judgment = {
    ...graph.decision.payload.judgment,
    findings: graph.decision.payload.judgment.findings.map((finding) =>
      downgrade ? { ...finding, label: 'suggestion' as const } : finding,
    ),
    causes: [
      {
        ...cause,
        proposedDisposition: downgrade ? ('report' as const) : ('fix-original' as const),
        judgment: downgrade
          ? cause.judgment
          : { necessary: supported(true), urgent: supported(true), tooLarge: supported(false) },
      },
    ],
  }
  const decision = must(parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } }))
  const synthesis = must(
    parseRecord({
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: judgment,
        rawAttempts: [
          submission({
            id: `child-${graph.synthesisContribution.recordId}`,
            structuredOutput: { status: 'valid', data: judgment },
          }),
        ],
      },
    }),
  )
  if (decision.kind !== 'decision') throw new Error('Expected decision')
  const replacements = [root, panel, decision, synthesis]
  const source = history(
    recordsOf(graph.history).map((record) =>
      must(parseRecord(replacements.find((replacement) => replacement.recordId === record.recordId) ?? record)),
    ),
    graph.history.source.scope,
  )
  return assessCauseDispositions({
    context,
    capture: synthesisActionCapture(decision, [source]),
    graph: {
      status: 'complete',
      root: context.original,
      observedAt: '2026-10-27T12:00:00Z',
      nodes: [
        {
          uw: context.original,
          title: 'Save region',
          raw: rawSource(context.original.target, 'Save the selected region', '2026-10-27T12:00:00Z'),
          updatedAt: '2026-10-27T12:00:00Z',
          labels: ['size:S'],
          wayfinderLabels: [],
          parent: null,
          children: [],
          blockers: [],
          native: { state: 'OPEN', stateReason: null },
        },
      ],
    },
    source: { kind: 'decision', decision },
    histories: [history([mandate], context.original), source],
    adjudications: [],
    catalogues: cataloguesForInputs(inputs),
  })
}

it('never executes a cause whose raw original asserts an unknown canonical class', () => {
  const result = must(assessClass('not-in-the-canonical-taxonomy'))
  expect(result.executableCauseIds).toEqual([])
  expect(result.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: expect.objectContaining({ kind: 'retained-finding' }),
        outcome: expect.objectContaining({ state: 'pending-blocking' }),
      }),
    ]),
  )
})

it('still admits an independently canonical class to an otherwise supported fix', () => {
  const result = must(assessClass('test-tautology'))
  expect(result.executableCauseIds).toHaveLength(1)
  expect(result.outcomes[0]?.outcome).toMatchObject({ state: 'final', disposition: 'fix-original' })
})

it('retains an unknown-class original when synthesis downgrades it', () => {
  const result = must(assessClass('not-in-the-canonical-taxonomy', true))
  expect(result.executableCauseIds).toEqual([])
  expect(result.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: expect.objectContaining({ kind: 'retained-finding' }),
        outcome: expect.objectContaining({ state: 'pending-blocking' }),
      }),
    ]),
  )
})

it('allows a canonical-class original to be downgraded', () => {
  const result = must(assessClass('test-tautology', true))
  expect(result.diagnostics.map((item) => item.code)).not.toContain('unknown-reference')
  expect(result.outcomes[0]?.subject.kind).toBe('cause')
  expect(result.outcomes[0]?.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
})

it.each(['absent', 'forged'] as const)('does not execute when the pinned canonical catalogue is %s', (catalogue) => {
  const result = assessClass('test-tautology', false, catalogue)
  if (!result.ok) return
  expect(result.value.executableCauseIds).toEqual([])
  expect(result.value.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ outcome: expect.objectContaining({ state: 'pending-blocking' }) }),
    ]),
  )
})
