import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { nativeComment } from '../../adapters/__tests__/github-workflow-support.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { createUwDeliveryFactReader, selectWorkflowBinding } from '../../dist/contracts.js'
import { parseRecord } from '../../engine/record-construction.ts'
import { bindExternalRef } from '../../engine/workflow-control.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { abandonedLeaf, branch, scope, selectNew } from './uw-successor-selection-support.ts'

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
afterEach(() => vi.unstubAllEnvs())

const fixtures = roxabiWorkflowFixtures()
const pull = { repository: 'acme/app', target: 'acme/app#70' }

test.each(['bound', 'absent'] as const)(
  'composes both legacy observations and a covered ordinary read for a %s PR',
  async (initial) => {
    const subject = await abandonedLeaf((world) => {
      if (initial === 'bound') {
        world.github.addPull(70)
        world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
      }
    })
    expect(subject.original.payload.config.productVersion).toBe('0.18.7')
    expect(subject.before.observation.status).toBe('complete')
    expect(subject.before.observation.delivery.some((facts) => facts.uw.target === scope.target)).toBe(false)
    const before = subject.github.exhaustiveEnumerations
    let atBootstrap = -1
    bootstrap.after = async () => {
      if (atBootstrap === -1) atBootstrap = subject.github.exhaustiveEnumerations
    }
    const result = await selectNew(subject)
    expect(result).toMatchObject({ authority: { selection: { status: 'applicable' } } })
    if ('kind' in result || result.mandate === null) throw new Error(`Expected successor: ${JSON.stringify(result)}`)
    expect(result.mandate.payload.config.productVersion).toBe('0.18.8')
    expect(atBootstrap).toBeGreaterThan(before)
    expect(subject.github.exhaustiveEnumerations).toBeGreaterThan(atBootstrap)

    const home = await subject.engine.readComposedWorkflowHistory([scope], subject.authority.context)
    expect(home.ok).toBe(true)
    const records =
      home.histories[0]?.operations.flatMap((operation) => (operation.record ? [operation.record] : [])) ?? []
    const predecessor = { scope, recordId: subject.original.recordId, kind: 'mandate' }
    const successor = { scope, recordId: result.mandate.recordId, kind: 'mandate' }
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'mandate',
        recordId: successor.recordId,
        payload: expect.objectContaining({ antecedent: predecessor }),
      }),
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'operator-control',
        payload: expect.objectContaining({ control: 'select-successor', predecessor, successor }),
      }),
    )

    // A damaged PR on another branch would refuse an exhaustive observation.
    subject.github.addPull(71, { branch: 'unrelated' })
    subject.native.comments
      .get(71)
      ?.push(
        nativeComment(
          9000,
          '<!-- omp-build-record v=1 kind=workflow-binding id=bad operationId=bad part=1/2 data=e30 -->',
        ),
      )
    const exhaustive = subject.github.exhaustiveEnumerations
    const after = await subject.reader.readUw(scope)
    expect(after.observation.status).toBe('complete')
    expect(subject.github.exhaustiveEnumerations).toBe(exhaustive)
    expect(after.histories.map((history) => history.source.scope.target)).not.toContain('acme/app#71')
    const delivery = after.observation.delivery.find((facts) => facts.uw.target === scope.target)
    expect(delivery?.pullRequests.map((item) => item.pullRequest)).toEqual(initial === 'bound' ? [pull] : [])
    if (initial === 'bound') {
      expect(
        selectWorkflowBinding({ pullRequest: pull, histories: after.histories, native: { branch, base: 'main' } }),
      ).toMatchObject({ status: 'bound', mandate: successor })
    } else {
      expect(subject.native.comments.get(70)).toBeUndefined()
    }
  },
)

