import { execFileSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { openHistoricalAssessment } from '../../testing/native-assessment-history.ts'
import { openHistoricalDelivery } from '../../testing/native-history-records.ts'
import { produceNativeImplementation } from '../../testing/native-implementation-producer.ts'
import { confirmNewParentEngagement } from '../../testing/native-parent-engagement.ts'
import { openNativePlanStep, produceNativePlan, publishNativePlanStep } from '../../testing/native-plan-producer.ts'
import { actionInputDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { inspectCapturedWorkForAssessment as inspectCaptured } from '../workflow-captured-work.ts'
import { bindExternalRef } from '../workflow-control.ts'
import { resolveOwnSpecAuthority, selectApplicableMandate } from '../workflow-mandate-admission.ts'
import type { PlanReview } from '../workflow-output-schema.ts'
import { planMacro } from '../workflow-plan-macro.ts'
import { clear, evidence, inWorld, output } from './workflow-captured-world-fixture.ts'

function singleNativeStartParts(wire: ReturnType<typeof encodeParts>) {
  if (!wire.ok || wire.value.length !== 1) throw new Error('Expected one canonical edited native comment')
  return wire.value
}

async function expectEditedWorkRefused(
  { world, scenario }: Pick<Parameters<Parameters<typeof inWorld>[0]>[0], 'world' | 'scenario'>,
  recordId: string,
  nativeId: string,
  editedBody: string,
) {
  const after = await world.operations.readUw(scenario.leaf)
  expect(after.observation).toMatchObject({
    status: 'incomplete',
    diagnostics: [
      expect.objectContaining({
        code: 'legacy-coverage-incomplete',
        message: 'UW home history is incomplete or ambiguous',
      }),
    ],
  })
  const home = after.observation.histories.find((item) => item.source.scope.target === scenario.leaf.target)
  if (!home) throw new Error('Edited native history is missing')
  expect(home.source.comments.find((comment) => comment.nativeId === nativeId)?.body).toBe(editedBody)
  expect(home.operations.find((operation) => operation.recordId === recordId)).toMatchObject({ status: 'invalid' })
  expect(home.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'record-edited', message: expect.stringContaining(recordId) }),
  )
  const reread = await world.operations.readUw(scenario.leaf)
  expect(reread.observation.histories.map((item) => item.source)).toEqual(
    after.observation.histories.map((item) => item.source),
  )
}

