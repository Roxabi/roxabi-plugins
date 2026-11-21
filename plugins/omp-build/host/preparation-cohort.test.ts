import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { UW_GRAPH_QUERY } from '../adapters/github-native/uw-graph-query.ts'
import { graphqlVariables } from '../adapters/github-workflow/client.ts'
import { readNativeCiFailureEvidence } from '../roxabi/feature-ci-evidence.ts'
import { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import { reconcileRecoveryHostEffects } from '../roxabi/fix-recovery-host-effects.ts'
import { readPrBody } from '../skills/feature/review-input.ts'
import {
  createPreparationCohort,
  trackPreparationGhOperation,
  trackPreparationOperation,
  withPreparationAttribution,
} from './preparation-cohort.ts'
import { githubPreparationKind } from './preparation-gh-classifier.ts'
import { AUTH_COMMENT_QUERY, BLOB_QUERY, CI_ROLLUP_QUERY, catalogueQuery, PULLS_QUERY } from './preparation-graphql.cjs'

function expectUnattributedWrite(result: ReturnType<typeof reconcileRecoveryHostEffects>, args: readonly string[]) {
  expect(result.status).toBe('held')
  if (result.status !== 'held') throw new Error('expected-host-write-held')
  expect(result.diagnostics[0]).toBe('fix-host-write-unattributed')
  expect(result.diagnostics).toHaveLength(2)
  const prefix = 'fix-host-effect-detail:'
  const encoded = result.diagnostics[1]
  expect(encoded?.startsWith(prefix)).toBe(true)
  if (!encoded?.startsWith(prefix)) throw new Error('expected-host-effect-detail')
  const query = args.find((arg) => arg.startsWith('query='))
  if (query === undefined) throw new Error('expected-graphql-query')
  expect(JSON.parse(encoded.slice(prefix.length))).toMatchObject({
    index: 0,
    kind: 'gh-write',
    outcome: 'fulfilled',
    provenance: {
      family: 'graphql',
      querySha256: createHash('sha256').update(query.slice(6)).digest('hex'),
      fields: expect.any(Array),
    },
    hasAttribution: false,
    matchingPublications: [],
    receipts: [],
  })
  for (const arg of args) {
    if (arg.includes('=') || arg.startsWith('Authorization:')) expect(encoded).not.toContain(arg)
    if (arg.startsWith('query=')) expect(encoded).not.toContain(arg.slice(6))
  }
  expect(encoded).not.toContain('fixture-secret-credential')
  expect(encoded).not.toContain('fixture-secret-argument')
}

it('does not treat unentered or entered-empty cohorts as joined evidence', async () => {
  const unentered = createPreparationCohort()
  unentered.seal()
  expect(await unentered.join()).toMatchObject({ status: 'unknown', diagnostics: ['host-cohort-not-entered'] })
  const empty = createPreparationCohort()
  empty.run(() => undefined)
  empty.seal()
  expect(await empty.join()).toMatchObject({ status: 'unknown', diagnostics: ['host-cohort-no-operations'] })
})

it('refuses ordinary operations attempted after sealing from an already-entered async context', async () => {
  const cohort = createPreparationCohort()
  const gate = Promise.withResolvers<void>()
  const late = cohort.run(async () => {
    await gate.promise
    return trackPreparationOperation('git', async () => 'must-not-run')
  })
  cohort.seal()
  gate.resolve()
  await expect(late).rejects.toThrow('preparation-cohort-admission-closed')
  expect(await cohort.join()).toMatchObject({ status: 'unknown', diagnostics: ['host-cohort-no-operations'] })
})

it('preserves exact reserved publication attribution across asynchronous nested host calls', async () => {
  const cohort = createPreparationCohort()
  const fence = new FixExecutionFence()
  fence.bindCohort(cohort)
  fence.bindIdentity({ runId: 'run-1', operationId: 'operation-1' })
  const reservation = {
    scope: { repository: 'acme/app', target: 'acme/app#7' },
    kind: 'contribution',
    runId: 'run-1',
    operationId: 'operation-1-source',
    recordId: 'source',
  }
  fence.enrollPublicationReservation(reservation)
  const similar = { ...reservation, scope: { ...reservation.scope } }
  const record = { ...reservation, repository: reservation.scope.repository, target: reservation.scope.target }
  await cohort.run(() =>
    fence.trackPublication(record, async () => {
      await Promise.resolve()
      await trackPreparationOperation('gh-append', async () => {
        await Promise.resolve()
        await trackPreparationOperation('gh-read', async () => 'readback')
        return 'posted'
      })
      await withPreparationAttribution(similar, async () => {
        await Promise.resolve()
        await trackPreparationOperation('gh-append', async () => 'different-context')
      })
      return { ok: true as const }
    }),
  )
  cohort.seal()
  const result = await cohort.join()
  expect(result.status).toBe('joined')
  const publication = fence.snapshot().publications[0]
  expect(publication).toMatchObject({ reserved: true, outcome: 'confirmed' })
  expect(publication?.attribution).toEqual(reservation)
  expect(publication?.attribution).not.toBe(reservation)
  const append = result.operations.filter((item) => item.kind === 'gh-append')
  expect(append).toHaveLength(2)
  expect(append[0]?.attribution).toBe(publication?.attribution)
  expect(result.operations.find((item) => item.kind === 'gh-read')?.attribution).toBe(publication?.attribution)
  expect(append[1]?.attribution).toBe(similar)
  expect(append[1]?.attribution).not.toBe(publication?.attribution)
  expect(similar).toEqual(reservation)
})

it('qualifies only the actual UW graph query as a read for recovery host effects', async () => {
  const target = { repository: 'acme/app', pr: 7, head: 'a'.repeat(40) }
  const cohort = createPreparationCohort()
  await cohort.run(() =>
    graphqlVariables(
      {
        cwd: '/fixture',
        gh: async (_cwd, args) => {
          expect(args).toEqual([
            'api',
            'graphql',
            '-f',
            `query=${UW_GRAPH_QUERY}`,
            '-f',
            'owner=acme',
            '-f',
            'name=app',
            '-F',
            'number=42',
            '-f',
            'labelsCursor=cursor',
            '-f',
            'childrenCursor=child',
            '-f',
            'blockersCursor=blocker',
          ])
          return JSON.stringify({ data: { repository: null } })
        },
      },
      UW_GRAPH_QUERY,
      {
        owner: 'acme',
        name: 'app',
        number: 42,
        labelsCursor: 'cursor',
        childrenCursor: 'child',
        blockersCursor: 'blocker',
      },
    ),
  )
  cohort.seal()
  const host = await cohort.join()
  expect(host.status).toBe('joined')
  if (host.status !== 'joined') throw new Error('fixture-cohort-not-joined')
  expect(host.operations).toEqual([expect.objectContaining({ kind: 'gh-read', outcome: 'fulfilled' })])
  expect(reconcileRecoveryHostEffects({ host, publications: [], target })).toEqual({
    status: 'qualified',
    reservedPublications: [],
  })
})

it('qualifies actual paginated CI rollup reads but holds changed or ambiguous calls', async () => {
  const head = 'a'.repeat(40)
  const target = { repository: 'acme/app', pr: 7, head }
  const calls: string[][] = []
  const cohort = createPreparationCohort()
  const evidence = await cohort.run(() =>
    readNativeCiFailureEvidence(
      '/fixture',
      'acme/app',
      head,
      { repository: 'acme/app', target: 'acme/app#7' },
      {
        failedCheckEvidenceDigest: () => 'fixture-digest',
        gh: async (_cwd, args) =>
          trackPreparationGhOperation(args, async () => {
            calls.push([...args])
            const first = calls.length === 1
            return JSON.stringify({
              data: {
                repository: {
                  object: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: first
                          ? [{ __typename: 'StatusContext', id: 'status-1', context: 'quality', state: 'FAILURE' }]
                          : [],
                        pageInfo: { hasNextPage: first, endCursor: first ? 'next-page' : null },
                      },
                    },
                  },
                },
              },
            })
          }),
      },
    ),
  )
  expect(evidence.ok).toBe(true)
  expect(calls).toEqual([
    ['api', 'graphql', '-f', `query=${CI_ROLLUP_QUERY}`, '-f', 'owner=acme', '-f', 'name=app', '-f', `sha=${head}`],
    [
      'api',
      'graphql',
      '-f',
      `query=${CI_ROLLUP_QUERY}`,
      '-f',
      'owner=acme',
      '-f',
      'name=app',
      '-f',
      `sha=${head}`,
      '-f',
      'after=next-page',
    ],
  ])
  expect(calls.map(githubPreparationKind)).toEqual(['gh-read', 'gh-read'])
  cohort.seal()
  const host = await cohort.join()
  if (host.status !== 'joined') throw new Error('fixture-cohort-not-joined')
  expect(reconcileRecoveryHostEffects({ host, publications: [], target })).toEqual({
    status: 'qualified',
    reservedPublications: [],
  })

  const first = calls[0]
  const next = calls[1]
  if (!first || !next) throw new Error('fixture-ci-rollup-pages-missing')
  const invalid = [
    first.map((arg) => (arg.startsWith('query=') ? `${arg}\n# changed` : arg)),
    first.map((arg) => (arg.startsWith('query=') ? `${arg}\nmutation { updateSomething }` : arg)),
    [...first, '--paginate'],
    [...first, '-f', `query=${CI_ROLLUP_QUERY}`],
    [...first, '-f', 'owner=other'],
    [...next, '-f', 'after=again'],
    [...first.slice(0, 4), '-f', 'name=app', '-f', 'owner=acme', '-f', `sha=${head}`],
    [...first.slice(0, 4), '-f', 'owner=acme', '-f', `sha=${head}`, '-f', 'name=app'],
  ]
  for (const args of invalid) {
    expect(githubPreparationKind(args)).toBe('gh-write')
    const changed = createPreparationCohort()
    await changed.run(() => trackPreparationGhOperation(args, async () => 'transport-returned'))
    changed.seal()
    const observed = await changed.join()
    if (observed.status !== 'joined') throw new Error('fixture-cohort-not-joined')
    expectUnattributedWrite(reconcileRecoveryHostEffects({ host: observed, publications: [], target }), args)
  }
})

