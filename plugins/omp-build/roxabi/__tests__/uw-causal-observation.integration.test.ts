import { expect, it } from 'vitest'
import { nativeComment } from '../../adapters/__tests__/github-workflow-support.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../../adapters/github/transport.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { actionInputDigest, buildRecord, catalogueForAction } from '../../dist/contracts.js'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { reviewRoot } from '../../testing/record-builders.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { causalRefusal } from '../causal-refusal.ts'
import { featureStopMessage } from '../feature-presentation.ts'
import { composeObservedUwCausalContext } from '../fix-uw-histories.ts'
import { createInstalledUwReadPort } from '../uw-read-port.ts'

const scope = { repository: 'acme/app', target: 'acme/app#42' }

async function observed(catalogueAvailable: boolean, includeInventory = true, historyFault: string | null = null) {
  const inventory = reviewRoot({ scope, id: 'observed-review' })
  if (inventory.payload.stage !== 'initial' || inventory.payload.purpose !== 'review')
    throw new Error('expected inventory')
  const inputs = inventory.payload.inputSnapshot
  const encoded = encodeCriterionRecords([inventory], scope, roxabiRecordFixtures().projection, 'automation')
  if (
    !encoded.history.operations.some(
      (operation) => operation.recordId === inventory.recordId && operation.status === 'complete',
    )
  )
    throw new Error('canonical inventory was not authenticated')
  const gh: Gh = async (_cwd, args) => {
    const catalogue = fixtureCatalogueGhResponse(args)
    if (catalogue !== null) {
      if (!catalogueAvailable) throw new Error('pinned catalogue unavailable')
      return catalogue
    }
    if (args[1] === 'graphql') {
      const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
      return JSON.stringify({
        data: {
          repository: {
            issue: {
              number: 42,
              title: 'Issue',
              body: '',
              updatedAt: '2026-10-27T12:00:00Z',
              state: 'OPEN',
              stateReason: null,
              repository: { nameWithOwner: 'acme/app' },
              parent: null,
              labels: page([]),
              subIssues: page([]),
              blockedBy: page([]),
            },
          },
        },
      })
    }
    if (args.some((arg) => arg.includes('/issues/42/comments'))) {
      if (historyFault !== null) throw new Error(historyFault)
      return JSON.stringify(
        includeInventory ? encoded.comments.map((item, index) => nativeComment(index + 1, item.body)) : [],
      )
    }
    throw new Error(`unexpected request: ${args.join(' ')}`)
  }
  const options = { cwd: '/fixture', gh, readAuthor: 'automation' }
  return { read: await createInstalledUwReadPort(options).readUw(scope), options, inputs }
}

it.each([true, false])(
  'preserves the exact observed catalogue result when reusing complete evidence; available=%s',
  async (available) => {
    const { read, options, inputs } = await observed(available)
    expect(read.causalObservation.status).toBe('complete')
    expect(catalogueForAction(inputs, read.catalogues).ok).toBe(available)
    const reused = await composeObservedUwCausalContext(read, read.histories, {
      ...options,
      gh: async () => {
        throw new Error('unexpected fresh read during same observation')
      },
    })
    expect(reused.ok, JSON.stringify(reused)).toBe(true)
    if (!reused.ok) throw new Error('completed observation refused')
    expect(reused.value.histories).toBe(read.histories)
    expect(reused.value.catalogues).toBe(read.catalogues)
    expect(catalogueForAction(inputs, reused.value.catalogues).ok).toBe(available)
  },
)

it('refuses changed overlap and an unavailable observation instead of reconstructing either', async () => {
  const { read, options } = await observed(true)
  const history = read.histories.find((item) => item.source.scope.target === scope.target)
  if (!history) throw new Error('expected root history')
  const changed = { ...history, source: { ...history.source, stopAuthor: null } }
  expect(await composeObservedUwCausalContext(read, [changed], options)).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining(['fix-history-observation-drift']),
  })
  expect(
    await composeObservedUwCausalContext({ ...read, causalObservation: { status: 'unavailable' } }, [], options),
  ).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining(['fix-causal-observation-unavailable']),
  })
})

it('refuses detached completion proofs and retained-root unavailable projections without I/O', async () => {
  const { read, options } = await observed(true)
  const empty = await observed(true, false)
  const noIo = {
    ...options,
    gh: async () => {
      throw new Error('unavailable observation attempted I/O')
    },
  }
  const cases = [
    { ...read, histories: [...read.histories] },
    { ...read, catalogues: fixtureHostReviewClassCatalogues() },
    { ...empty.read, causalObservation: { status: 'unavailable' as const } },
  ]
  for (const candidate of cases) {
    expect(await composeObservedUwCausalContext(candidate, [], noIo)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining(['fix-causal-observation-unavailable']),
    })
  }
})

