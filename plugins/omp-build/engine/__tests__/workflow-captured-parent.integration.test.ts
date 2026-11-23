import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, test } from 'vitest'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { readAssessmentSpecFacts } from '../../roxabi/uw-current-facts.ts'
import { appendHistoricalAssessment, openHistoricalAssessment } from '../../testing/native-assessment-history.ts'
import { openHistoricalDelivery } from '../../testing/native-history-records.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceNativePlan } from '../../testing/native-plan-producer.ts'
import { operatorDialogUi, operatorRootContext } from '../../testing/operator-dialog-ui.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { criterionIdSchema } from '../uw-spec-schema.ts'
import { inspectCapturedWorkForAssessment } from '../workflow-captured-work.ts'
import { acceptedConstraints, proposedConstraints } from '../workflow-constraint-compatibility.ts'
import { resolveOwnSpecAuthority } from '../workflow-mandate-admission.ts'
import type { PlanOutput, SpecAssessment } from '../workflow-output-schema.ts'
import { planMacro } from '../workflow-plan-macro.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'
import { clear, evidence } from './workflow-captured-world-fixture.ts'

describe('captured parent integration during material assessment', () => {
  test.each(['completed', 'open'] as const)('accounts for actual Parent integration only when %s', async (mode) => {
    const checkout = nativeImplementationGit()
    try {
      const [firstMerge, secondMerge, thirdMerge] = checkout.merges
      if (!firstMerge || !secondMerge || !thirdMerge) throw new Error('Expected three child merges')
      await checkout.publishBase(thirdMerge)
      const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
      await threeDeliveredChildren(
        {
          ...checkout,
          cwd: parentCheckout.cwd,
          trees: checkout.heads.map(checkout.tree),
          baseTrees: [checkout.p0, firstMerge, secondMerge].map(checkout.tree),
          mergeTrees: checkout.merges.map(checkout.tree),
          parentTree: checkout.tree(checkout.parentHead),
          diff: checkout.diff(thirdMerge, checkout.parentHead),
        },
        [{ id: 'C1', statement: 'Save keeps the selected region' }],
        'framed',
        async (world) => {
          const base = world.merges[2]
          if (!base) throw new Error('Expected third child merge')
          parentCheckout.checkout(base)
          const planWorld = { cwd: parentCheckout.cwd, gh: world.gh, git: world.git, operations: world.operations }
          const ctx = {
            world: planWorld,
            scope: world.parentScope,
            mandate: world.parent,
            parentScopes: [],
            git: { repository: world.parentScope.repository, commit: base, tree: checkout.tree(base) },
          }
          const parentPlan: PlanOutput = {
            steps: [
              {
                id: 'parent-integration',
                criterionIds: ['C1'],
                change: 'Integrate the three independently delivered children',
                doneWhen: 'Save keeps the selected region',
                evidence: 'The parent integration test verifies the criterion',
                paths: ['fixture.txt'],
              },
            ],
            resolutions: [],
          }
          const planned = await produceNativePlan({ ...ctx, output: parentPlan, reviews: [clear, clear] })
          const before = evidence(planned.read, world.parentScope, [])
          expect(inspectCapturedWorkForAssessment(before, world.parent).ok).toBe(true)
          const initial = parentCheckout.observe()
          async function assertOpenIntegration() {
            await openHistoricalDelivery({
              world: planWorld,
              scope: world.parentScope,
              mandate: world.parent,
              read: planned.read,
              action: 'integrate',
              code: { repository: world.parentScope.repository, base: base, head: base, referenceCommit: base },
            })
            const pending = await world.operations.readUw(world.parentScope)
            expect(inspectCapturedWorkForAssessment(evidence(pending, world.parentScope, []), world.parent).ok).toBe(
              false,
            )
          }
          async function assertCompletedIntegration() {
            const produced = await produceParentIntegration(world, parentCheckout, {
              initial,
              candidate: initial,
              command: 'bun test parent.test.ts',
              output: 'PASS parent integration',
            })
            if (produced.receipt.payload.action !== 'integrate' || produced.receipt.payload.phase !== 'result')
              throw new Error('Expected the authenticated integration result')
            expect(produced.receipt.payload.admission?.admitted).toBe(true)
            expect(
              inspectCapturedWorkForAssessment(evidence(produced.beforeReview, world.parentScope, []), world.parent).ok,
            ).toBe(true)
          }
          if (mode === 'open') await assertOpenIntegration()
          else await assertCompletedIntegration()
        },
      )
    } finally {
      checkout.cleanup()
    }
  })

  test('replays admitted Parent integration after an actual metadata-only coverage acceptance', async () => {
    const checkout = nativeImplementationGit()
    let confirmations = 0
    const operator = createOperatorConfirmation({
      ...operatorRootContext(checkout.cwd, { getArtifactsDir: () => checkout.cwd }),
      hasUI: true,
      mode: 'tui',
      ui: operatorDialogUi(async () => {
        confirmations += 1
        return 'confirm'
      }),
    } as unknown as ExtensionContext)
    const criteria = [
      { id: 'C1' as const, statement: 'Save keeps the selected region' },
      { id: 'C2' as const, statement: 'The integrated change preserves the selected region' },
    ]
    try {
      const [firstMerge, secondMerge, thirdMerge] = checkout.merges
      if (!firstMerge || !secondMerge || !thirdMerge) throw new Error('Expected three child merges')
      await checkout.publishBase(thirdMerge)
      const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
      await threeDeliveredChildren(
        {
          ...checkout,
          cwd: parentCheckout.cwd,
          trees: checkout.heads.map(checkout.tree),
          baseTrees: [checkout.p0, firstMerge, secondMerge].map(checkout.tree),
          mergeTrees: checkout.merges.map(checkout.tree),
          parentTree: checkout.tree(checkout.parentHead),
          diff: checkout.diff(thirdMerge, checkout.parentHead),
        },
        criteria,
        'framed',
        async (world) => {
          const base = world.merges[2]
          if (!base) throw new Error('Expected third child merge')
          parentCheckout.checkout(base)
          const parentPlan: PlanOutput = {
            steps: criteria.map((criterion, index) => ({
              id: `parent-step-${index + 1}`,
              criterionIds: [criterion.id],
              change: criterion.statement,
              doneWhen: criterion.statement,
              evidence: `Parent test checks ${criterion.id}`,
              paths: ['fixture.txt'],
            })),
            resolutions: [],
          }
          const plan = await produceNativePlan({
            world: { cwd: parentCheckout.cwd, gh: world.gh, operations: world.operations },
            scope: world.parentScope,
            mandate: world.parent,
            parentScopes: [],
            git: { repository: world.parentScope.repository, commit: base, tree: checkout.tree(base) },
            output: parentPlan,
            reviews: [clear, clear],
          })
          expect(inspectCapturedWorkForAssessment(evidence(plan.read, world.parentScope, []), world.parent).ok).toBe(
            true,
          )
          const initial = parentCheckout.observe()
          const integration = await produceParentIntegration(world, parentCheckout, {
            initial,
            candidate: initial,
            command: 'bun test parent.test.ts',
            output: 'PASS parent integration',
          })
          if (integration.receipt.payload.action !== 'integrate' || integration.receipt.payload.phase !== 'result')
            throw new Error('Expected the authenticated integration result')
          expect(integration.receipt.payload.admission?.admitted).toBe(true)
          const old = integration.beforeReview
          if (old.accepted.status !== 'accepted') throw new Error('Original Parent acceptance unavailable')
          expect(inspectCapturedWorkForAssessment(evidence(old, world.parentScope, []), world.parent).ok).toBe(true)
          async function readCoverageRequest() {
            const basis = await readAssessmentSpecFacts({ uw: world.parentScope, read: old, coverage: null })
            if (basis.ok || !('coverageRequest' in basis))
              throw new Error(`Expected actual coverage request: ${JSON.stringify(basis)}`)
            const request = basis.coverageRequest
            return request
          }
          const request = await readCoverageRequest()
          function coverageProposal() {
            if (request.children.length !== 3 || request.criteria.length !== 2)
              throw new Error('Expected three children and two Parent criteria')
            const [firstChildRecord, secondChildRecord, thirdChildRecord] = request.children
            const [firstCriterion, secondCriterion] = request.criteria
            if (!firstChildRecord || !secondChildRecord || !thirdChildRecord || !firstCriterion || !secondCriterion)
              throw new Error('Expected three children and two Parent criteria')
            const firstChild = firstChildRecord.scope
            const secondChild = secondChildRecord.scope
            const thirdChild = thirdChildRecord.scope
            return {
              parent: request.parent,
              assignments: [
                {
                  criterion: criterionIdSchema.parse(firstCriterion.id),
                  children: [firstChild] as [typeof firstChild],
                },
                {
                  criterion: criterionIdSchema.parse(secondCriterion.id),
                  children: [secondChild, thirdChild] as [typeof secondChild, typeof thirdChild],
                },
              ],
            }
          }
          const proposedCoverage = coverageProposal()
          expect(canonicalValueDigest(proposedCoverage)).not.toBe(canonicalValueDigest(old.accepted.value.coverage))
          const started = await openHistoricalAssessment({
            world: { ...world, cwd: parentCheckout.cwd },
            scope: world.parentScope,
            mandate: world.parent,
            commit: base,
            coverage: proposedCoverage,
            basis: request,
          })
          const { exact } = started
          function assessmentJudgment(): SpecAssessment {
            const constraints = [
              ...acceptedConstraints(exact.accepted.ref, exact.accepted.snapshot.spec, true),
              ...proposedConstraints(exact.accepted.ref.uw, exact.proposed.snapshot.spec),
            ]
            for (const child of exact.accepted.children) {
              const source = exact.childOwnSources.find(
                (entry) => entry.uw.repository === child.scope.repository && entry.uw.target === child.scope.target,
              )
              if (!source?.own || source.own.version !== child.specVersion)
                throw new Error('Captured child authority missing')
              constraints.push(...acceptedConstraints(source.own, child.snapshot.spec, true))
            }
            const unique = [
              ...new Map(constraints.map((constraint) => [canonicalValueDigest(constraint), constraint])).values(),
            ]
            const first = unique[0]
            if (!first) throw new Error('Metadata assessment constraints missing')
            return {
              classification: 'material',
              compatibility: {
                state: 'consistent',
                examined: [first, ...unique.slice(1)],
                references: [],
                reason: 'The unchanged Parent and child constraints remain compatible.',
              },
            }
          }
          const judgment = assessmentJudgment()
          async function publishAndAccept() {
            await appendHistoricalAssessment(
              { ...world, cwd: parentCheckout.cwd },
              world.parentScope,
              started,
              'parent-coverage-assessment',
              judgment,
            )
            const accepted = await world.operations.acceptMaterial(world.parentScope)
            if (accepted.status !== 'accepted')
              throw new Error(`Parent metadata confirmation refused: ${JSON.stringify(accepted)}`)
            expect(confirmations).toBe(1)
          }
          await publishAndAccept()
          const current = await world.operations.readUw(world.parentScope)
          if (current.accepted.status !== 'accepted') throw new Error('Current Parent acceptance unavailable')
          expect(canonicalValueDigest(current.accepted.value.ref)).toBe(canonicalValueDigest(old.accepted.value.ref))
          expect(canonicalValueDigest(current.accepted.value.chain.at(-1)?.source)).not.toBe(
            canonicalValueDigest(old.accepted.value.chain.at(-1)?.source),
          )
          expect(canonicalValueDigest(current.accepted.value.coverage)).toBe(canonicalValueDigest(proposedCoverage))
          const currentEvidence = evidence(current, world.parentScope, [])
          expect(
            resolveOwnSpecAuthority(currentEvidence.issue, currentEvidence.parents, currentEvidence.causal).ok,
          ).toBe(true)
          expect(planMacro(currentEvidence, world.parent).phase).not.toBe('eligible')
          expect(inspectCapturedWorkForAssessment(currentEvidence, world.parent)).toEqual({
            ok: true,
            value: undefined,
          })
        },
        operator,
      )
    } finally {
      checkout.cleanup()
    }
  })
})
