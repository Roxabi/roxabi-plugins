import { UW_GRAPH_QUERY } from '../adapters/github-native/uw-graph-query.ts'
import type { PreparationOperationKind } from './preparation-cohort.ts'
import {
  AUTH_COMMENT_QUERY,
  BLOB_QUERY,
  CI_ROLLUP_QUERY,
  catalogueQuery,
  PR_BODY_QUERY,
  PULLS_QUERY,
} from './preparation-graphql.cjs'

function isUwGraphRead(args: readonly string[]): boolean {
  if (args[0] !== 'api' || args[1] !== 'graphql' || args[2] !== '-f' || args[3] !== `query=${UW_GRAPH_QUERY}`) {
    return false
  }
  const allowed: Record<string, true> = {
    owner: true,
    name: true,
    number: true,
    labelsCursor: true,
    childrenCursor: true,
    blockersCursor: true,
  }
  const seen = new Set<string>()
  for (let i = 4; i < args.length; i += 2) {
    if (args[i] !== '-f' && args[i] !== '-F') return false
    const field = args[i + 1]
    if (field === undefined) return false
    const separator = field.indexOf('=')
    const key = field.slice(0, separator)
    if (separator < 1 || !Object.hasOwn(allowed, key) || seen.has(key)) return false
    seen.add(key)
  }
  return seen.has('owner') && seen.has('name') && seen.has('number')
}

function isPrBodyGraphRead(args: readonly string[]): boolean {
  return (
    args.length === 10 &&
    args[0] === 'api' &&
    args[1] === 'graphql' &&
    args[2] === '-f' &&
    args[3] === `query=${PR_BODY_QUERY}` &&
    args[4] === '-f' &&
    args[5]?.startsWith('owner=') === true &&
    args[6] === '-f' &&
    args[7]?.startsWith('name=') === true &&
    args[8] === '-F' &&
    args[9]?.startsWith('number=') === true
  )
}

function graphFieldNames(args: readonly string[]): string[] | undefined {
  const names: string[] = []
  for (let i = 4; i < args.length; i += 2) {
    if (args[i] !== '-f') return undefined
    const field = args[i + 1]
    if (field === undefined) return undefined
    const separator = field.indexOf('=')
    if (separator < 1) return undefined
    names.push(field.slice(0, separator))
  }
  return names
}

function isKnownGraphRead(args: readonly string[]): boolean {
  if (isPrBodyGraphRead(args)) return true
  if (args[0] !== 'api' || args[1] !== 'graphql' || args[2] !== '-f' || !args[3]?.startsWith('query=')) {
    return false
  }
  const names = graphFieldNames(args)
  if (names === undefined) return false
  const query = args[3].slice('query='.length)
  if (query === BLOB_QUERY) return names.join(',') === 'owner,name,expression'
  if (query === AUTH_COMMENT_QUERY) return names.join(',') === 'id'
  if (query === CI_ROLLUP_QUERY)
    return names.join(',') === 'owner,name,sha' || names.join(',') === 'owner,name,sha,after'
  if (query === PULLS_QUERY) {
    return (
      names.join(',') === 'owner,name' ||
      names.join(',') === 'owner,name,cursor' ||
      names.join(',') === 'owner,name,branch' ||
      names.join(',') === 'owner,name,cursor,branch'
    )
  }
  const count = names.length - 2
  return (
    count > 0 &&
    names[0] === 'owner' &&
    names[1] === 'name' &&
    names.slice(2).every((name, index) => name === `e${index}`) &&
    query === catalogueQuery(count)
  )
}

export function githubPreparationKind(args: readonly string[]): PreparationOperationKind {
  if (isUwGraphRead(args) || isKnownGraphRead(args)) return 'gh-read'
  if (args[0] === 'api' && args[1] === 'graphql') return 'gh-write'
  const methodIndex = args.findIndex((arg) => arg === '--method' || arg === '-X')
  const method = methodIndex < 0 ? null : args[methodIndex + 1]?.toUpperCase()
  const hasFields = args.some((arg) => arg === '-f' || arg === '-F' || arg === '--field' || arg === '--raw-field')
  const isApi = args[0] === 'api'
  const isRead = isApi
    ? method === 'GET' || (method === null && !hasFields)
    : ['view', 'list', 'status', 'get'].includes(args[1] ?? '')
  if (isRead) return 'gh-read'
  if (isApi && method === 'POST' && args.some((arg) => /^repos\/[^/]+\/[^/]+\/issues\/[0-9]+\/comments$/.test(arg))) {
    return 'gh-append'
  }
  return 'gh-write'
}