it('tells the operator which GitHub read failed when the observation is unavailable', async () => {
  const { read, options } = await observed(true, true, 'gh: API rate limit exceeded for user ID 1 (HTTP 403)')
  expect(read.causalObservation.status).toBe('unavailable')
  const refused = await composeObservedUwCausalContext(read, [], options)
  if (refused.ok) throw new Error('unavailable observation accepted')
  expect(refused.diagnostics).toEqual(['fix-own-uw-unsettled', 'fix-causal-observation-unavailable'])
  const stop = featureStopMessage({ kind: 'blocked', ...causalRefusal(refused) })?.split('\n') ?? []
  expect(stop.slice(0, 2)).toEqual(['feature-stopped: fix-own-uw-unsettled', 'fix-causal-observation-unavailable'])
  expect(stop.slice(2).join('\n')).toContain('acme/app#42')
  expect(stop.slice(2).join('\n')).toContain('API rate limit exceeded')
})

it('extends a completed observation through newly selected and recursively cited scopes', async () => {
  const { read, options, inputs } = await observed(true)
  const fixtures = roxabiWorkflowFixtures()
  const addedScope = { repository: 'acme/app', target: 'acme/app#43' }
  const recursiveScope = { repository: 'acme/app', target: 'acme/app#44' }
  const addedMandate = fixtures.fixOnlyMandate(addedScope, { recordId: 'added-mandate' })
  const recursiveMandate = fixtures.fixOnlyMandate(recursiveScope, { recordId: 'recursive-mandate' })
  const recursive = fixtures.historyFrom([recursiveMandate], 'automation')
  const binding = fixtures.workflowBinding(addedScope, recursiveMandate, 'fix/44', 'main')
  const addedBodies = [
    ...fixtures.framedBodies([addedMandate], 'automation'),
    ...fixtures.framedBodies([binding], 'automation', [recursive]),
  ]
  const gh: Gh = async (cwd, args) => {
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    if (endpoint.includes('/issues/43/comments'))
      return JSON.stringify(addedBodies.map((body, index) => nativeComment(4300 + index, body)))
    if (endpoint.includes('/issues/44/comments'))
      return JSON.stringify(
        recursive.source.comments.map((comment, index) => nativeComment(4400 + index, comment.body)),
      )
    return options.gh(cwd, args)
  }
  const policy = { ...options, gh, stopAuthor: 'github-actions[bot]' }
  const selected = decodeHistory(await readGitHubHistory({ repository: 'acme/app', target: 'acme/app#43' }, policy))
  expect(
    selected.operations.some((operation) => operation.recordId === binding.recordId && operation.status === 'complete'),
  ).toBe(true)
  const extended = await composeObservedUwCausalContext(read, [selected], policy)
  expect(extended.ok, JSON.stringify(extended)).toBe(true)
  if (!extended.ok) throw new Error('valid closure extension refused')
  expect(extended.value.histories.map((history) => history.source.scope.target).sort()).toEqual([
    'acme/app#42',
    'acme/app#43',
    'acme/app#44',
  ])
  expect(extended.value.catalogues).not.toBe(read.catalogues)
  expect(catalogueForAction(inputs, extended.value.catalogues).ok).toBe(true)
})

it('rebuilds the full table and refuses conflicting digests at the same pin when a scope is added', async () => {
  const { read, options, inputs } = await observed(true)
  const other = reviewRoot({ scope: { repository: 'acme/app', target: 'acme/app#43' }, id: 'conflicting-review' })
  if (other.payload.stage !== 'initial' || other.payload.purpose !== 'review') throw new Error('expected inventory')
  const prior = other.payload.inputSnapshot
  const manifest = {
    ...prior.manifest,
    plugin: {
      ...prior.manifest.plugin,
      files: prior.manifest.plugin.files.map((file) => ({ ...file, digest: 'f'.repeat(64) })),
    },
  }
  const fingerprint = actionInputDigest(manifest)
  const conflicting = buildRecord({
    ...other,
    payload: {
      ...other.payload,
      inputSnapshot: { ...prior, manifest, fingerprint },
      actionInputDigest: fingerprint,
      input: fingerprint,
    },
  })
  if (!conflicting.ok) throw new Error(JSON.stringify(conflicting.diagnostics))
  const encoded = encodeCriterionRecords(
    [conflicting.value],
    { repository: 'acme/app', target: 'acme/app#43' },
    roxabiRecordFixtures().projection,
    'automation',
  )
  expect(
    encoded.history.operations.some(
      (operation) => operation.recordId === conflicting.value.recordId && operation.status === 'complete',
    ),
  ).toBe(true)
  const gh: Gh = async (cwd, args) => {
    if (args.some((arg) => arg.includes('/issues/43/comments')))
      return JSON.stringify(encoded.comments.map((item, index) => nativeComment(4300 + index, item.body)))
    return options.gh(cwd, args)
  }
  const policy = { ...options, gh, stopAuthor: 'github-actions[bot]' }
  const selected = decodeHistory(await readGitHubHistory({ repository: 'acme/app', target: 'acme/app#43' }, policy))
  const extended = await composeObservedUwCausalContext(read, [selected], policy)
  expect(extended.ok, JSON.stringify(extended)).toBe(true)
  if (!extended.ok) throw new Error('complete observation extension refused')
  expect(catalogueForAction(inputs, extended.value.catalogues).ok).toBe(false)
})
