import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { resolveSpecEffective } from '../../dist/contracts.js'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { selectFeatureMandate } from '../feature-continuation-selection.ts'
import {
  abandonedNestedLeaf,
  abandonedNestedParent,
  abandonedNestedSiblings,
  abandonedParent,
  revokedNestedLeaf,
} from './uw-successor-parent-fixtures.ts'
import {
  abandonedLeaf,
  branch,
  child,
  fixtureOwnSpec,
  head,
  proposal,
  scope,
  selectNew,
  sibling,
} from './uw-successor-selection-support.ts'

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

test('explicit new publishes an authenticated successor without renewing its abandoned antecedent', async () => {
  const subject = await abandonedLeaf()
  expect(subject.authority.selection).toMatchObject({ status: 'refused', reason: 'abandoned' })
  expect(subject.before.accepted.status).toBe('refused')
  const priorFrames = subject.native.comments.get(41)?.map((comment) => comment.body)
  const result = await selectNew(subject)
  expect(result).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    mandate: {
      payload: {
        antecedent: { scope, recordId: subject.original.recordId, kind: 'mandate' },
        base: subject.original.payload.base,
        parent: subject.original.payload.parent,
        permissions: subject.original.payload.permissions,
        branch,
        lineageHead: head,
      },
    },
  })
  if ('kind' in result || result.mandate === null) throw new Error('explicit new did not select its successor')
  expect(result.mandate.recordId).not.toBe(subject.original.recordId)
  const after = await subject.reader.readUw(scope)
  expect(after.accepted.status).toBe('accepted')
  expect(
    subject.native.comments
      .get(41)
      ?.slice(0, priorFrames?.length)
      .map((comment) => comment.body),
  ).toEqual(priorFrames)
  expect(subject.engine.selectApplicableMandate(subject.authority.history, [], subject.authority.causal)).toMatchObject(
    { status: 'refused', reason: 'abandoned' },
  )
})

test('explicit new accepts a fresh own proposal rather than pinning the entire historical proposal', async () => {
  const statement = 'Preserve requests and expose their authorized outcome.'
  const subject = await abandonedLeaf(({ native }) => {
    const issue = native.issues.get(41)
    if (!issue) throw new Error('missing fixture issue')
    issue.body = renderIssueSpecBody(proposal(statement), { complexity: 2 })
  })
  const result = await selectNew(subject)
  expect(result).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    acceptedSpec: { snapshot: { spec: { criteria: [{ id: 'C1', statement }] } } },
  })
})

test('an edited abandon control cannot authorize a successor', async () => {
  const subject = await abandonedLeaf((world) => {
    for (const part of world.parts(world.abandonment)) part.updated_at = '2026-10-28T00:00:00Z'
  })
  expect(subject.authority.selection.status).toBe('refused')
  const result = await selectNew(subject)
  expect(result).toMatchObject({ authority: { selection: { status: 'refused' } }, mandate: null, acceptedSpec: null })
  expect(subject.native.writes).toEqual([])
})

test('an unauthorized later mandate cannot hijack the authenticated antecedent or checkout', async () => {
  const subject = await abandonedLeaf((world) => {
    const foreign = roxabiWorkflowFixtures().featureMandate(scope, {
      recordId: 'foreign-last',
      operationId: 'foreign-operation',
      ownSpec: fixtureOwnSpec(world.original.payload.ownSpec),
      branch: 'foreign/branch',
    })
    world.seed(foreign, 'outsider')
  })
  const result = await selectNew(subject)
  expect(result).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    mandate: { payload: { antecedent: { recordId: subject.original.recordId }, branch } },
  })
})

test('a proposal changed during bootstrap refuses before successor publication', async () => {
  const subject = await abandonedLeaf()
  bootstrap.after = async () => {
    const issue = subject.native.issues.get(41)
    if (!issue) throw new Error('missing fixture issue')
    issue.body = renderIssueSpecBody(proposal('Change the proposal while checkout bootstrap is running.'), {
      complexity: 2,
    })
  }
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})

test('a checkout changed during bootstrap refuses before successor publication', async () => {
  const subject = await abandonedLeaf()
  bootstrap.after = async () => {
    subject.gitReplies.set('rev-parse --verify HEAD', 'd'.repeat(40))
  }
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})

test('ordinary resume does not renew an abandoned mandate', async () => {
  const subject = await abandonedLeaf()
  const result = await selectFeatureMandate('resume', undefined, subject.authority, undefined, subject.reader)
  expect(result).toMatchObject({
    authority: { selection: { status: 'refused', reason: 'abandoned' } },
    mandate: null,
    acceptedSpec: null,
  })
  expect(subject.native.writes).toEqual([])
})

