import { expect, it } from 'vitest'
import { actionInputDigest, canonicalValueDigest, catalogueForAction, recordsOf } from '../../dist/contracts.js'
import { createPublicationContextResolver } from '../../roxabi/publication-context.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { causeOriginalHistory } from '../../testing/cause-input-fixture.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { readGitHubHistory } from '../github/transport.ts'
import type { GitHubOptions } from '../github/types.ts'
import { nativeComment } from './github-workflow-support.ts'

it('authenticates assessed citations, candidate, explicit and recursively discovered histories in the final publication context', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const original = causeOriginalHistory()
  const mandate = recordsOf(original).find((record) => record.kind === 'mandate')
  if (mandate?.kind !== 'mandate') throw new Error('expected mandate')
  const candidateScope = { repository: 'acme/app', target: 'acme/app#46' }
  const explicitScope = { repository: 'acme/app', target: 'acme/app#43' }
  const recursiveScope = { repository: 'acme/app', target: 'acme/app#44' }
  const binding = fixtures.workflowBinding(candidateScope, mandate, 'feat/42-save', 'main')
  const candidate = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'candidate', label: 'issue' })
  const explicitMandate = fixtures.fixOnlyMandate(explicitScope, {
    recordId: 'explicit-mandate',
    operationId: 'explicit-mandate-op',
  })
  const recursiveMandate = fixtures.fixOnlyMandate(recursiveScope, {
    recordId: 'recursive-mandate',
    operationId: 'recursive-mandate-op',
  })
  const recursive = fixtures.historyFrom([recursiveMandate], 'automation')
  const recursiveBinding = fixtures.workflowBinding(explicitScope, recursiveMandate, 'fix/44', 'main')
  const explicit = fixtures.historyFrom([explicitMandate, recursiveBinding], 'automation', 'automation', [recursive])
  const own = fixtures.historyFrom([mandate], 'automation')
  const assessedManifest = {
    ...candidate.inputs.manifest,
    acceptedSources: [
      {
        source: 'record' as const,
        record: { scope: explicitScope, kind: 'mandate' as const, recordId: explicitMandate.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(explicitMandate.payload),
      },
    ],
  }
  const assessed = acceptedPullRequestReviewGraph({
    mandate,
    binding,
    prefix: 'assessed',
    label: 'issue',
    inputs: { ...candidate.inputs, manifest: assessedManifest, fingerprint: actionInputDigest(assessedManifest) },
  })
  const primaryFixture = fixtures.historyFrom([binding, assessed.root], 'automation', 'automation', [
    own,
    explicit,
    recursive,
  ])
  const comments = new Map([
    [42, own.source.comments],
    [43, explicit.source.comments],
    [44, recursive.source.comments],
    [46, primaryFixture.source.comments],
  ])
  const reads: number[] = []
  const options: GitHubOptions = {
    cwd: '/fixture',
    readAuthor: 'automation',
    gh: async (_cwd, args) => {
      const catalogue = fixtureCatalogueGhResponse(args)
      if (catalogue !== null) return catalogue
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      const number = Number(/issues\/(\d+)\/comments/.exec(endpoint)?.[1])
      const records = comments.get(number)
      if (!records) throw new Error(`unexpected history ${endpoint}`)
      reads.push(number)
      return JSON.stringify(records.map((comment, index) => nativeComment(number * 100 + index, comment.body)))
    },
  }
  const primary = decodeHistory(await readGitHubHistory(candidateScope, options))
  const explicitSeed = decodeHistory(await readGitHubHistory(explicitScope, options))
  expect(
    primary.operations.some((operation) => operation.recordId === binding.recordId && operation.status === 'complete'),
  ).toBe(true)
  expect(
    primary.operations.some(
      (operation) => operation.recordId === assessed.root.recordId && operation.status === 'complete',
    ),
  ).toBe(true)
  expect(
    explicitSeed.operations.some(
      (operation) =>
        operation.recordId === explicitMandate.recordId &&
        operation.status === 'complete' &&
        operation.authority !== 'foreign',
    ),
  ).toBe(true)
  expect(
    explicitSeed.operations.some(
      (operation) => operation.recordId === recursiveBinding.recordId && operation.status === 'complete',
    ),
  ).toBe(true)
  reads.length = 0
  const resolved = await createPublicationContextResolver(
    options,
    null,
  )({ record: candidate.root, history: primary, externalHistories: [explicitSeed] })
  expect(resolved.ok, JSON.stringify(resolved)).toBe(true)
  if (!resolved.ok) throw new Error('publication context refused')
  if (resolved.value.config === null) throw new Error('missing publication catalogue context')
  expect(resolved.value.externalHistories.map((history) => history.source.scope.target).sort()).toEqual([
    'acme/app#42',
    'acme/app#43',
    'acme/app#44',
  ])
  expect(
    resolved.value.externalHistories
      .find((history) => history.source.scope.target === 'acme/app#44')
      ?.operations.some(
        (operation) =>
          operation.recordId === recursiveMandate.recordId &&
          operation.status === 'complete' &&
          operation.authority !== 'foreign',
      ),
  ).toBe(true)
  expect(catalogueForAction(candidate.inputs, resolved.value.config.catalogues).ok).toBe(true)
  expect(reads.sort()).toEqual([42, 43, 44])
})