it('holds recovery for changed or ambiguous GraphQL operations', async () => {
  const valid = [
    'api',
    'graphql',
    '-f',
    `query=${UW_GRAPH_QUERY}`,
    '-f',
    'owner=acme',
    '-f',
    'name=app',
    '-F',
    'number=42',
  ]
  const variants = [
    ['changed document', valid.map((arg) => (arg === `query=${UW_GRAPH_QUERY}` ? `${arg}\n# changed` : arg))],
    [
      'additional operation',
      valid.map((arg) => (arg === `query=${UW_GRAPH_QUERY}` ? `${arg}\nmutation { updateSomething }` : arg)),
    ],
    ['duplicate query', [...valid, '-f', `query=${UW_GRAPH_QUERY}`]],
    ['duplicate variable', [...valid, '-f', 'owner=other']],
    ['unknown field', [...valid, '-f', 'unexpected=value']],
    [
      'secret field and header',
      [...valid, '-f', 'unknown=fixture-secret-argument', '-H', 'Authorization: fixture-secret-credential'],
    ],
    ['operation name', [...valid, '-f', 'operationName=Other']],
    ['extra flag', [...valid, '--paginate']],
    ['explicit GET', [...valid, '--method', 'GET']],
  ] as const
  for (const [label, args] of variants) {
    expect(githubPreparationKind(args), label).toBe('gh-write')
    const cohort = createPreparationCohort()
    await cohort.run(() => trackPreparationGhOperation(args, async () => 'transport-returned'))
    cohort.seal()
    const host = await cohort.join()
    if (host.status !== 'joined') throw new Error(`fixture-cohort-not-joined:${label}`)
    expectUnattributedWrite(
      reconcileRecoveryHostEffects({
        host,
        publications: [],
        target: { repository: 'acme/app', pr: 7, head: 'a'.repeat(40) },
      }),
      args,
    )
  }
})

