import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { finding, TEST_SCOPE } from '../../testing/record-builders.ts'
import { contribution } from '../../testing/record-decisions.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { history } from '../../testing/record-history.ts'
import { actionInputDigest } from '../action-input.ts'
import { createReviewClassCatalogues } from '../review-class-catalogue.ts'
import { deriveRecallPlan } from '../review-conservation.ts'

function pinned(commit: string, classId: string) {
  const base = standaloneReviewInputs(TEST_SCOPE)
  const plugin = base.manifest.plugin
  const bytes = new TextEncoder().encode(`classes:\n  - class: ${classId}\n`)
  const ref = {
    source: 'git-file' as const,
    repository: plugin.repository,
    commit,
    path: `${plugin.root}/skills/dev-review/review-classes.yml`,
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
  const manifest = { ...base.manifest, plugin: { ...plugin, commit, files: [ref] } }
  return { inputs: { ...base, manifest, fingerprint: actionInputDigest(manifest) }, ref, bytes }
}

function capturedRoot(pin: ReturnType<typeof pinned>, prefix: string) {
  const graph = reviewGraph({ prefix, inputs: pin.inputs })
  const captured = contribution({
    id: graph.panel.recordId,
    inventoryId: graph.root.recordId,
    findings: [
      {
        id: `${graph.panel.recordId}:f0`,
        attemptIndex: 0,
        data: finding({ classes: ['test-tautology'], rawCallsites: [{ file: 'src/widget.ts', line: 41 }] }),
      },
    ],
  })
  const panel = { ...captured, payload: { ...captured.payload, host: graph.panel.payload.host } }
  return {
    root: graph.root,
    findingId: `${graph.panel.recordId}:f0`,
    history: history([graph.root, graph.spec, panel]),
  }
}

test('recall class inspection uses the producer pin, never another historical catalogue', () => {
  const old = pinned('b'.repeat(40), 'test-tautology')
  const newer = pinned('c'.repeat(40), 'regression-risk')
  const table = createReviewClassCatalogues(
    [old, newer].map(({ ref, bytes }) => ({
      ref,
      contents: { ok: true as const, value: bytes },
    })),
  )
  const oldRoot = capturedRoot(old, 'old-recall')
  const newRoot = capturedRoot(newer, 'new-recall')
  const oldPlan = deriveRecallPlan(oldRoot.history, oldRoot.root.recordId, table)
  expect(oldPlan, JSON.stringify(oldPlan)).toMatchObject({
    ok: true,
    value: { index: [{ classId: 'test-tautology', sourceFindingIds: [oldRoot.findingId] }] },
  })
  const newPlan = deriveRecallPlan(newRoot.history, newRoot.root.recordId, table)
  expect(newPlan, JSON.stringify(newPlan)).toMatchObject({
    ok: true,
    value: { index: [] },
  })
  const newerOnly = createReviewClassCatalogues([{ ref: newer.ref, contents: { ok: true, value: newer.bytes } }])
  expect(deriveRecallPlan(oldRoot.history, oldRoot.root.recordId, newerOnly).ok).toBe(false)
})
