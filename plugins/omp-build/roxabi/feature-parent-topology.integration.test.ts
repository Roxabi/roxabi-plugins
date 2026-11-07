import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { selectApplicableMandate } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { criterionIdSchema } from '../engine/uw-spec-schema.ts'
import { withEpicEffects } from '../skills/feature/epic-driver-runtime.ts'
import { initialMandateReadiness } from '../skills/feature/epic-initial-mandate.ts'
import { A, B, C, EPIC } from '../skills/feature/testing/goal/goal-scenario-domain.ts'
import {
  dispose,
  git,
  moduleGh,
  readSim,
  sandbox,
  writeSim,
} from '../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { checkPlannedAncestry, resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { selectionNormalization } from './feature-selection-normalization.ts'
import { prepareCanonicalCheckout } from './prepare-canonical-checkout.ts'
import type { UwOperations } from './uw-contract.ts'
import { createInstalledUwOperations } from './uw-installed-operations.ts'
import { continueFeature } from './workflow.ts'
import type { GitRunner } from './workflow-checkout.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

async function parentFixture(setup?: string, nested = false) {
  const world = sandbox()
  for (const key of ['PATH', 'HOME', 'GH_SIM_STATE', 'GH_SIM_ORIGIN'] as const) {
    const value = world.env[key]
    if (value !== undefined) vi.stubEnv(key, value)
  }
  vi.stubEnv('OMP_WORKTREE_DIR', join(world.root, 'checkouts'))
  const { framedBodies, identityAllocation } = roxabiWorkflowFixtures()
  writeSim((state) => {
    if (nested) {
      const middle = state.issues[String(A)]
      if (!middle) throw new Error('Missing nested parent')
      state.issues['5'] = Object.assign({}, middle, { number: 5, comments: [], subIssues: [], blockedBy: [] })
      middle.subIssues = [5]
    }
    for (const number of nested ? [EPIC, A, B, C, 5] : [EPIC, A, B, C]) {
      const issue = state.issues[String(number)]
      if (!issue) throw new Error(`missing issue ${number}`)
      const scope = { repository: 'acme/app', target: `acme/app#${number}` }
      issue.comments.push(
        ...framedBodies([identityAllocation(scope)], 'operator').map((body) => ({ author: 'operator', body })),
      )
    }
  })
  const gh = async (_cwd: string, args: string[]) => {
    const result = moduleGh(args)
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const gitPort: GitRunner = async (cwd, args) => {
    try {
      return { code: 0, stdout: git(cwd, args), stderr: '' }
    } catch (error) {
      return { code: 1, stdout: '', stderr: String(error) }
    }
  }
  const principal = join(world.root, 'principal')
  if (setup !== undefined) {
    const stack = join(principal, '.dev', 'stack.yml')
    const existing = readFileSync(stack, 'utf8')
    if (!existing.startsWith('worktree:\n')) throw new Error('Fixture worktree configuration is missing')
    writeFileSync(stack, existing.replace('worktree:\n', `worktree:\n  setup: ${JSON.stringify(setup)}\n`))
    git(principal, ['add', '.dev/stack.yml'])
    git(principal, ['commit', '-qm', 'configure worktree setup'])
    git(principal, ['push', '-q', 'origin', 'main'])
  }
  git(world.origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const before = git(principal, ['rev-parse', 'HEAD'])
  const prepared = await prepareCanonicalCheckout({ reference: '#1', sessionCwd: principal, gh, git: gitPort })
  if (prepared.status !== 'move') throw new Error(JSON.stringify(prepared))
  const cwd = prepared.path
  if (cwd === world.epic) throw new Error('Adopted unrelated worktree')
  const operator = {
    async executeConfirmed(): Promise<never> {
      throw new Error('Unexpected operator-only UW mutation')
    },
  }
  const operations = await createInstalledUwOperations({ cwd, readAuthor: 'operator', gh, operator })
  const parent = { repository: 'acme/app', target: 'acme/app#1' }
  const child = { repository: 'acme/app', target: 'acme/app#2' }
  const request = {
    cwd,
    reference: '#1',
    control: 'select' as const,
    principal: false,
    git: gitPort,
    gh,
    uw: operations,
  }
  return { world, principal, before, cwd, operations, parent, child, request }
}

function driverEffects(operations: UwOperations) {
  return {
    git: (directory: string, args: string[]) => git(directory, args),
    gh: (_directory: string, args: string[], input?: string) => {
      const result = moduleGh(args, input)
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout
    },
    uw: operations,
    uwReadAuthor: 'operator',
  }
}

/** Epic effects that refuse the driver's first GitHub read, stopping the call after its own first Mandate. */
function heldEpicStep(operations: UwOperations) {
  return {
    ...driverEffects(operations),
    gh: (): string => {
      throw new Error('fixture holds the epic step')
    },
  }
}

async function coverageIntent(request: Parameters<typeof continueFeature>[0]) {
  const pending = await continueFeature(request)
  if (pending.kind !== 'blocked' || !pending.coverageRequest) throw new Error(JSON.stringify(pending))
  const [firstChild, ...remainingChildren] = pending.coverageRequest.children
  if (firstChild === undefined) throw new Error('Parent has no committed children')
  const childScopes: [Scope, ...Scope[]] = [firstChild.scope, ...remainingChildren.map((entry) => entry.scope)]
  return {
    parentCoverageBasis: pending.coverageRequest,
    parentCoverage: {
      parent: pending.coverageRequest.parent,
      assignments: pending.coverageRequest.criteria.map((criterion) => ({
        criterion: criterionIdSchema.parse(criterion.id),
        children: childScopes,
      })),
    },
  }
}

async function observeInitialChild(operations: UwOperations, parent: Scope, child: Scope) {
  const parentRead = await operations.readUw(parent)
  if (!parentRead.observedReader) throw new Error('Expected same-cut observed reader')
  const childRead = await parentRead.observedReader.readUw(child)
  return {
    parent: parentRead,
    child: childRead,
    readiness: await initialMandateReadiness(parentRead, parentRead.admission, childRead),
  }
}
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
  expect(selectionNormalization('select', { scope: child, selection }, read)).toEqual({
    kind: 'framing',
    source: { kind: 'issue', uw: child },
  })
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
