import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { buildRecord } from '../engine/record-construction.ts'
import { specDigest } from '../engine/record-digests.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { planOutputSchema } from '../engine/workflow-output-schema.ts'
import { BRANCH, cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../testing/feature-recovery-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { writeSim } from '../testing/sandbox/sandbox-repository.ts'

afterEach(cleanupFeatureRecoveryRoots)

describe('installed feature criterion blockers', () => {
  function arrange(covered: readonly ('C1' | 'C9')[]) {
    const { box, checkout } = featureFixture('plan')
    const fixtures = roxabiWorkflowFixtures()
    const spec = canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [
        { id: 'C1', statement: 'Preserve the selected region' },
        { id: 'C2', statement: 'Restore the region after reload' },
      ],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    })
    if (!spec.ok) throw new Error('expected canonical Spec')
    const body = renderIssueSpecBody(spec.value)
    const ownSpec = fixtures.ownSpecFromSnapshot(SCOPE, {
      spec: spec.value,
      raw: { reference: SCOPE.target, body, bodySha256: specDigest(body), lastEditedAt: '2026-10-21T12:00:00Z' },
    })
    const mandate = fixtures.featureMandate(SCOPE, { branch: BRANCH, body, ownSpec, lineageHead: box.sha.main })
    const identity = fixtures.identityAllocation(SCOPE)
    if (identity.kind !== 'spec-identity' || identity.payload.event !== 'allocate')
      throw new Error('expected identity allocation')
    const { inputs: _identityInputs, ...identityDraft } = identity
    const allocated = buildRecord({
      ...identityDraft,
      payload: {
        ...identity.payload,
        allocations: [
          { draftKey: 'criterion-1', id: 'C1' },
          { draftKey: 'criterion-2', id: 'C2' },
        ],
      },
    })
    if (!allocated.ok) throw new Error('expected identity record')
    const [start, result] = fixtures.planDraftRecords(mandate)
    if (
      start === undefined ||
      result?.kind !== 'action-receipt' ||
      result.payload.action !== 'plan' ||
      result.payload.phase !== 'result'
    )
      throw new Error('expected plan result')
    const plan = planOutputSchema.parse(result.payload.structured)
    const { inputs: _planInputs, ...resultDraft } = result
    const changed = buildRecord({
      ...resultDraft,
      payload: {
        ...result.payload,
        structured: { ...plan, steps: plan.steps.map((step) => ({ ...step, criterionIds: [...covered] })) },
      },
    })
    if (!changed.ok) throw new Error('expected plan record')
    writeSim(box, (state) => {
      const issue = state.issues['42']
      if (!issue) throw new Error('missing feature issue')
      issue.body = body
      issue.comments = fixtures
        .framedBodies([allocated.value, mandate, start, changed.value], 'operator')
        .map((comment) => ({ author: 'operator', body: comment }))
    })
    return { box, checkout }
  }

  it.each([
    { covered: ['C1'], missing: 'C2', unknown: null },
    { covered: ['C1', 'C9'], missing: 'C2', unknown: 'C9' },
  ] as const)('names the affected criteria in the operator message', ({ covered, missing, unknown }) => {
    const { box, checkout } = arrange(covered)
    const home = path.join(box.root, 'criterion-home')
    mkdirSync(home, { recursive: true })
    const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
    const runner = path.resolve(import.meta.dirname, '../testing/feature-recovery-runner.ts')
    const run = spawnSync(bun, [runner, 'omp-feature', checkout, '{}'], {
      cwd: checkout,
      env: { ...box.env, HOME: home },
      encoding: 'utf8',
    })
    if (run.status !== 0) throw new Error(`omp-feature failed: ${run.stderr}\n${run.stdout}`)
    const output = JSON.parse(run.stdout) as { messages: string[] }
    expect(output.messages).toHaveLength(1)
    expect(output.messages[0]).toContain(missing)
    expect(output.messages[0]).not.toContain('Restore the region after reload')
    if (unknown !== null) expect(output.messages[0]).toContain(unknown)
  })
})
