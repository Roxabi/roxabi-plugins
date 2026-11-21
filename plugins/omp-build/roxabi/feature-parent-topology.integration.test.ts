import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { selectApplicableMandate } from '../dist/contracts.js'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { withEpicEffects } from '../skills/feature/epic-driver-runtime.ts'
import { A, B, C, EPIC } from '../skills/feature/testing/goal/goal-scenario-domain.ts'
import { dispose, git, readSim, writeSim } from '../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import {
  coverageIntent,
  driverEffects,
  editedBeforeLiveEpicStep,
  heldEpicStep,
  observeInitialChild,
  parentFixture,
} from '../testing/feature-parent-topology-fixture.ts'
import { checkPlannedAncestry } from './feature-parent-anchor.ts'
import { specEntrySelection } from './feature-selection-spec-entry.ts'
import { continueFeature } from './workflow.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

it('routes a legacy issue to assisted framing at initial selection', async () => {
  const { operations, child } = await parentFixture()
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing child issue')
    issue.body = 'Legacy source requiring an accounted conversion.'
  })
  const read = await operations.readUw(child)
  if (read.observation.status !== 'complete') throw new Error('Expected complete observation')
  const history = read.histories.find((entry) => entry.source.scope.target === child.target)
  if (!history) throw new Error('Expected own history')
  const selection = selectApplicableMandate(
    history,
    read.histories.filter((entry) => entry !== history),
    {
      histories: read.histories,
      catalogues: read.catalogues,
      observation: read.observation,
    },
  )
  expect(specEntrySelection('select', { scope: child, selection }, read)).toEqual({
    kind: 'framing',
    source: { kind: 'issue', uw: child },
  })
})

it('keeps an unmandated accepted child ready after presentation-only native editing', async () => {
  const { operations, parent, child, request } = await parentFixture()
  const beforeParent = await observeInitialChild(operations, parent, child)
  if (beforeParent.child.parsed.status !== 'conformant') throw new Error('Expected conformant child Spec')
  expect(
    await checkPlannedAncestry({
      subject: child,
      read: beforeParent.child,
      planned: { spec: beforeParent.child.parsed.snapshot.spec, tier: 'S' },
    }),
  ).toEqual({ ok: false, reason: 'current-inheritance-unavailable' })
  const intent = await coverageIntent(request)
  await withEpicEffects(heldEpicStep(operations), () => continueFeature({ ...request, ...intent }))
  const baseline = await observeInitialChild(operations, parent, child)
  expect(baseline.parent.accepted.status).toBe('accepted')
  expect(baseline.child.accepted.status).toBe('absent')
  expect(baseline.readiness).toEqual({ status: 'ready' })
  if (baseline.child.parsed.status !== 'conformant') throw new Error('Expected conformant child Spec')
  const original = baseline.child.parsed.snapshot
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
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing child issue')
    Object.assign(issue, {
      body: renderIssueSpecBody(material.value, { complexity: 1 }),
      updatedAt: '2026-01-02T00:00:00Z',
    })
  })
  expect((await observeInitialChild(operations, parent, child)).readiness.status).toBe('held')
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing child issue')
    Object.assign(issue, { body: original.raw.body, labels: ['size:S'] })
  })
  expect((await observeInitialChild(operations, parent, child)).readiness.status).toBe('held')
  writeSim((state) => {
    const issue = state.issues[String(A)]
    if (!issue) throw new Error('Missing child issue')
    Object.assign(issue, { body: `${original.raw.body}\n`, labels: ['size:F-lite'], updatedAt: '2026-01-03T00:00:00Z' })
  })
  const current = await observeInitialChild(operations, parent, child)
  expect(current.child.accepted.status).toBe('absent')
  if (current.child.parsed.status !== 'conformant') throw new Error('Expected conformant presentation edit')
  expect(current.child.parsed.snapshot.spec.version).toBe(original.spec.version)
  expect(current.child.parsed.snapshot.raw.bodySha256).not.toBe(original.raw.bodySha256)
  expect(current.child.parsed.snapshot.raw.lastEditedAt).toBe('2026-01-03T00:00:00Z')
  expect(current.readiness).toEqual({ status: 'ready' })
})

