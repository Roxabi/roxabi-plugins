import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { nativeComment } from '../../adapters/__tests__/github-workflow-support.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { selectWorkflowBinding } from '../../dist/contracts.js'
import { parseRecord } from '../../engine/record-construction.ts'
import { bindExternalRef } from '../../engine/workflow-control.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { resolveFeatureAuthority } from '../feature-continuation-admission.ts'
import { selectFeatureMandate } from '../feature-continuation-selection.ts'
import { abandonedParent } from './uw-successor-parent-fixtures.ts'
import { abandon, abandonedLeaf, branch, scope, selectNew } from './uw-successor-selection-support.ts'

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
const fixtures = roxabiWorkflowFixtures()
const pull = { repository: 'acme/app', target: 'acme/app#70' }
type Subject = Awaited<ReturnType<typeof abandonedLeaf>>

async function expectPreflightRefusal(subject: Subject) {
  const result = await selectNew(subject)
  if ('kind' in result) expect(result.kind).toBe('blocked')
  else {
    expect(result.authority.selection.status).toBe('refused')
    expect(result.mandate).toBeNull()
  }
  expect(subject.native.writes).toEqual([])
}

async function ownHistory(subject: Subject) {
  const read = await subject.engine.readComposedWorkflowHistory([scope], subject.authority.context)
  if (!read.ok || !read.histories[0]) throw new Error('Missing own native history')
  return read.histories[0]
}

test.each(['bound', 'unbound', 'merged'] as const)('a successor preserves the same %s existing PR', async (binding) => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70, binding === 'merged' ? { state: 'MERGED', mergeCommit: 'd'.repeat(40) } : {})
    if (binding !== 'unbound') world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
  })
  const previous = subject.native.comments.get(70)?.map((comment) => comment.body)
  const result = await selectNew(subject)
  expect(subject.github.exhaustiveEnumerations).toBeGreaterThanOrEqual(2)
  expect(result).toMatchObject({ authority: { selection: { status: 'applicable' } } })
  if ('kind' in result || result.mandate === null) throw new Error('Expected successor selection')
  const after = await subject.reader.readUw(scope)
  expect(after.observation.status).toBe('complete')
  expect(
    selectWorkflowBinding({ pullRequest: pull, histories: after.histories, native: { branch, base: 'main' } }),
  ).toMatchObject({ status: 'bound', mandate: { scope, recordId: result.mandate.recordId, kind: 'mandate' } })
  expect(
    subject.native.comments
      .get(70)
      ?.slice(0, previous?.length)
      .map((comment) => comment.body),
  ).toEqual(previous)
})

test('a legacy mandate appended after successor publication prevents control publication', async () => {
  let controlsBefore = 0
  const writes: Promise<string>[] = []
  const subject = await abandonedLeaf((world) => {
    controlsBefore =
      world.native.comments.get(41)?.filter((comment) => comment.body.includes('kind=operator-control')).length ?? 0
    const later = parseRecord({ ...world.original, recordId: 'concurrent-old', operationId: 'concurrent-old-op' })
    if (!later.ok) throw new Error('invalid concurrent mandate fixture')
    const frames = encodeParts(later.value, '# mandate', 65536)
    if (!frames.ok) throw new Error('cannot encode concurrent mandate fixture')
    let inserted = false
    world.github.hooks.afterComment = (kind, number) => {
      if (!inserted && kind === 'mandate' && number === 41) {
        inserted = true
        for (const frame of frames.value)
          writes.push(
            world.native.gh('/work', [
              'api',
              'repos/acme/app/issues/41/comments',
              '--method',
              'POST',
              '-f',
              `body=${frame}`,
            ]),
          )
      }
    }
  })
  const result = await selectNew(subject)
  await Promise.all(writes)
  expect(result).toMatchObject({ kind: 'blocked', reason: 'successor-ancestry-changed' })
  expect(writes.length).toBeGreaterThan(0)
  const home = await ownHistory(subject)
  const successor = home.operations.find(
    (operation) =>
      operation.record?.kind === 'mandate' &&
      operation.record.recordId !== subject.original.recordId &&
      operation.record.recordId !== 'concurrent-old',
  )
  if (successor?.record?.kind !== 'mandate') throw new Error('Missing published successor')
  const old = home.operations.find((operation) => operation.recordId === 'concurrent-old')
  if (old === undefined) throw new Error('Missing concurrent legacy mandate')
  expect(bindExternalRef({ scope, kind: 'mandate', recordId: successor.record.recordId }, home)).toMatchObject({
    ok: true,
  })
  expect(bindExternalRef({ scope, kind: 'mandate', recordId: 'concurrent-old' }, home)).toMatchObject({ ok: true })
  const nextIds = successor.parts.map((part) =>
    Number(home.source.comments.find((comment) => comment.locator === part.locator)?.nativeId),
  )
  const oldIds = old.parts.map((part) =>
    Number(home.source.comments.find((comment) => comment.locator === part.locator)?.nativeId),
  )
  expect(Math.min(...oldIds)).toBeGreaterThan(Math.max(...nextIds))
  expect(
    subject.native.comments.get(41)?.filter((comment) => comment.body.includes('kind=operator-control')),
  ).toHaveLength(controlsBefore)
})

