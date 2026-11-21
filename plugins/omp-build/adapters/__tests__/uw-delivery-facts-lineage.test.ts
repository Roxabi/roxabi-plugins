import { expect, it } from 'vitest'
import { actionInputDigest } from '../../engine/action-input.ts'
import { buildRecord, parseRecord } from '../../engine/record-construction.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { githubScope } from '../github/transport.ts'
import { createUwDeliveryFactReader } from '../github-workflow/uw-delivery-facts.ts'

const uw = githubScope('acme/app', 42)
const pr = githubScope('acme/app', 77)
const fixtures = roxabiWorkflowFixtures()
const legacy = fixtures.featureMandate(uw, { branch: 'feature/42', base: 'main' })
const parsedMandate = parseRecord({
  ...legacy,
  payload: { ...legacy.payload, config: { ...legacy.payload.config, productVersion: '0.18.8' } },
})
if (!parsedMandate.ok || parsedMandate.value.kind !== 'mandate') throw new Error('invalid bounded mandate fixture')
const mandate = parsedMandate.value
const start = fixtures.implementStart(mandate)
const original = fixtures.rejectedImplementResult(mandate)
const actionManifest = {
  ...original.payload.inputs.manifest,
  code: { ...original.payload.inputs.manifest.code, head: 'd'.repeat(40), referenceCommit: 'd'.repeat(40) },
}
const built = buildRecord({
  ...original,
  payload: {
    ...original.payload,
    inputs: {
      ...original.payload.inputs,
      manifest: actionManifest,
      fingerprint: actionInputDigest(actionManifest),
    },
  },
})
if (!built.ok || built.value.kind !== 'action-receipt') throw new Error('cannot construct factual range fixture')
const receipt = built.value
const authority = fixtures.historyFrom([mandate, start, receipt], 'operator')
const binding = fixtures.workflowBinding(pr, mandate, 'feature/42', 'main')
const prHistory = fixtures.historyFrom([binding], 'operator', 'operator', [authority])
const manifest = receipt.payload.inputs.manifest
const merge = 'e'.repeat(40)
const chain = Array.from({ length: 100 }, (_, index) => (index + 1).toString(16).padStart(40, '0'))
const commits = [...chain, manifest.code.head].map((sha, index, all) => ({
  sha,
  parents: [{ sha: index === 0 ? manifest.code.base : all[index - 1] }],
}))

function comparisonResponse(endpoint: string, failSecondPage: boolean): string | undefined {
  const base = manifest.code.base
  const range = /^repos\/acme\/app\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=(\d+)$/.exec(
    endpoint,
  )
  if (!range || range[1] !== base) return undefined
  const page = Number(range[3])
  if (range[2] === base) return JSON.stringify({ status: 'identical', total_commits: 0, commits: [] })
  if (range[2] !== manifest.code.head && range[2] !== merge) throw new Error(`undeclared comparison ${endpoint}`)
  if (range[2] === manifest.code.head && page === 2 && failSecondPage)
    throw new Error('comparison page two unavailable')
  const values = range[2] === merge ? [...commits, { sha: merge, parents: [{ sha: manifest.code.head }] }] : commits
  return JSON.stringify({
    status: 'ahead',
    total_commits: values.length,
    commits: values.slice((page - 1) * 100, page * 100),
  })
}

function pullEnumerationResponse(args: string[], failPullPage: boolean): string {
  if (failPullPage && args.some((arg) => arg.includes('cursor=next'))) throw new Error('pull page two unavailable')
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 77,
              headRefName: 'feature/42',
              baseRefName: 'main',
              repository: { nameWithOwner: 'acme/app' },
            },
          ],
          pageInfo: { hasNextPage: failPullPage, endCursor: failPullPage ? 'next' : null },
        },
      },
    },
  })
}

function reader(failSecondPage: boolean, failPullPage = false) {
  const requests: string[] = []
  const port = createUwDeliveryFactReader({
    cwd: '/fixture',
    readAuthor: 'operator',
    gh: async (_cwd, args) => {
      requests.push(args.join(' '))
      const endpoint = String(args[1] ?? '')
      if (endpoint === 'graphql') return pullEnumerationResponse(args, failPullPage)
      if (args[0] === 'pr')
        return JSON.stringify({
          number: 77,
          state: 'MERGED',
          headRefOid: manifest.code.head,
          headRefName: 'feature/42',
          baseRefName: 'main',
          baseRefOid: manifest.code.base,
          mergeCommit: { oid: merge },
          author: { login: 'operator' },
        })
      const base = manifest.code.base
      if (endpoint === `repos/acme/app/git/commits/${base}`) return JSON.stringify({ sha: base, parents: [] })
      if (endpoint === `repos/acme/app/git/commits/${manifest.code.head}`)
        return JSON.stringify(commits[commits.length - 1])
      if (endpoint === `repos/acme/app/git/commits/${merge}`)
        return JSON.stringify({ sha: merge, parents: [{ sha: manifest.code.head }] })
      const comparison = comparisonResponse(endpoint, failSecondPage)
      if (comparison !== undefined) return comparison
      throw new Error(`unexpected ${args.join(' ')}`)
    },
  })
  return { requests, read: () => port.read(uw, [authority, prHistory]) }
}

it('collects paginated range parents and the distinct actual PR merge commit', async () => {
  const source = reader(false)
  const result = await source.read()
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  expect(result.value.facts.pullRequests[0]).toMatchObject({
    head: manifest.code.head,
    mergeCommit: merge,
    state: 'MERGED',
  })
  expect(result.value.facts.commits.find((entry) => entry.code.commit === merge)?.parents).toEqual([manifest.code.head])
  expect(result.value.facts.commits.find((entry) => entry.code.commit === manifest.code.head)?.parents).toEqual([
    chain[99],
  ])
  expect(source.requests.some((entry) => entry.includes('page=2'))).toBe(true)
})

it('retains the merged PR and earlier commit parents if the next comparison page fails', async () => {
  const result = await reader(true).read()
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected partial observation')
  expect(result.partial.facts.pullRequests[0]?.mergeCommit).toBe(merge)
  expect(result.partial.facts.commits.some((entry) => entry.code.commit === chain[0])).toBe(true)
  expect(JSON.stringify(result.diagnostics)).toContain('comparison page two unavailable')
})

it('retains a bound PR and earlier facts when later PR enumeration fails', async () => {
  const result = await reader(false, true).read()
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected partial observation')
  expect(result.partial.facts.pullRequests[0]?.mergeCommit).toBe(merge)
  expect(result.partial.facts.commits.some((entry) => entry.code.commit === manifest.code.head)).toBe(true)
  expect(JSON.stringify(result.diagnostics)).toContain('pull page two unavailable')
})