describe('captured work during material assessment', () => {
  test('accounts for actual completed plan and both independently captured specialist reviews', async () => {
    await inWorld(async ({ world, scenario, git }) => {
      const ctx = {
        world,
        git,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parentScopes: [scenario.middle, scenario.root],
      }
      const produced = await produceNativePlan({ ...ctx, output, reviews: [clear, clear] })
      const current = evidence(produced.read, scenario.leaf, ctx.parentScopes)
      expect(inspectCaptured(current, scenario.leafMandate)).toEqual({ ok: true, value: undefined })
      expect(planMacro(current, scenario.leafMandate).phase).toBe('eligible')
      expect(produced.slotActions.map((slot) => slot.specialist).sort()).toEqual([
        'R-workflow-plan-adversarial',
        'R-workflow-plan-architect',
      ])
      expect(new Set(produced.slotActions.map((slot) => slot.action.actionId)).size).toBe(2)
    })
  })

  test('reenters actual material assessment after a new confirmed parent commitment, not old plan authority', async () => {
    await inWorld(async ({ world, scenario, git, confirmations }) => {
      const ctx = {
        world,
        git,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parentScopes: [scenario.middle, scenario.root],
      }
      const planned = await produceNativePlan({ ...ctx, output, reviews: [clear, clear] })
      const old = evidence(planned.read, scenario.leaf, ctx.parentScopes)
      expect(inspectCaptured(old, scenario.leafMandate).ok).toBe(true)
      expect(planMacro(old, scenario.leafMandate).phase).toBe('eligible')
      const changed = await confirmNewParentEngagement({
        world,
        scenario,
        commit: git.commit,
        statement: 'Deliver the revised assigned work',
      })
      expect(confirmations()).toBe(1)
      expect(changed.accepted.accepted.status).toBe('accepted')
      const currentRead = await world.operations.readUw(scenario.leaf)
      const current = evidence(currentRead, scenario.leaf, ctx.parentScopes)
      expect(resolveOwnSpecAuthority(current.issue, current.parents, current.causal).ok).toBe(true)
      expect(selectApplicableMandate(current.issue, current.parents, current.causal).status).toBe('refused')
      expect(planMacro(current, scenario.leafMandate).phase).not.toBe('eligible')
      expect(inspectCaptured(current, scenario.leafMandate)).toEqual({ ok: true, value: undefined })
      const { prepared } = await openHistoricalAssessment({
        world,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        commit: git.commit,
      })
      const inputs = prepared.inputs
      const manifest = inputs.manifest
      const request = {
        actionId: prepared.snapshot.actionId,
        purpose: manifest.purpose,
        subject: manifest.subject,
        code: manifest.code,
        stageSources: inputs.stageSources,
        expandedContext: manifest.expandedContext,
        ...(manifest.operands === undefined ? {} : { operands: manifest.operands }),
      }
      const replay = await world.operations.replayActionInputs({ reviewed: inputs, request })
      const afterStartRead = await world.operations.readUw(scenario.leaf)
      const afterStart = evidence(afterStartRead, scenario.leaf, ctx.parentScopes)
      const replayContext = { uw: scenario.leaf, actionId: request.actionId, fingerprint: inputs.fingerprint }
      const ownControl = resolveOwnSpecAuthority(
        afterStart.issue,
        afterStart.parents,
        afterStart.causal,
        new Set(),
        replayContext,
      )
      expect(
        replay.ok,
        JSON.stringify(
          {
            replay,
            request,
            reviewed: inputs,
            currentAccepted: currentRead.accepted,
            afterStartAccepted: afterStartRead.accepted,
            observationStatus: afterStartRead.observation.status,
            ownControl: ownControl.ok
              ? { ok: true, accepted: ownControl.value.accepted }
              : { ok: false, evidence: ownControl.diagnostics },
          },
          null,
          2,
        ),
      ).toBe(true)
      expect(
        (await world.operations.replayActionInputs({ reviewed: { ...inputs, fingerprint: 'f'.repeat(64) }, request }))
          .ok,
      ).toBe(false)
    })
  })

  test('accounts for actual admitted implementation only with its captured plan and native evidence', async () => {
    await inWorld(async ({ world, scenario, git, next }) => {
      const ctx = {
        world,
        git,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parentScopes: [scenario.middle, scenario.root],
      }
      const planned = await produceNativePlan({ ...ctx, output, reviews: [clear, clear] })
      const before = evidence(planned.read, scenario.leaf, ctx.parentScopes)
      expect(inspectCaptured(before, scenario.leafMandate).ok).toBe(true)
      const implementation = await produceNativeImplementation({
        cwd: world.cwd,
        gh: world.gh,
        git: world.git,
        operations: world.operations,
        read: planned.read,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parents: before.parents,
        startHead: git.commit,
        command: 'bun test fixture.test.ts',
        output: 'PASS fixture',
        advance() {
          execFileSync('git', ['-C', next.cwd, 'reset', '--quiet', '--hard', next.commit])
          world.checkout({
            branch: 'feature/202-leaf',
            base: 'main',
            baseTip: git.commit,
            head: next.commit,
            remoteTip: git.commit,
          })
          return { head: next.commit, tree: next.tree }
        },
      })
      if (implementation.receipt.payload.action !== 'implement' || implementation.receipt.payload.phase !== 'result')
        throw new Error('Expected the authenticated implementation result')
      expect(implementation.receipt.payload.admission?.admitted).toBe(true)
      expect(
        inspectCaptured(evidence(implementation.read, scenario.leaf, ctx.parentScopes), scenario.leafMandate).ok,
      ).toBe(true)
    })
  })

  test('holds a real unpaired implementation START despite a closed native plan', async () => {
    await inWorld(async ({ world, scenario, git }) => {
      const ctx = {
        world,
        git,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parentScopes: [scenario.middle, scenario.root],
      }
      const planned = await produceNativePlan({ ...ctx, output, reviews: [clear, clear] })
      const before = evidence(planned.read, scenario.leaf, ctx.parentScopes)
      expect(inspectCaptured(before, scenario.leafMandate).ok).toBe(true)
      await openHistoricalDelivery({
        world,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        read: planned.read,
        action: 'implement',
        code: { repository: scenario.leaf.repository, base: git.commit, head: git.commit, referenceCommit: git.commit },
      })
      const after = await world.operations.readUw(scenario.leaf)
      expect(inspectCaptured(evidence(after, scenario.leaf, ctx.parentScopes), scenario.leafMandate).ok).toBe(false)
    })
  })

  test('accounts for a completed blocking review without making its unstarted amendment eligible', async () => {
    await inWorld(async ({ world, scenario, git }) => {
      const ctx = {
        world,
        git,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parentScopes: [scenario.middle, scenario.root],
      }
      const blocked: PlanReview = {
        outcome: 'blocking',
        blockers: [{ id: 'blocker-1', criterionId: 'C1', gap: 'The plan does not specify the required verification' }],
      }
      const produced = await produceNativePlan({ ...ctx, output, reviews: [blocked, clear] })
      const current = evidence(produced.read, scenario.leaf, ctx.parentScopes)
      expect(inspectCaptured(current, scenario.leafMandate)).toEqual({ ok: true, value: undefined })
      expect(planMacro(current, scenario.leafMandate).phase).toBe('needs-amendment')
    })
  })

  test('holds an actual plan START that has not produced a result', async () => {
    await inWorld(async ({ world, scenario, git }) => {
      const ctx = {
        world,
        git,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parentScopes: [scenario.middle, scenario.root],
      }
      const before = await world.operations.readUw(scenario.leaf)
      expect(inspectCaptured(evidence(before, scenario.leaf, ctx.parentScopes), scenario.leafMandate).ok).toBe(true)
      const opened = await openNativePlanStep(ctx, 'plan')
      expect(inspectCaptured(evidence(opened.after, scenario.leaf, ctx.parentScopes), scenario.leafMandate).ok).toBe(
        false,
      )
    })
  })

  test('holds an actual review when a specialist did not return', async () => {
    await inWorld(async ({ world, scenario, git }) => {
      const ctx = {
        world,
        git,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parentScopes: [scenario.middle, scenario.root],
      }
      const opened = await openNativePlanStep(ctx, 'plan')
      const task = opened.opened.followUp.tasks.tasks[0]
      if (!task) throw new Error('Actual plan task missing')
      const completed = await publishNativePlanStep(ctx, opened, [
        { task: task.name, childId: 'plan-child', value: output },
      ])
      expect(completed.published.published, JSON.stringify(completed.published)).toBe(true)
      expect(inspectCaptured(evidence(completed.read, scenario.leaf, ctx.parentScopes), scenario.leafMandate).ok).toBe(
        true,
      )
      const review = await openNativePlanStep(ctx, 'plan-review')
      const specialist = review.opened.followUp.tasks.tasks[0]
      if (!specialist) throw new Error('Actual review specialist task missing')
      const missing = await publishNativePlanStep(ctx, review, [
        { task: specialist.name, childId: 'one-specialist', value: clear },
      ])
      expect(missing.published.published).toBe(false)
      expect(inspectCaptured(evidence(missing.read, scenario.leaf, ctx.parentScopes), scenario.leafMandate).ok).toBe(
        false,
      )
    })
  })

  test('holds a captured missing-context review without a successor', async () => {
    await inWorld(async ({ world, scenario, git }) => {
      const ctx = {
        world,
        git,
        scope: scenario.leaf,
        mandate: scenario.leafMandate,
        parentScopes: [scenario.middle, scenario.root],
      }
      const draft = await openNativePlanStep(ctx, 'plan')
      const draftTask = draft.opened.followUp.tasks.tasks[0]
      if (!draftTask) throw new Error('Actual plan task missing')
      const completed = await publishNativePlanStep(ctx, draft, [
        { task: draftTask.name, childId: 'plan-before-negative', value: output },
      ])
      expect(completed.published.published, JSON.stringify(completed.published)).toBe(true)
      expect(inspectCaptured(evidence(completed.read, scenario.leaf, ctx.parentScopes), scenario.leafMandate).ok).toBe(
        true,
      )
      const review = await openNativePlanStep(ctx, 'plan-review')
      const batch = review.opened.followUp
      const [first, second] = batch.tasks.tasks
      if (!first || !second || batch.tasks.tasks.length !== 2) throw new Error('Expected two actual specialist tasks')
      const negative = {
        outcome: 'missing-context' as const,
        missing: [
          {
            locator: { kind: 'information-request' as const, description: 'Deployment region' },
            reason: 'The deployment region is required for this review',
            targets: [],
          },
        ],
      }
      const captured = await publishNativePlanStep(ctx, review, [
        { task: first.name, childId: 'negative-review-child', value: negative },
        { task: second.name, childId: 'clear-review-child', value: clear },
      ])
      if (!captured.receipt) throw new Error('Historical review result was not seeded')
      const after = evidence(captured.read, scenario.leaf, ctx.parentScopes)
      expect(bindExternalRef(captured.receipt, after.issue)).toMatchObject({
        ok: true,
        value: {
          payload: {
            action: 'plan-review',
            phase: 'result',
            structured: negative,
            contributions: [
              { host: { slotId: first.name, childId: 'negative-review-child' }, structured: negative },
              { host: { slotId: second.name, childId: 'clear-review-child' }, structured: clear },
            ],
          },
        },
      })
      expect(inspectCaptured(after, scenario.leafMandate).ok).toBe(false)
    })
  })

  test.each(['child', 'raw-submission', 'slot-action'] as const)(
    'holds after the actual published specialist witness loses its %s binding',
    async (change) => {
      await inWorld(async ({ world, scenario, git }) => {
        const ctx = {
          world,
          git,
          scope: scenario.leaf,
          mandate: scenario.leafMandate,
          parentScopes: [scenario.middle, scenario.root],
        }
        const produced = await produceNativePlan({ ...ctx, output, reviews: [clear, clear] })
        const before = evidence(produced.read, scenario.leaf, ctx.parentScopes)
        expect(inspectCaptured(before, scenario.leafMandate).ok).toBe(true)
        const original = produced.reviewRecord
        if (original.payload.action !== 'plan-review' || original.payload.phase !== 'result')
          throw new Error('Actual plan review RESULT is missing')
        const contributions = original.payload.contributions.map((contribution, index) => {
          if (index !== 0) return contribution
          if (change === 'child') return { ...contribution, host: { ...contribution.host, childId: 'different-child' } }
          if (change === 'raw-submission') return { ...contribution, rawAttempts: [] }
          const { action: _action, ...host } = contribution.host
          return { ...contribution, host }
        })
        expect(contributions).not.toEqual(original.payload.contributions)
        const edited = buildRecord({ ...original, payload: { ...original.payload, contributions } })
        if (!edited.ok)
          throw new Error(`Edited specialist witness is not canonical: ${JSON.stringify(edited.diagnostics)}`)
        const wire = encodeParts(edited.value, 'Edited native review RESULT', 65536)
        if (!wire.ok) throw new Error(`Cannot encode edited specialist witness: ${JSON.stringify(wire.diagnostics)}`)
        const bodies = wire.value
        function existingOperation() {
          const operation = before.issue.operations.find((item) => item.recordId === original.recordId)
          if (!operation || operation.parts.length === 0) throw new Error('Expected actual native review comments')
          return operation
        }
        const operation = existingOperation()
        async function replaceNativeComments() {
          function editExistingParts() {
            for (const [index, part] of operation.parts.entries()) {
              if (!part.nativeId) throw new Error('Native review comment lacks its ID')
              world.editComment(
                scenario.leaf,
                part.nativeId,
                bodies[index] ?? 'External edit removed this record part.',
                '2026-10-29T12:00:00Z',
              )
            }
          }
          editExistingParts()
          const issue = scenario.leaf.target.split('#').at(-1)
          if (!issue) throw new Error('Native issue number is missing')
          for (const body of bodies.slice(operation.parts.length)) {
            await world.gh(world.cwd, [
              'api',
              '--method',
              'POST',
              `repos/${scenario.leaf.repository}/issues/${issue}/comments`,
              '-f',
              `body=${body}`,
            ])
          }
        }
        await replaceNativeComments()
        const nativeId = operation.parts[0]?.nativeId
        const editedBody = bodies[0]
        if (!nativeId || editedBody === undefined) throw new Error('Edited native review part is missing')
        await expectEditedWorkRefused({ world, scenario }, original.recordId, nativeId, editedBody)
      })
    },
  )

  test.each(['code', 'inherited-constraint', 'accepted-source'] as const)(
    'refuses a native START whose %s was edited after its paired result was published',
    async (change) => {
      await inWorld(async ({ world, scenario, git }) => {
        const ctx = {
          world,
          git,
          scope: scenario.leaf,
          mandate: scenario.leafMandate,
          parentScopes: [scenario.middle, scenario.root],
        }
        const produced = await produceNativePlan({ ...ctx, output, reviews: [clear, clear] })
        const before = evidence(produced.read, scenario.leaf, ctx.parentScopes)
        expect(inspectCaptured(before, scenario.leafMandate).ok).toBe(true)
        const original = produced.planStartRecord
        function capturedStart() {
          if (
            original.kind !== 'action-receipt' ||
            original.payload.action !== 'plan' ||
            original.payload.phase !== 'start'
          )
            throw new Error('Actual plan START is missing')
          return original
        }
        const actualStart = capturedStart()
        const previous = actualStart.payload.inputs
        if (previous.manifest.spec.kind !== 'accepted') throw new Error('Actual plan lacks accepted vector')
        const acceptedSpec = previous.manifest.spec
        const effective = previous.manifest.spec.effective
        function changedManifest() {
          return change === 'code'
            ? {
                ...previous.manifest,
                code: {
                  ...previous.manifest.code,
                  base: 'c'.repeat(40),
                  head: 'c'.repeat(40),
                  referenceCommit: 'c'.repeat(40),
                },
              }
            : change === 'inherited-constraint'
              ? {
                  ...previous.manifest,
                  spec: {
                    ...acceptedSpec,
                    effective: {
                      ...effective,
                      inherited: {
                        ...effective.inherited,
                        invariants: effective.inherited.invariants.map((item, index) =>
                          index === 0 ? { ...item, statement: `${item.statement} changed` } : item,
                        ),
                      },
                    },
                  },
                }
              : {
                  ...previous.manifest,
                  acceptedSources: previous.manifest.acceptedSources.filter(
                    (source) => source.record.scope.target !== scenario.root.target,
                  ),
                }
        }
        const manifest = changedManifest()
        expect(manifest).not.toEqual(previous.manifest)
        const edited = buildRecord({
          ...actualStart,
          payload: {
            ...actualStart.payload,
            inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) },
          },
        })
        if (!edited.ok) throw new Error(`Edited witness is not canonical: ${JSON.stringify(edited.diagnostics)}`)
        const wire = encodeParts(edited.value, 'Edited native START', 65536)
        const parts = singleNativeStartParts(wire)
        const operation = before.issue.operations.find((item) => item.recordId === actualStart.recordId)
        const nativeId = operation?.parts[0]?.nativeId
        if (!nativeId || operation?.parts.length !== 1) throw new Error('Expected one actual native START comment')
        const encoded = parts[0]
        if (encoded === undefined) throw new Error('Expected one canonical edited native comment')
        world.editComment(scenario.leaf, nativeId, encoded, '2026-10-29T12:00:00Z')
        await expectEditedWorkRefused({ world, scenario }, actualStart.recordId, nativeId, encoded)
      })
    },
  )
})