it('publishes the first parent and child mandates in the same real parent checkout', async () => {
  const { before, cwd, operations, parent, child, request } = await parentFixture()
  expect(git(cwd, ['branch', '--show-current'])).toBe('')
  expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(before)
  expect(existsSync(join(git(cwd, ['rev-parse', '--git-dir']), 'omp-build-bootstrapped'))).toBe(false)
  for (const number of [EPIC, A, B, C]) {
    expect(readSim().issues[String(number)]?.comments.some((comment) => comment.body.includes('kind=mandate'))).toBe(
      false,
    )
  }
  // This is a new invocation at the destination, not evidence of a native /move.
  const intent = await coverageIntent(request)
  const effects = driverEffects(operations)
  const acceptedResult = await withEpicEffects(effects, () => continueFeature({ ...request, ...intent }))
  const accepted = await operations.readUw(parent)
  expect(accepted.accepted.status, JSON.stringify(acceptedResult)).toBe('accepted')
  // The first Mandate consumes the confirmed coverage; the same call must not ask for it again.
  expect(acceptedResult).not.toMatchObject({ reason: expect.stringMatching(/^parent-coverage/) })
  if (accepted.accepted.status !== 'accepted') throw new Error('Parent mandate not confirmed')
  const parentAccepted = accepted.accepted.value
  const mandate = accepted.histories
    .flatMap((history) => history.operations)
    .find(
      (operation) =>
        operation.record?.kind === 'mandate' &&
        operation.record.recordId === parentAccepted.ref.sourceAccepted.recordId,
    )?.record
  if (mandate?.kind !== 'mandate') throw new Error('Confirmed parent mandate unavailable')
  expect(mandate.payload.branch).toBeNull()
  expect(mandate.payload.lineageHead).toBe(before)
  // The first Parent Mandate consumed the confirmed coverage; the same call continues into child activation.
  const childRead = await operations.readUw(child)
  expect(childRead.accepted.status, JSON.stringify(acceptedResult)).toBe('accepted')
  if (childRead.accepted.status !== 'accepted') throw new Error('Child mandate not confirmed')
  const childAccepted = childRead.accepted.value
  expect(childAccepted.inheritedOwnSpecRefs[0]).toEqual(parentAccepted.ref)
  const childMandate = childRead.histories
    .flatMap((history) => history.operations)
    .find(
      (operation) =>
        operation.record?.kind === 'mandate' && operation.record.recordId === childAccepted.ref.sourceAccepted.recordId,
    )?.record
  if (childMandate?.kind !== 'mandate') throw new Error('Confirmed child mandate unavailable')
  expect(childMandate.payload.branch).toBe(git(cwd, ['branch', '--show-current']))
  expect(childMandate.payload.branch).not.toBeNull()
  expect(git(cwd, ['rev-parse', '--show-toplevel'])).toBe(cwd)
})

it('refuses the first parent mandate if its canonical worktree is attached', async () => {
  const { cwd, request, operations, parent } = await parentFixture()
  const intent = await coverageIntent(request)
  git(cwd, ['switch', '-c', 'unexpected-attached-parent'])
  const result = await continueFeature({ ...request, ...intent })
  expect(result).toMatchObject({ kind: 'blocked', reason: 'parent-checkout-not-detached' })
  expect(git(cwd, ['branch', '--show-current'])).toBe('unexpected-attached-parent')
  expect((await operations.readUw(parent)).accepted.status).toBe('absent')
  expect(existsSync(join(git(cwd, ['rev-parse', '--git-dir']), 'omp-build-bootstrapped'))).toBe(false)
})

it('does not publish the first parent mandate when the real worktree setup fails', async () => {
  const { cwd, request, operations, parent } = await parentFixture('exit 43')
  const intent = await coverageIntent(request)
  const result = await continueFeature({ ...request, ...intent })
  expect(result.kind).toBe('blocked')
  if (result.kind !== 'blocked') throw new Error(JSON.stringify(result))
  expect(result.reason).toMatch(/^bootstrap-failed:/)
  expect((await operations.readUw(parent)).accepted.status).toBe('absent')
  expect(existsSync(join(git(cwd, ['rev-parse', '--git-dir']), 'omp-build-bootstrapped'))).toBe(false)
})