it('qualifies the exact installed GraphQL read contracts and holds altered transports', async () => {
  const call = (query: string, fields: string[]) => [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    ...fields.flatMap((field) => ['-f', field]),
  ]
  const catalogueFields = [
    'owner=acme',
    'name=app',
    ...Array.from({ length: 22 }, (_, index) => `e${index}=HEAD:path-${index}`),
  ]
  const genuine = [
    call(BLOB_QUERY, ['owner=acme', 'name=app', 'expression=HEAD:src/save.ts']),
    call(PULLS_QUERY, ['owner=acme', 'name=app']),
    call(PULLS_QUERY, ['owner=acme', 'name=app', 'cursor=next', 'branch=feat/42-save']),
    call(AUTH_COMMENT_QUERY, ['id=fixture-node']),
    call(catalogueQuery(22), catalogueFields),
  ]
  const changed = genuine.flatMap((args) => [
    args.map((arg) => (arg.startsWith('query=') ? `${arg}\n# modified` : arg)),
    [...args, '-f', 'unknown=value'],
    [...args, '-f', 'operationName=Other'],
    [...args, '--method', 'GET'],
    [...args, '--paginate'],
    [...args, '-f', 'query=mutation{}'],
  ])
  changed.push(call(catalogueQuery(22), [...catalogueFields.slice(0, -1), 'e20=duplicate']))
  const target = { repository: 'acme/app', pr: 7, head: 'a'.repeat(40) }
  for (const [expected, cases] of [
    ['gh-read', genuine],
    ['gh-write', changed],
  ] as const) {
    for (const args of cases) {
      expect(githubPreparationKind(args)).toBe(expected)
      const cohort = createPreparationCohort()
      await cohort.run(() => trackPreparationGhOperation(args, async () => 'transport-returned'))
      cohort.seal()
      const host = await cohort.join()
      if (host.status !== 'joined') throw new Error('fixture-cohort-not-joined')
      const result = reconcileRecoveryHostEffects({ host, publications: [], target })
      if (expected === 'gh-read') expect(result).toEqual({ status: 'qualified', reservedPublications: [] })
      else expectUnattributedWrite(result, args)
    }
  }
})