test('closed matching PRs refuse before any issue or PR append', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70, { state: 'CLOSED' })
  })
  await expectPreflightRefusal(subject)
})

test('ambiguous matching PRs refuse before any append', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    world.github.addPull(71)
  })
  await expectPreflightRefusal(subject)
})

test('the same mandate ID in another UW cannot authorize an antecedent binding', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    const other = fixtures.featureMandate(
      { repository: scope.repository, target: 'acme/app#99' },
      {
        recordId: world.original.recordId,
      },
    )
    world.seed(fixtures.workflowBinding(pull, other, branch, 'main'))
  })
  await expectPreflightRefusal(subject)
})

test('an edited binding cannot become evidence of binding absence', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    const binding = fixtures.workflowBinding(pull, world.original, branch, 'main')
    world.seed(binding)
    for (const part of world.parts(binding)) part.updated_at = '2026-10-28T00:00:00Z'
  })
  await expectPreflightRefusal(subject)
})

test('a bound PR outside the requested branch filter cannot be silently stranded', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70, { branch: 'other/existing' })
    world.seed(fixtures.workflowBinding(pull, world.original, 'other/existing', 'main'))
  })
  await expectPreflightRefusal(subject)
})

test('a branchless Parent cannot discard its own existing PR binding', async () => {
  const subject = await abandonedParent('unmanaged', (world) => {
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
  })
  await expectPreflightRefusal(subject)
})

test('failed successor control publication never appends a PR binding', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
    world.github.hooks.rejectControl = true
  })
  const previous = subject.native.comments.get(70)?.map((comment) => comment.body)
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  const history = await ownHistory(subject)
  expect(
    history.operations.filter((operation) => operation.record?.kind === 'mandate').map((operation) => operation.record),
  ).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        antecedent: {
          scope,
          recordId: subject.original.recordId,
          kind: 'mandate',
        },
      }),
    }),
  )
  expect(
    history.operations
      .filter((operation) => operation.record?.kind === 'operator-control')
      .map((operation) => operation.record?.payload),
  ).not.toContainEqual(expect.objectContaining({ control: 'select-successor' }))
  expect(subject.native.comments.get(70)?.map((comment) => comment.body)).toEqual(previous)
})

test('ordinary PR conversation after preparation does not invalidate authenticated binding facts', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
    world.github.hooks.afterComment = (kind, number) => {
      if (kind === 'mandate' && number === 41)
        world.native.comments.get(70)?.push(nativeComment(10000, 'Ordinary review conversation.'))
    }
  })
  const result = await selectNew(subject)
  expect(result).toMatchObject({ authority: { selection: { status: 'applicable' } } })
  expect((await subject.reader.readUw(scope)).observation.status).toBe('complete')
})

test('foreign-only binding claims cannot authorize binding absence', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'), 'outsider')
  })
  await expectPreflightRefusal(subject)
})

test('an authentic binding remains usable alongside unrelated foreign binding noise', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
    const other = fixtures.featureMandate({ repository: scope.repository, target: 'acme/app#99' })
    world.seed(fixtures.workflowBinding(pull, other, branch, 'main'), 'outsider')
  })
  const result = await selectNew(subject)
  expect(result).toMatchObject({ authority: { selection: { status: 'applicable' } } })
})

test('a foreign binding copy after the selection control cannot veto the authenticated association', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    const binding = fixtures.workflowBinding(pull, world.original, branch, 'main')
    world.seed(binding)
    world.github.hooks.afterComment = (kind, number) => {
      if (kind === 'operator-control' && number === 41) world.seed(binding, 'outsider')
    }
  })
  const result = await selectNew(subject)
  expect(result).toMatchObject({ authority: { selection: { status: 'applicable' } } })
  if ('kind' in result || result.mandate === null) throw new Error('Expected authenticated successor selection')
  const after = await subject.reader.readUw(scope)
  expect(
    selectWorkflowBinding({
      pullRequest: pull,
      histories: after.histories,
      native: { branch, base: 'main' },
    }),
  ).toMatchObject({
    status: 'bound',
    mandate: { scope, recordId: result.mandate.recordId, kind: 'mandate' },
  })
})

test('bootstrap cannot discard an authenticated Parent own-PR binding before publication', async () => {
  const subject = await abandonedParent('unmanaged', (world) => {
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
  })
  bootstrap.after = async () => {
    subject.native.comments.set(70, [])
  }
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.writes).toEqual([])
})