test('a late old mandate refuses delivery and holds consumer authority after the successor cutoff', async () => {
  const subject = await abandonedLeaf((world) => {
    world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
  })
  const result = await selectNew(subject)
  if ('kind' in result || result.mandate === null) throw new Error(`Expected successor: ${JSON.stringify(result)}`)
  const completed = await subject.reader.readUw(scope)
  expect(completed.observation.status).toBe('complete')
  const late = parseRecord({ ...subject.original, recordId: 'late-legacy', operationId: 'late-legacy-op' })
  if (!late.ok) throw new Error('Invalid legacy append fixture')
  const beforeComments = subject.native.comments.get(41)
  if (!beforeComments?.length) throw new Error('Missing successor issue comments')
  const lastId = Math.max(...beforeComments.map((comment) => comment.id))
  const frames = encodeParts(late.value, '# mandate', 65536)
  if (!frames.ok) throw new Error('Cannot encode legacy append')
  for (const frame of frames.value) {
    await subject.github.gh('/work', [
      'api',
      'repos/acme/app/issues/41/comments',
      '--method',
      'POST',
      '-f',
      `body=${frame}`,
    ])
  }
  const appended = subject.native.comments.get(41)?.slice(beforeComments.length - frames.value.length) ?? []
  expect(appended).toHaveLength(frames.value.length)
  expect(appended.every((comment) => comment.id > lastId)).toBe(true)
  const exhaustive = subject.github.exhaustiveEnumerations
  const after = await subject.reader.readUw(scope)
  if (after.observation.status !== 'complete')
    throw new Error(`Expected complete native observation: ${JSON.stringify(after.observation.diagnostics)}`)
  const home = after.histories.find((history) => history.source.scope.target === scope.target)
  if (home === undefined) throw new Error('Missing late mandate home history')
  expect(home.source.comments.slice(-appended.length).map((comment) => comment.nativeId)).toEqual(
    appended.map((comment) => String(comment.id)),
  )
  expect(bindExternalRef({ scope, kind: 'mandate', recordId: 'late-legacy' }, home)).toMatchObject({
    ok: true,
    value: { kind: 'mandate', payload: { config: { productVersion: '0.18.7' } } },
  })
  const delivery = await createUwDeliveryFactReader({
    cwd: '/work',
    gh: subject.github.gh,
    readAuthor: 'automation',
  }).read(scope, [home])
  expect(delivery).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: 'legacy-coverage-incomplete' })],
  })
  expect(
    subject.engine.selectApplicableMandate(
      home,
      after.histories.filter((history) => history !== home),
      {
        histories: after.histories,
        catalogues: after.catalogues,
        observation: after.observation,
      },
    ),
  ).toMatchObject({ status: 'refused', reason: 'ambiguous' })
  expect(after.accepted).toMatchObject({ status: 'refused' })
  expect(after.admission.deliverable).toMatchObject({ ok: false })
  expect(after.completion.dependencies.get(`${scope.repository}\0${scope.target}`)).toMatchObject({
    state: 'held',
    completion: { state: 'indeterminate' },
    diagnostics: [expect.objectContaining({ code: 'ambiguous' })],
  })
  expect(subject.github.exhaustiveEnumerations).toBe(exhaustive)
})

test('interruption after control does not turn the predecessor binding into a complete successor binding', async () => {
  let interrupted = false
  const subject = await abandonedLeaf((world) => {
    const existing = world.github.addPull(70)
    world.seed(fixtures.workflowBinding(pull, world.original, branch, 'main'))
    world.github.hooks.afterComment = (kind, number) => {
      if (kind === 'operator-control' && number === 41) {
        interrupted = true
        existing.state = 'CLOSED'
      }
    }
  })
  const before = subject.native.comments.get(70)?.map((comment) => comment.body)
  const result = await selectNew(subject)
  expect(interrupted).toBe(true)
  expect(result).toMatchObject({ kind: 'blocked', reason: 'pr-discovery-closed' })
  expect(subject.native.comments.get(70)?.map((comment) => comment.body)).toEqual(before)
  const after = await subject.reader.readUw(scope)
  expect(after.observation.status).toBe('incomplete')
  if (after.observation.status !== 'incomplete') throw new Error('Expected an incomplete post-control observation')
  expect(after.observation.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'unconfirmed',
        message: 'Authorized successor has no workflow-binding on this PR',
      }),
    ]),
  )
  const home = after.histories.find((history) => history.source.scope.target === scope.target)
  if (home === undefined) throw new Error('Missing successor home history')
  const control = home.operations
    .filter((operation) => operation.status === 'complete' && operation.authority === 'accounted')
    .map((operation) => operation.record)
    .find((record) => record?.kind === 'operator-control' && record.payload.control === 'select-successor')
  if (control?.kind !== 'operator-control' || control.payload.control !== 'select-successor')
    throw new Error('Missing complete successor control')
  const predecessor = { scope, recordId: subject.original.recordId, kind: 'mandate' }
  expect(control.payload.predecessor).toEqual(predecessor)
  expect(bindExternalRef({ scope, recordId: control.recordId, kind: 'operator-control' }, home)).toMatchObject({
    ok: true,
    value: control,
  })
  const successor = bindExternalRef(control.payload.successor, home)
  expect(successor).toMatchObject({
    ok: true,
    value: { kind: 'mandate', payload: { antecedent: predecessor, config: { productVersion: '0.18.8' } } },
  })
  expect(
    selectWorkflowBinding({ pullRequest: pull, histories: after.histories, native: { branch, base: 'main' } }),
  ).toMatchObject({
    status: 'incomplete',
    diagnostics: [{ code: 'unconfirmed', message: 'Authorized successor has no workflow-binding on this PR' }],
  })
  expect(subject.github.exhaustiveEnumerations).toBeGreaterThanOrEqual(2)
})