it('qualifies the real PR body read but holds altered or ambiguous requests', async () => {
  const calls: string[][] = []
  const body = await readPrBody(
    '/fixture',
    7,
    async (_cwd, args) => {
      calls.push(args)
      return JSON.stringify({ data: { repository: { pullRequest: { body: 'body', lastEditedAt: null } } } })
    },
    'acme/app',
  )
  expect(body).toEqual({ body: 'body', lastEditedAt: null })
  const actual = calls[0]
  if (actual === undefined) throw new Error('fixture-pr-body-query-not-issued')
  expect(actual.slice(4)).toEqual(['-f', 'owner=acme', '-f', 'name=app', '-F', 'number=7'])
  const query = actual[3]
  if (query === undefined) throw new Error('fixture-pr-body-query-missing')
  const variants = [
    actual.map((arg) => (arg === query ? `${arg}\n# changed` : arg)),
    actual.map((arg) => (arg === query ? `${arg}\nmutation { updateSomething }` : arg)),
    [...actual, '-f', `query=mutation { updateSomething }`],
    [...actual, '-F', 'number=8'],
    [...actual, '-f', 'operationName=Other'],
    [...actual, '-f', 'unexpected=value'],
    [...actual, '--method', 'GET'],
    [...actual, '--paginate'],
  ]
  const target = { repository: 'acme/app', pr: 7, head: 'a'.repeat(40) }
  for (const [expected, cases] of [
    ['gh-read', [actual]],
    ['gh-write', variants],
  ] as const) {
    for (const args of cases) {
      expect(githubPreparationKind(args)).toBe(expected)
      const cohort = createPreparationCohort()
      await cohort.run(() => trackPreparationGhOperation(args, async () => 'transport-returned'))
      cohort.seal()
      const host = await cohort.join()
      if (host.status !== 'joined') throw new Error('fixture-cohort-not-joined')
      const result = reconcileRecoveryHostEffects({ host, publications: [], target })
      if (expected === 'gh-read') expect(result).toEqual({ status: 'qualified', reservedPublications: [] })
      else expectUnattributedWrite(result, args)
    }
  }
})
