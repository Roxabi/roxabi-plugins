import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { parseRecord } from '../engine/record-construction.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../testing/feature-recovery-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { readSim, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'
import { coldCheckout, invoke } from './feature-recovery-process-fixture.ts'
import { canonicalJson, configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'

const fixtures = roxabiWorkflowFixtures()
afterEach(cleanupFeatureRecoveryRoots)

function history(box: Box) {
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
      locator: `acme/app#42:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    diagnostics: [],
  })
}

it.each(['productVersion', 'digest', 'compatible'] as const)(
  'admits a paused mandate with review requirements only under compatible runtime configuration (%s)',
  (drift) => {
    const { box } = featureFixture('start')
    const records = history(box).operations.flatMap((operation) => {
      if (!operation.record) throw new Error('invalid fixture history')
      // Exercise an accepted UW before its first native action starts.
      return operation.record.kind === 'action-receipt' ? [] : [operation.record]
    })
    const original = records.find((record) => record.kind === 'mandate')
    if (original?.kind !== 'mandate') throw new Error('missing feature mandate')
    const productVersion = drift === 'productVersion' ? '0.18.8' : original.payload.config.productVersion
    const effective = effectiveWorkflowConfig(productVersion, ['Review accessibility'])
    if (drift === 'digest') {
      effective.graph.edges.reverse()
      effective.graphDigest = createHash('sha256')
        .update(
          canonicalJson({
            version: effective.compatibility,
            nodes: effective.graph.nodes,
            edges: effective.graph.edges,
          }),
        )
        .digest('hex')
    }
    const parsed = parseRecord({
      ...original,
      payload: {
        ...original.payload,
        config: {
          ...original.payload.config,
          productVersion,
          effective,
          digest: configPinDigest(effective),
        },
      },
    })
    if (!parsed.ok || parsed.value.kind !== 'mandate') throw new Error('invalid drifted mandate fixture')
    const mandate = parsed.value
    const request = fixtures.pauseRequested(mandate)
    const confirmed = fixtures.pauseConfirmed(mandate, request)
    writeSim(box, (state) => {
      const issue = state.issues['42']
      if (!issue) throw new Error('missing feature issue')
      issue.comments = fixtures
        .framedBodies(
          [...records.map((record) => (record.recordId === original.recordId ? mandate : record)), request, confirmed],
          'operator',
        )
        .map((body) => ({
          author: 'operator',
          body,
        }))
    })

    const pausedCheckout = coldCheckout(box, 'paused-drift')
    const paused = invoke<{ kind: string; confirmed: boolean; reason: string }>(
      box,
      pausedCheckout,
      path.join(box.root, 'home-paused-drift'),
      'continue',
      { reference: '#42' },
    )
    expect(paused).toEqual({ kind: 'paused', confirmed: true, reason: 'paused' })

    const resumeCheckout = coldCheckout(box, 'resume-drift')
    const result = invoke<{ kind: string; reason: string }>(
      box,
      resumeCheckout,
      path.join(box.root, 'home-resume-drift'),
      'continue',
      { reference: '#42', control: 'resume' },
    )
    expect(result).toMatchObject(
      drift === 'compatible' ? { kind: 'action', node: 'plan' } : { kind: 'blocked', reason: 'config-drift' },
    )
    const controls = history(box).operations.flatMap((operation) =>
      operation.record?.kind === 'operator-control' ? [operation.record.payload.control] : [],
    )
    expect(controls).toContain('pause-confirmed')
    if (drift === 'compatible') expect(controls).toContain('resume')
    else expect(controls).not.toContain('resume')
  },
)
