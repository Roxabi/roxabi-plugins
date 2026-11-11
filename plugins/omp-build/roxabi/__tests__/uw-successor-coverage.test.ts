import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { withEpicEffects } from '../../skills/feature/epic-driver-runtime.ts'
import { selectFeatureMandate } from '../feature-continuation-selection.ts'
import { continueFeature } from '../workflow.ts'
import { reframedParent, reframedStatement } from './uw-successor-parent-fixtures.ts'
import { proposal, scope, selectNew } from './uw-successor-selection-support.ts'

const bootstrap = vi.hoisted(() => ({ after: async () => {} }))
vi.mock('../workflow-checkout.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workflow-checkout.ts')>()),
  runWorktreeBootstrap: async () => {
    await bootstrap.after()
    return { ok: true }
  },
}))
beforeEach(() => {
  vi.stubEnv('OMP_WORKTREE_DIR', '/fixture-worktrees')
  bootstrap.after = async () => {}
})
afterEach(() => {
  vi.unstubAllEnvs()
})

test('the real continuation consumes successor coverage before its next Parent observation', async () => {
  const subject = await reframedParent()
  const { request, coverage } = await coveragePrompt(subject)
  const result = await withEpicEffects(
    {
      gh: () => {
        throw new Error('fixture epic transport unavailable')
      },
    },
    () =>
      continueFeature({
        cwd: subject.authority.context.cwd,
        reference: scope.target,
        control: 'new',
        principal: false,
        git: subject.authority.context.git,
        gh: subject.authority.context.gh,
        read: subject.reader,
        parentCoverage: coverage,
        parentCoverageBasis: request,
      }),
  )
  expect(result).toMatchObject({ kind: 'blocked', reason: 'epic-step-failed' })
  const after = await subject.reader.readUw(scope)
  expect(after.accepted).toMatchObject({
    status: 'accepted',
    value: {
      ref: { version: request.parent.version },
      children: subject.original.payload.children,
      inheritedOwnSpecRefs: subject.original.payload.inheritedOwnSpecRefs,
      coverage,
    },
  })
  if (after.accepted.status !== 'accepted') throw new Error('Expected the published successor')
  expect(after.accepted.value.ref.sourceAccepted.recordId).not.toBe(subject.original.recordId)
})

test('a principal-checkout coverage request prepares the canonical Parent handoff without publication', async () => {
  const subject = await reframedParent()
  subject.gitReplies.set('rev-parse --show-toplevel', '/principal')
  subject.gitReplies.set('branch --show-current', 'main')
  subject.gitReplies.set(
    '/fixture-worktrees/app/parents/acme-41\0rev-parse --show-toplevel',
    '/fixture-worktrees/app/parents/acme-41',
  )
  subject.gitReplies.set('/fixture-worktrees/app/parents/acme-41\0branch --show-current', 'feature/bounded')
  const result = await continueFeature({
    cwd: '/principal',
    reference: scope.target,
    control: 'new',
    principal: true,
    git: subject.authority.context.git,
    gh: subject.authority.context.gh,
    read: subject.reader,
  })
  expect(result).toMatchObject({ kind: 'session-cwd', path: '/fixture-worktrees/app/parents/acme-41' })
  expect(subject.native.writes).toEqual([])
})

async function coveragePrompt(subject: Awaited<ReturnType<typeof reframedParent>>) {
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked', reason: 'parent-coverage-intent-required' })
  if (!('kind' in result) || result.kind !== 'blocked' || result.coverageRequest === undefined)
    throw new Error(`Expected successor coverage request: ${JSON.stringify(result)}`)
  const historicalCoverage = subject.original.payload.coverage
  if (historicalCoverage === null) throw new Error('Expected historical Parent coverage')
  return { request: result.coverageRequest, coverage: { ...historicalCoverage, parent: result.coverageRequest.parent } }
}