test('a Parent successor retains its unmanaged child commitments and has usable current engagement', async () => {
  const subject = await abandonedParent()
  const result = await selectNew(subject)
  expect(result).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    mandate: {
      payload: {
        antecedent: { scope, recordId: subject.original.recordId, kind: 'mandate' },
        children: subject.original.payload.children,
        coverage: subject.original.payload.coverage,
      },
    },
  })
  const after = await subject.reader.readUw(scope)
  expect(after.admission).toMatchObject({ applicability: 'resolved', deliverable: { ok: true } })
  if (after.accepted.status !== 'accepted') throw new Error('Parent successor did not establish accepted framing')
  expect(
    resolveSpecEffective({
      mode: 'current',
      own: after.accepted.value.ref,
      histories: after.histories,
      graph: after.graph,
    }),
  ).toMatchObject({ ok: true })
})

test.each(['active', 'abandoned'] as const)(
  'a Parent successor cannot strand a child with an %s mandate',
  async (state) => {
    const subject = await abandonedParent(state)
    const before = [...subject.native.comments.values()].flatMap((comments) => comments.map((comment) => comment.body))
    const result = await selectNew(subject)
    expect(result).toMatchObject({ kind: 'blocked' })
    expect(subject.native.writes).toEqual([])
    expect(
      [...subject.native.comments.values()].flatMap((comments) => comments.map((comment) => comment.body)),
    ).toEqual(before)
  },
)

test('a nested terminal child succeeds only against its unchanged active Parent engagement', async () => {
  const subject = await abandonedNestedLeaf()
  const beforeParent = await subject.reader.readUw(scope)
  expect(beforeParent.admission.deliverable.ok).toBe(false)
  const result = await selectNew(subject)
  expect(result).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    mandate: {
      payload: {
        antecedent: { scope: child, recordId: subject.original.recordId, kind: 'mandate' },
        parent: subject.original.payload.parent,
        inheritedOwnSpecRefs: subject.original.payload.inheritedOwnSpecRefs,
      },
    },
  })
  const after = await subject.reader.readUw(child)
  expect(after.admission).toMatchObject({ applicability: 'resolved', deliverable: { ok: true } })
  const afterParent = await subject.reader.readUw(scope)
  expect(afterParent.admission).toMatchObject({ applicability: 'resolved', deliverable: { ok: true } })
})

test('a Parent successor refuses a child mandate acquired during bootstrap', async () => {
  const subject = await abandonedParent()
  bootstrap.after = async () => {
    subject.seed(subject.childMandate)
  }
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})

test('a foreign child mandate claim is not evidence that the child is unmanaged', async () => {
  const subject = await abandonedParent('unmanaged', (world) => {
    world.seed(roxabiWorkflowFixtures().featureMandate(child, { recordId: 'foreign-child' }), 'outsider')
  })
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})

test('a nested successor preserves an independently active sibling', async () => {
  const subject = await abandonedNestedSiblings('active')
  const siblingFrames = subject.native.comments.get(43)?.map((comment) => comment.body)
  const result = await selectNew(subject)
  expect(result).toMatchObject({ authority: { selection: { status: 'applicable' } } })
  expect(subject.native.comments.get(43)?.map((comment) => comment.body)).toEqual(siblingFrames)
  expect((await subject.reader.readUw(scope)).admission.deliverable.ok).toBe(true)
  expect((await subject.reader.readUw(sibling)).accepted.status).toBe('accepted')
})

test('an explicit nested successor does not waive another terminal child', async () => {
  const subject = await abandonedNestedSiblings('abandoned')
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})

test('an independently abandoned sibling during bootstrap stops the nested successor', async () => {
  const subject = await abandonedNestedSiblings('active')
  bootstrap.after = async () => {
    subject.seed(subject.siblingAbandonment)
  }
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})

test('a nested Parent preserves both its active ancestor and unmanaged descendant commitments', async () => {
  const subject = await abandonedNestedParent()
  const result = await selectNew(subject)
  expect(result).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    mandate: {
      payload: {
        parent: subject.original.payload.parent,
        inheritedOwnSpecRefs: subject.original.payload.inheritedOwnSpecRefs,
        children: subject.original.payload.children,
        coverage: subject.original.payload.coverage,
      },
    },
  })
  expect((await subject.reader.readUw(child)).admission.deliverable.ok).toBe(true)
  expect((await subject.reader.readUw(scope)).admission.deliverable.ok).toBe(true)
  expect((await subject.reader.readUw(sibling)).accepted.status).toBe('absent')
})

test('ancestor revocation is not proof of an own abandoned terminal mandate', async () => {
  const subject = await revokedNestedLeaf()
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})

test('a Parent successor cannot retain a changed native child version as an old commitment', async () => {
  const subject = await abandonedParent('unmanaged', ({ native }) => {
    const delegated = native.issues.get(42)
    if (!delegated) throw new Error('missing delegated issue')
    delegated.body = renderIssueSpecBody(proposal('Deliver a newly changed child outcome.'), { complexity: 2 })
  })
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})