it('refuses stale parent framing changed during the real worktree setup', async () => {
  const mutation = `bun -e 'const fs=require("node:fs"); const p=process.env.GH_SIM_STATE; const s=JSON.parse(fs.readFileSync(p,"utf8")); s.issues["1"].body=s.issues["1"].body.replace("delivered","changed during setup"); s.issues["1"].updatedAt="2026-01-02T00:00:00Z"; fs.writeFileSync(p,JSON.stringify(s))'`
  const { cwd, request, operations, parent } = await parentFixture(mutation)
  const intent = await coverageIntent(request)
  const result = await continueFeature({ ...request, ...intent })
  expect(result.kind).toBe('blocked')
  expect(readSim().issues[String(EPIC)]?.body).toContain('changed during setup')
  expect((await operations.readUw(parent)).accepted.status).toBe('absent')
  expect(existsSync(join(git(cwd, ['rev-parse', '--git-dir']), 'omp-build-bootstrapped'))).toBe(true)
})

it('preserves the dirty active child in the same parent worktree', async () => {
  const { cwd, request, operations, parent, child } = await parentFixture()
  const intent = await coverageIntent(request)
  const established = await continueFeature({ ...request, ...intent })
  expect((await operations.readUw(parent)).accepted.status, JSON.stringify(established)).toBe('accepted')
  const effects = driverEffects(operations)
  const activated = await withEpicEffects(effects, () => continueFeature({ ...request, control: 'continue' }))
  expect((await operations.readUw(child)).accepted.status, JSON.stringify(activated)).toBe('accepted')
  const branch = git(cwd, ['branch', '--show-current'])
  expect(branch).not.toBe('')
  const file = join(cwd, 'uncommitted-child-work.txt')
  writeFileSync(file, 'preserve child work\n')
  await withEpicEffects(effects, () => continueFeature({ ...request, control: 'continue' }))
  expect(git(cwd, ['branch', '--show-current'])).toBe(branch)
  expect(readFileSync(file, 'utf8')).toBe('preserve child work\n')
  expect(git(cwd, ['status', '--porcelain'])).toContain('uncommitted-child-work.txt')
})

it('does not establish a child mandate from an ancestor whose framing has changed', async () => {
  const { request, operations, parent, child } = await parentFixture()
  const intent = await coverageIntent(request)
  const established = await withEpicEffects(heldEpicStep(operations), () => continueFeature({ ...request, ...intent }))
  expect((await operations.readUw(parent)).accepted.status, JSON.stringify(established)).toBe('accepted')
  writeSim((state) => {
    const ancestor = state.issues[String(EPIC)]
    if (!ancestor) throw new Error('Missing parent')
    ancestor.body = ancestor.body.replace('delivered', 'changed ancestor obligation')
  })
  const effects = driverEffects(operations)
  const result = await withEpicEffects(effects, () => continueFeature({ ...request, control: 'continue' }))
  expect(result.kind).toBe('blocked')
  expect((await operations.readUw(child)).accepted.status).toBe('absent')
})

it('holds a live Epic step that is not a child to start instead of ending the Epic', async () => {
  const { cwd, request, operations, parent, child } = await parentFixture()
  const intent = await coverageIntent(request)
  const established = await withEpicEffects(heldEpicStep(operations), () => continueFeature({ ...request, ...intent }))
  expect((await operations.readUw(parent)).accepted.status, JSON.stringify(established)).toBe('accepted')
  const result = await withEpicEffects(editedBeforeLiveEpicStep(operations), () =>
    continueFeature({ ...request, control: 'continue' }),
  )
  expect(result, JSON.stringify(result)).toMatchObject({
    kind: 'blocked',
    reason: 'epic-drop:dirty-tree',
    next: 'feature-reentry',
    diagnostics: [{ code: 'epic-drop', message: expect.stringContaining('dirty') }],
  })
  // The hold starts no child work; the unreported drop is left to the engine's next run.
  expect((await operations.readUw(child)).accepted.status).toBe('absent')
  expect(git(cwd, ['branch', '--show-current'])).toBe('')
})
