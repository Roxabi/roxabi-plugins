import { afterEach, expect, it, vi } from 'vitest'
import { encodeRecord } from '../adapters/github/history-codec.ts'
import { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest } from '../engine/action-input.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { Scope } from '../engine/record-values.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { criterionIdSchema } from '../engine/uw-spec-schema.ts'
import { withEpicEffects } from '../skills/feature/epic-driver-runtime.ts'
import { A } from '../skills/feature/testing/goal/goal-scenario-domain.ts'
import { dispose, git, readSim, writeSim } from '../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import {
  coverageIntent,
  driverEffects,
  heldEpicStep,
  parentFixture,
} from '../testing/feature-parent-topology-fixture.ts'
import {
  authenticatedPlanFixtures,
  eligiblePlanAt,
} from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { checkPlannedAncestry, resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { recordStartNotActivated } from './feature-start-executions.ts'
import type { OperatorPort, UwOperations } from './uw-contract.ts'
import { createInstalledUwOperations } from './uw-installed-operations.ts'
import { continueFeature } from './workflow.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})
async function exerciseMiddleAnchorPresentation(operations: UwOperations, root: Scope, middle: Scope) {
  const baseline = await operations.readUw(middle)
  if (baseline.parsed.status !== 'conformant') throw new Error('Expected conformant middle Spec')
  const original = baseline.parsed.snapshot
  expect(await resolveParentWorktreeAnchor({ subject: middle, read: baseline })).toEqual({ ok: true, anchor: root })
  const same = await checkPlannedAncestry({
    subject: middle,
    read: baseline,
    planned: { spec: original.spec, tier: 'F-lite' },
  })
  expect(same.ok).toBe(true)
  if (!same.ok) throw new Error(same.reason)
  expect(same.inherited.map((ref) => ref.uw)).toEqual([root])
  const wrongTier = await checkPlannedAncestry({
    subject: middle,
    read: baseline,
    planned: { spec: original.spec, tier: 'S' },
  })
  expect(wrongTier).toEqual({ ok: false, reason: 'parent-anchor-commitment-mismatch' })
  const material = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'lands with materially different requirements' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!material.ok) throw new Error('Expected conformant material Spec')
  expect(material.value.version).not.toBe(original.spec.version)
  expect(
    await checkPlannedAncestry({
      subject: middle,
      read: baseline,
      planned: { spec: material.value, tier: 'F-lite' },
    }),
  ).toEqual({ ok: false, reason: 'parent-anchor-commitment-mismatch' })
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing nested parent')
    Object.assign(issue, {
      body: renderIssueSpecBody(material.value, { complexity: 1 }),
      updatedAt: '2026-01-02T00:00:00Z',
    })
  })
  expect((await resolveParentWorktreeAnchor({ subject: middle, read: await operations.readUw(middle) })).ok).toBe(false)
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing nested parent')
    Object.assign(issue, { body: original.raw.body, labels: ['size:S'] })
  })
  expect((await resolveParentWorktreeAnchor({ subject: middle, read: await operations.readUw(middle) })).ok).toBe(false)
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing nested parent')
    Object.assign(issue, { body: `${original.raw.body}\n`, labels: ['size:F-lite'], updatedAt: '2026-01-03T00:00:00Z' })
  })
  const current = await operations.readUw(middle)
  if (current.parsed.status !== 'conformant') throw new Error('Expected conformant presentation edit')
  expect(current.parsed.snapshot.spec.version).toBe(original.spec.version)
  expect(current.parsed.snapshot.raw.bodySha256).not.toBe(original.raw.bodySha256)
  expect(current.parsed.snapshot.raw.lastEditedAt).toBe('2026-01-03T00:00:00Z')
  expect(await resolveParentWorktreeAnchor({ subject: middle, read: current })).toEqual({ ok: true, anchor: root })
}
it('schedules a parent child and its leaf in the root parent worktree without a middle branch', async () => {
  const { principal, cwd, request, operations, parent } = await parentFixture(undefined, true)
  const middle = { repository: 'acme/app', target: 'acme/app#2' }
  const leaf = { repository: 'acme/app', target: 'acme/app#5' }
  const initialTrees = git(principal, ['worktree', 'list', '--porcelain'])
  const initialRefs = git(principal, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'])
  const rootIntent = await coverageIntent(request)
  const rootResult = await continueFeature({ ...request, ...rootIntent })
  const rootRead = await operations.readUw(parent)
  expect(rootRead.accepted.status, JSON.stringify(rootResult)).toBe('accepted')
  if (rootRead.accepted.status !== 'accepted') throw new Error('Root parent mandate unavailable')
  expect((await operations.readUw(middle)).accepted.status).toBe('absent')
  expect((await operations.readUw(leaf)).accepted.status).toBe('absent')
  const effects = driverEffects(operations)
  const scheduled = await withEpicEffects(effects, () => continueFeature({ ...request, control: 'continue' }))
  if (scheduled.kind !== 'blocked' || !scheduled.coverageRequest) throw new Error(JSON.stringify(scheduled))
  expect(scheduled.coverageRequest.parent.uw).toEqual(middle)
  expect(git(cwd, ['branch', '--show-current'])).toBe('')
  expect(git(principal, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'])).toBe(initialRefs)
  const middleChildren: [Scope] = [leaf]
  const middleIntent = {
    parentCoverageBasis: scheduled.coverageRequest,
    parentCoverage: {
      parent: scheduled.coverageRequest.parent,
      assignments: scheduled.coverageRequest.criteria.map((criterion) => ({
        criterion: criterionIdSchema.parse(criterion.id),
        children: middleChildren,
      })),
    },
  }
  const middleRequest = { ...request, reference: '#2', control: 'continue' as const }
  const middleResult = await withEpicEffects(heldEpicStep(operations), () =>
    continueFeature({ ...middleRequest, ...middleIntent }),
  )
  const middleRead = await operations.readUw(middle)
  expect(middleRead.accepted.status, JSON.stringify(middleResult)).toBe('accepted')
  if (middleRead.accepted.status !== 'accepted') throw new Error('Nested parent mandate unavailable')
  const middleAccepted = middleRead.accepted.value
  const middleMandate = middleRead.histories
    .flatMap((history) => history.operations)
    .find(
      (operation) =>
        operation.record?.kind === 'mandate' &&
        operation.record.recordId === middleAccepted.ref.sourceAccepted.recordId,
    )?.record
  if (middleMandate?.kind !== 'mandate') throw new Error('Nested parent mandate not confirmed')
  expect(middleMandate.payload.branch).toBeNull()
  expect(middleAccepted.inheritedOwnSpecRefs[0]).toEqual(rootRead.accepted.value.ref)
  expect((await operations.readUw(leaf)).accepted.status).toBe('absent')
  expect(git(cwd, ['branch', '--show-current'])).toBe('')
  expect(git(principal, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'])).toBe(initialRefs)
  await exerciseMiddleAnchorPresentation(operations, parent, middle)
  const leafResult = await withEpicEffects(effects, () => continueFeature(middleRequest))
  const leafRead = await operations.readUw(leaf)
  expect(leafRead.accepted.status, JSON.stringify(leafResult)).toBe('accepted')
  if (leafRead.accepted.status !== 'accepted') throw new Error('Nested leaf mandate unavailable')
  const leafAccepted = leafRead.accepted.value
  expect(leafAccepted.inheritedOwnSpecRefs[0]).toEqual(middleAccepted.ref)
  const leafMandate = leafRead.histories
    .flatMap((history) => history.operations)
    .find(
      (operation) =>
        operation.record?.kind === 'mandate' && operation.record.recordId === leafAccepted.ref.sourceAccepted.recordId,
    )?.record
  if (leafMandate?.kind !== 'mandate') throw new Error('Nested leaf mandate not confirmed')
  expect(leafMandate.payload.branch).toBe(git(cwd, ['branch', '--show-current']))
  expect(leafMandate.payload.branch).not.toBeNull()
  expect(git(principal, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(
    initialTrees.match(/^worktree /gm)?.length ?? 0,
  )
  expect(Object.keys(readSim().prs)).toHaveLength(0)
})

it('resolves a never-dispatched nested Parent without Git reconciliation', async () => {
  const { cwd, request, operations, parent } = await parentFixture(undefined, true)
  const middle = { repository: 'acme/app', target: 'acme/app#2' }
  const leaf = { repository: 'acme/app', target: 'acme/app#5' }
  const rootIntent = await coverageIntent(request)
  await continueFeature({ ...request, ...rootIntent })
  const scheduled = await withEpicEffects(driverEffects(operations), () =>
    continueFeature({ ...request, control: 'continue' }),
  )
  if (scheduled.kind !== 'blocked' || !scheduled.coverageRequest) throw new Error(JSON.stringify(scheduled))
  const middleRequest = { ...request, reference: '#2', control: 'continue' as const }
  const middleIntent = {
    parentCoverageBasis: scheduled.coverageRequest,
    parentCoverage: {
      parent: scheduled.coverageRequest.parent,
      assignments: scheduled.coverageRequest.criteria.map((criterion) => ({
        criterion: criterionIdSchema.parse(criterion.id),
        children: [leaf] as [Scope],
      })),
    },
  }
  await withEpicEffects(heldEpicStep(operations), () => continueFeature({ ...middleRequest, ...middleIntent }))
  const read = await operations.readUw(middle)
  expect(await resolveParentWorktreeAnchor({ subject: middle, read })).toEqual({ ok: true, anchor: parent })
  if (read.accepted.status !== 'accepted') throw new Error('Nested Parent mandate unavailable')
  const mandateId = read.accepted.value.ref.sourceAccepted.recordId
  const mandate = read.histories
    .flatMap((history) => history.operations)
    .find((operation) => operation.record?.kind === 'mandate' && operation.record.recordId === mandateId)?.record
  if (mandate?.kind !== 'mandate') throw new Error('Nested Parent mandate record unavailable')
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const code = { repository: middle.repository, base: head, head, referenceCommit: head }
  const { workflow: fixtures } = authenticatedPlanFixtures(mandate, read.histories, undefined, undefined, code)
  const implement = fixtures.implementStart(mandate)
  if (implement.payload.phase !== 'start' || implement.payload.action !== 'implement')
    throw new Error('Invalid implement START fixture')
  const exactInputs = { mandateId: mandate.recordId, planActionId: 'act-plan-1' }
  const manifest = {
    ...implement.payload.inputs.manifest,
    purpose: 'integrate' as const,
    operands: { action: 'integrate' as const, exactInputs },
  }
  const start = buildRecord({
    ...implement,
    recordId: 'act-integrate-1-start',
    operationId: 'op-act-integrate-1-start',
    payload: {
      ...implement.payload,
      action: 'integrate',
      actionId: 'act-integrate-1',
      exactInputs,
      inputs: { ...implement.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) },
    },
  })
  if (!start.ok) throw new Error('Invalid integrate START')
  const pause = fixtures.pauseRequested(mandate)
  const plan = eligiblePlanAt(mandate, head, read.histories).filter((record) => record.kind !== 'mandate')
  const records = [...plan, start.value, pause, fixtures.pauseConfirmed(mandate, pause)]
  for (const record of records) {
    const fresh = await operations.readUw(middle)
    const own = fresh.histories.find((history) => history.source.scope.target === middle.target)
    if (!own) throw new Error('Missing nested Parent history')
    const encoded = encodeRecord(
      record,
      own.source,
      null,
      fresh.histories.filter((history) => history !== own),
    )
    if (!encoded.ok) throw new Error(`Cannot encode fixture record: ${JSON.stringify(encoded.diagnostics)}`)
    writeSim((state) => {
      const issue = state.issues['2']
      if (!issue) throw new Error('Missing nested Parent')
      issue.comments.push(...encoded.value.map((body) => ({ author: 'operator', body })))
    })
  }
  const prompts: unknown[] = []
  const operator: OperatorPort = {
    async executeConfirmed(prepared, action) {
      prompts.push(prepared)
      return {
        status: 'confirmed',
        value: await action({
          route: 'omp-native-command',
          operationId: prepared.proposal.operationId,
          proposalDigest: prepared.digest,
          confirmedAt: '2026-11-14T12:00:00.000Z',
        }),
      }
    },
  }
  const uw = await createInstalledUwOperations({ cwd, readAuthor: 'operator', gh: request.gh, operator })
  recordStartNotActivated({ scope: middle, recordId: start.value.recordId, kind: 'action-receipt' })
  const result = await continueFeature({ ...middleRequest, control: 'resolve-interruption', uw })
  expect(result).toEqual({ kind: 'paused', confirmed: true, reason: 'interruption-resolved' })
  expect(prompts).toHaveLength(1)
  expect(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
  expect(git(cwd, ['status', '--porcelain'])).toBe('')
  expect(cwd).toContain('parents/acme-1')
})