test('a reframed Parent prompts against its authenticated history then consumes approved fresh coverage', async () => {
  const subject = await reframedParent()
  let bootstrapped = false
  bootstrap.after = async () => {
    bootstrapped = true
  }
  const { request, coverage } = await coveragePrompt(subject)
  const prior = { scope, recordId: subject.original.recordId, kind: 'mandate' }
  expect(request.accepted).toEqual({
    own: { uw: scope, version: subject.original.payload.ownSpec.version, sourceAccepted: prior },
    metadata: prior,
  })
  expect(request.parent.version).not.toBe(subject.original.payload.ownSpec.version)
  expect(subject.native.writes).toEqual([])
  expect(bootstrapped).toBe(false)
  const result = await selectFeatureMandate(
    'new',
    undefined,
    subject.authority,
    undefined,
    subject.reader,
    coverage,
    request,
  )
  expect(result).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    mandate: {
      payload: {
        antecedent: prior,
        children: subject.original.payload.children,
        coverage,
        ownSpec: {
          version: request.parent.version,
          snapshot: { spec: { criteria: [{ id: 'C1', statement: reframedStatement }] } },
        },
      },
    },
  })
  const after = await subject.reader.readUw(scope)
  expect(after.admission).toMatchObject({ applicability: 'resolved', deliverable: { ok: true } })
})

test('an initial-absence basis cannot approve historical successor coverage', async () => {
  const subject = await reframedParent()
  const { request, coverage } = await coveragePrompt(subject)
  const result = await selectFeatureMandate('new', undefined, subject.authority, undefined, subject.reader, coverage, {
    ...request,
    accepted: null,
  })
  expect(result).toMatchObject({ kind: 'blocked', reason: 'parent-coverage-intent-changed', coverageRequest: request })
  expect(subject.native.writes).toEqual([])
})

test('coverage changed during bootstrap refuses the successor before publication', async () => {
  const subject = await reframedParent()
  const { request, coverage } = await coveragePrompt(subject)
  bootstrap.after = async () => {
    const issue = subject.native.issues.get(41)
    if (!issue) throw new Error('missing Parent issue')
    issue.body = renderIssueSpecBody(proposal('Coordinate a newly changed Parent outcome during bootstrap.'), {
      complexity: 2,
    })
  }
  const result = await selectFeatureMandate(
    'new',
    undefined,
    subject.authority,
    undefined,
    subject.reader,
    coverage,
    request,
  )
  expect(result).toMatchObject({ kind: 'blocked', reason: 'parent-coverage-intent-changed' })
  expect(subject.native.writes).toEqual([])
})

test('a stale proposed version cannot approve successor coverage', async () => {
  const subject = await reframedParent()
  const { request, coverage } = await coveragePrompt(subject)
  const issue = subject.native.issues.get(41)
  if (!issue) throw new Error('missing Parent issue')
  issue.body = renderIssueSpecBody(proposal('Coordinate a later proposed Parent outcome.'), { complexity: 2 })
  const result = await selectFeatureMandate(
    'new',
    undefined,
    subject.authority,
    undefined,
    subject.reader,
    coverage,
    request,
  )
  expect(result).toMatchObject({ kind: 'blocked', reason: 'parent-coverage-intent-changed' })
  if (!('kind' in result) || result.kind !== 'blocked' || result.coverageRequest === undefined)
    throw new Error('Expected a refreshed coverage request')
  expect(result.coverageRequest.parent.version).not.toBe(request.parent.version)
  expect(subject.native.writes).toEqual([])
})

test('successor coverage must actually cover every retained Parent criterion', async () => {
  const subject = await reframedParent()
  const { request, coverage } = await coveragePrompt(subject)
  const result = await selectFeatureMandate(
    'new',
    undefined,
    subject.authority,
    undefined,
    subject.reader,
    { ...coverage, assignments: [] },
    request,
  )
  expect(result).toMatchObject({ kind: 'blocked', reason: 'parent-coverage-intent-invalid' })
  expect(subject.native.writes).toEqual([])
})
