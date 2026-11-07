import { readUwCompletionObservation } from '../adapters/github-workflow/uw-observation.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { FixtureNativeWorld } from './action-input-fixtures.ts'
export async function readDeclaredNativeWorld(
  world: FixtureNativeWorld,
  catalogues: () => ReviewClassCatalogues,
  options: { stopAuthor?: string } = {},
) {
  const key = (scope: Scope) => `${scope.repository}\0${scope.target}`
  const nodes = new Map(world.nodes.map((node) => [key(node.scope), node]))
  const histories = new Map(world.histories.map((history) => [key(history.source.scope), history]))
  const pulls = new Map(world.pullRequests.map((pull) => [key(pull.scope), pull]))
  const commits = new Map(world.commits.map((commit) => [`${commit.repository}\0${commit.sha}`, commit]))
  const comparisons = new Map(
    world.comparisons.map((entry) => [`${entry.repository}\0${entry.base}\0${entry.head}`, entry]),
  )
  if (
    pulls.size !== world.pullRequests.length ||
    commits.size !== world.commits.length ||
    comparisons.size !== world.comparisons.length
  )
    throw new Error('Fixture world declares duplicate PRs, commits, or comparisons')
  if (nodes.size !== world.nodes.length || histories.size !== world.histories.length)
    throw new Error('Fixture world declares duplicate native scopes or histories')
  const reference = (scope: Scope) => ({
    number: Number(scope.target.slice(scope.target.lastIndexOf('#') + 1)),
    repository: { nameWithOwner: scope.repository },
  })
  const page = (entries: readonly unknown[]) => ({
    nodes: entries,
    pageInfo: { hasNextPage: false, endCursor: null },
  })
  const graphql = (args: readonly string[]) => {
    const owner = args.find((arg) => arg.startsWith('owner='))?.slice(6)
    const name = args.find((arg) => arg.startsWith('name='))?.slice(5)
    const repository = `${owner}/${name}`
    if (!world.nodes.some((node) => node.scope.repository === repository))
      throw new Error(`Undeclared native repository ${repository}`)
    const number = args.find((arg) => arg.startsWith('number='))?.slice(7)
    if (number === undefined && args.some((arg) => arg.startsWith('query=') && arg.includes('pullRequests(first:100')))
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: page(
              world.pullRequests
                .filter((pull) => pull.scope.repository === repository)
                .map((pull) => ({
                  ...reference(pull.scope),
                  headRefName: pull.branch,
                  baseRefName: pull.base,
                })),
            ),
          },
        },
      })
    if (
      number === undefined ||
      !args.some((arg) => arg.startsWith('query=') && arg.includes('blockedBy') && arg.includes('subIssues'))
    )
      throw new Error('Undeclared native GraphQL query')
    const scope = { repository, target: `${repository}#${number}` }
    const node = nodes.get(key(scope))
    if (node === undefined) throw new Error(`Undeclared native issue ${scope.target}`)
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            ...reference(scope),
            title: node.title,
            body: node.body,
            updatedAt: node.updatedAt,
            state: node.state,
            stateReason: node.stateReason,
            parent: node.parent === null ? null : reference(node.parent),
            labels: page(node.labels.map((name) => ({ name }))),
            subIssues: page(node.children.map(reference)),
            blockedBy: page(node.blockers.map(reference)),
          },
        },
      },
    })
  }
  const commitResponse = (match: RegExpExecArray) => {
    const commit = commits.get(`${match[1]}\0${match[2]}`)
    if (commit === undefined) throw new Error(`Undeclared native commit ${match[2]}`)
    return JSON.stringify({ sha: commit.sha, parents: commit.parents.map((sha) => ({ sha })) })
  }
  const comparisonResponse = (match: RegExpExecArray) => {
    const comparison = comparisons.get(`${match[1]}\0${match[2]}\0${match[3]}`)
    if (comparison === undefined) throw new Error(`Undeclared native comparison ${match[2]}...${match[3]}`)
    const offset = (Number(match[4]) - 1) * 100
    const entries = comparison.commits.slice(offset, offset + 100).map((sha) => {
      const commit = commits.get(`${comparison.repository}\0${sha}`)
      if (commit === undefined) throw new Error(`Undeclared native commit ${sha}`)
      return { sha, parents: commit.parents.map((parent) => ({ sha: parent })) }
    })
    return JSON.stringify({ status: comparison.status, total_commits: comparison.commits.length, commits: entries })
  }
  const pullResponse = (args: readonly string[]) => {
    const repository = args[4]
    const scope = { repository: repository ?? '', target: `${repository}#${args[2]}` }
    const pull = pulls.get(key(scope))
    if (pull === undefined) throw new Error(`Undeclared native PR ${scope.target}`)
    return JSON.stringify({
      number: reference(scope).number,
      state: pull.state,
      headRefOid: pull.head,
      headRefName: pull.branch,
      baseRefName: pull.base,
      baseRefOid: pull.baseTip,
      mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
      author: pull.author === null ? null : { login: pull.author },
    })
  }
  const commentsResponse = (args: readonly string[]) => {
    const match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] ?? '')
    if (match === null) throw new Error(`Undeclared native request ${args.join(' ')}`)
    const repository = match[1]
    if (repository === undefined) throw new Error(`Undeclared native request ${args.join(' ')}`)
    const scope = { repository, target: `${repository}#${match[2]}` }
    const history = histories.get(key(scope))
    if (history === undefined) throw new Error(`Undeclared native history ${scope.target}`)
    const offset = (Number(match[3]) - 1) * 100
    return JSON.stringify(
      history.source.comments.slice(offset, offset + 100).map((comment) => ({
        id: comment.nativeId,
        body: comment.body,
        user: comment.author === null ? null : { login: comment.author },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      })),
    )
  }
  const observation = await readUwCompletionObservation(
    world.root,
    {
      cwd: '/fixture',
      readAuthor: 'operator',
      ...options,
      gh: async (_cwd, args) => {
        if (args[1] === 'graphql') return graphql(args)
        if (args[0] === 'pr' && args[1] === 'view') return pullResponse(args)
        const commitMatch = /^repos\/([^/]+\/[^/]+)\/git\/commits\/([a-f0-9]{40})$/.exec(args[1] ?? '')
        if (commitMatch !== null) return commitResponse(commitMatch)
        const comparisonMatch =
          /^repos\/([^/]+\/[^/]+)\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=(\d+)$/.exec(
            args[1] ?? '',
          )
        if (comparisonMatch !== null) return comparisonResponse(comparisonMatch)
        return commentsResponse(args)
      },
    },
    async () => catalogues(),
    world.nodes.map((node) => node.scope),
    world.histories,
  )
  return observation
}

export async function observeDeclaredNativeWorld(
  world: FixtureNativeWorld,
  catalogues: () => ReviewClassCatalogues,
  options: { stopAuthor?: string } = {},
) {
  const observation = await readDeclaredNativeWorld(world, catalogues, options)
  if (observation.status !== 'complete')
    throw new Error(`Fixture native observation is incomplete: ${JSON.stringify(observation.diagnostics)}`)
  return { histories: observation.histories, catalogues: observation.catalogues, observation }
}