test.each(['mandate', 'operator-control'] as const)(
  'PR closure after %s preserves earlier issue effects but prevents every later append',
  async (phase) => {
    const subject = await abandonedLeaf((world) => {
      const existing = world.github.addPull(70)
      world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
      world.github.hooks.afterComment = (kind, number) => {
        if (kind === phase && number === 41) existing.state = 'CLOSED'
      }
    })
    const previous = subject.native.comments.get(70)?.map((comment) => comment.body)
    const result = await selectNew(subject)
    expect(result).toMatchObject({ kind: 'blocked' })
    const history = await ownHistory(subject)
    const successor = history.operations
      .map((operation) => operation.record)
      .find((record) => record?.kind === 'mandate' && record.payload.antecedent?.recordId === subject.original.recordId)
    expect(successor).toMatchObject({
      kind: 'mandate',
      payload: { antecedent: { scope, recordId: subject.original.recordId } },
    })
    if (successor?.kind !== 'mandate') throw new Error('Expected the earlier successor append')
    const controls = history.operations.flatMap((operation) =>
      operation.record?.kind === 'operator-control' && operation.record.payload.control === 'select-successor'
        ? [operation.record.payload]
        : [],
    )
    expect(controls).toEqual(
      phase === 'mandate'
        ? []
        : [
            expect.objectContaining({
              control: 'select-successor',
              mandate: { scope, recordId: subject.original.recordId, kind: 'mandate' },
              successor: { scope, recordId: successor.recordId, kind: 'mandate' },
            }),
          ],
    )
    expect(subject.native.comments.get(70)?.map((comment) => comment.body)).toEqual(previous)
  },
)

test('editing a pinned binding after control prevents the successor PR append', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    const binding = fixtures.workflowBinding(pull, world.original, branch, 'main')
    world.seed(binding)
    world.github.hooks.afterComment = (kind, number) => {
      if (kind === 'operator-control' && number === 41)
        for (const part of world.parts(binding)) part.updated_at = '2026-10-28T00:00:00Z'
    }
  })
  const previous = subject.native.comments.get(70)?.map((comment) => comment.body)
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.comments.get(70)?.map((comment) => comment.body)).toEqual(previous)
})

test('a changed native head after control is not the pinned PR fact set', async () => {
  const subject = await abandonedLeaf((world) => {
    const existing = world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
    world.github.hooks.afterComment = (kind, number) => {
      if (kind === 'operator-control' && number === 41) existing.head = 'e'.repeat(40)
    }
  })
  const previous = subject.native.comments.get(70)?.map((comment) => comment.body)
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.comments.get(70)?.map((comment) => comment.body)).toEqual(previous)
})

test('initial PR absence does not authorize a new destination appearing after M2', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.hooks.afterComment = (kind, number) => {
      if (kind === 'mandate' && number === 41) world.github.addPull(70)
    }
  })
  const result = await selectNew(subject)
  expect(result).toMatchObject({ kind: 'blocked' })
  expect(subject.native.comments.get(70)).toEqual([])
  const history = await ownHistory(subject)
  expect(
    history.operations.flatMap((operation) =>
      operation.record?.kind === 'operator-control' && operation.record.payload.control === 'select-successor'
        ? [operation.record]
        : [],
    ),
  ).toEqual([])
})

test('repeated explicit succession extends the authenticated historical PR binding chain', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
  })
  const first = await selectNew(subject)
  if ('kind' in first || first.mandate === null) throw new Error('Expected the first successor')
  subject.seed(abandon(first.mandate))
  const authority = await resolveFeatureAuthority({
    cwd: subject.authority.context.cwd,
    reference: scope.target,
    control: 'new',
    principal: false,
    git: subject.authority.context.git,
    gh: subject.authority.context.gh,
    read: subject.reader,
  })
  if ('kind' in authority)
    throw new Error(`Expected genuine abandoned successor authority: ${JSON.stringify(authority)}`)
  expect(authority.selection).toMatchObject({ status: 'refused', reason: 'abandoned' })
  const previous = subject.native.comments.get(70)?.map((comment) => comment.body)
  const second = await selectFeatureMandate('new', undefined, authority, undefined, subject.reader)
  expect(second).toMatchObject({
    authority: { selection: { status: 'applicable' } },
    mandate: { payload: { antecedent: { scope, recordId: first.mandate.recordId, kind: 'mandate' } } },
  })
  if ('kind' in second || second.mandate === null) throw new Error('Expected the next successor')
  const after = await subject.reader.readUw(scope)
  expect(
    selectWorkflowBinding({ pullRequest: pull, histories: after.histories, native: { branch, base: 'main' } }),
  ).toMatchObject({ status: 'bound', mandate: { scope, recordId: second.mandate.recordId, kind: 'mandate' } })
  expect(
    subject.native.comments
      .get(70)
      ?.slice(0, previous?.length)
      .map((comment) => comment.body),
  ).toEqual(previous)
})
