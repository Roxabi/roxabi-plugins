import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import { type UwGraphObservation, WAYFINDER_LABELS } from '../../engine/uw-graph.ts'
import { githubScope } from '../github/transport.ts'
import { type GitHubOptions, RECORD_REPOSITORY } from '../github/types.ts'
import { graphqlVariables, splitRepository } from '../github-workflow/client.ts'
import { UW_GRAPH_QUERY } from './uw-graph-query.ts'
import type { Connection, ConnectionName, GraphqlIssue, IssueRef, PartialNode } from './uw-graph-shape.ts'
import { rawSource } from './uw-spec.ts'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function asRepository(value: unknown): string | null {
  const record = asRecord(value)
  return typeof record?.nameWithOwner === 'string' ? record.nameWithOwner : null
}
function nativeDiagnostic(
  uw: Scope,
  code: string,
  message: string,
  connection: ConnectionName,
  page: number,
  cursor?: string,
): UwDiagnostic {
  return {
    code,
    message,
    location: { kind: 'native', uw, connection, page, ...(cursor === undefined ? {} : { cursor }) },
    related: [],
  }
}
function incomplete(
  uw: Scope,
  connection: ConnectionName,
  page: number,
  cursor: string | undefined,
  message: string,
): UwDiagnostic {
  return nativeDiagnostic(uw, 'graph-incomplete', message, connection, page, cursor)
}
function isPageInfo(value: unknown): value is { hasNextPage: boolean; endCursor: string | null } {
  const record = asRecord(value)
  return typeof record?.hasNextPage === 'boolean' && (typeof record.endCursor === 'string' || record.endCursor === null)
}
function isConnection(value: unknown): value is Connection<unknown> {
  const record = asRecord(value)
  return Array.isArray(record?.nodes) && isPageInfo(record.pageInfo)
}
function pageConnection<T>(
  issue: GraphqlIssue,
  connection: Extract<ConnectionName, 'labels' | 'children' | 'blockers'>,
): Connection<T> {
  if (connection === 'labels') return issue.labels as Connection<T>
  if (connection === 'children') return issue.subIssues as Connection<T>
  return issue.blockedBy as Connection<T>
}
function normalizeReason(value: string | null): string | null {
  return value?.toLowerCase() === 'completed' ? 'COMPLETED' : value
}

function validRef(value: unknown): boolean {
  const reference = asRecord(value)
  const repository = reference === null ? null : asRepository(reference.repository)
  return (
    reference !== null &&
    typeof reference.number === 'number' &&
    Number.isSafeInteger(reference.number) &&
    reference.number > 0 &&
    repository !== null &&
    RECORD_REPOSITORY.test(repository)
  )
}
function validLabels(value: unknown): boolean {
  return isConnection(value) && value.nodes.every((entry) => typeof asRecord(entry)?.name === 'string')
}
function validReferences(value: unknown): boolean {
  return isConnection(value) && value.nodes.every(validRef)
}
function parseIssue(value: unknown): GraphqlIssue | null {
  const issue = asRecord(value)
  const required =
    issue !== null &&
    typeof issue.number === 'number' &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    typeof issue.title === 'string' &&
    typeof issue.body === 'string' &&
    typeof issue.updatedAt === 'string' &&
    (issue.state === 'OPEN' || issue.state === 'CLOSED') &&
    (typeof issue.stateReason === 'string' || issue.stateReason === null) &&
    asRepository(issue.repository) !== null &&
    (issue.parent === null || validRef(issue.parent)) &&
    validLabels(issue.labels) &&
    validReferences(issue.subIssues) &&
    validReferences(issue.blockedBy)
  return required ? (issue as unknown as GraphqlIssue) : null
}
function refScope(ref: IssueRef): Scope {
  return githubScope(ref.repository.nameWithOwner, ref.number)
}

async function page(
  scope: Scope,
  options: GitHubOptions,
  cursors: Record<'labelsCursor' | 'childrenCursor' | 'blockersCursor', string | undefined>,
): Promise<GraphqlIssue> {
  const { owner, name } = splitRepository(scope.repository)
  const data = await graphqlVariables(options, UW_GRAPH_QUERY, {
    owner,
    name,
    number: Number(scope.target.slice(scope.target.lastIndexOf('#') + 1)),
    ...cursors,
  })
  const repository = asRecord(data)?.repository
  const issue = parseIssue(asRecord(repository)?.issue)
  if (issue === null || issue.repository.nameWithOwner !== scope.repository)
    throw new Error(`Native graph payload for ${scope.target} is incomplete`)
  return issue
}

type PageCursors = Record<'labelsCursor' | 'childrenCursor' | 'blockersCursor', string | undefined>
type PagedConnectionName = Extract<ConnectionName, 'labels' | 'children' | 'blockers'>

function cursorFor(connection: PagedConnectionName, cursor: string): PageCursors {
  if (connection === 'labels') return { labelsCursor: cursor, childrenCursor: undefined, blockersCursor: undefined }
  if (connection === 'children') return { labelsCursor: undefined, childrenCursor: cursor, blockersCursor: undefined }
  return { labelsCursor: undefined, childrenCursor: undefined, blockersCursor: cursor }
}

async function collectPages<T>(
  scope: Scope,
  options: GitHubOptions,
  connection: PagedConnectionName,
  initial: Connection<T>,
): Promise<{ nodes: T[]; diagnostics: UwDiagnostic[] }> {
  const nodes = [...initial.nodes]
  const diagnostics: UwDiagnostic[] = []
  const seen = new Set<string>()
  let current = initial
  let pageNumber = 1
  while (current.pageInfo.hasNextPage) {
    const cursor = current.pageInfo.endCursor
    if (cursor === null || cursor === '' || seen.has(cursor)) {
      diagnostics.push(
        incomplete(
          scope,
          connection,
          pageNumber,
          cursor ?? undefined,
          `Native ${connection} pagination is missing or repeats a cursor for ${scope.target}`,
        ),
      )
      break
    }
    seen.add(cursor)
    pageNumber += 1
    try {
      const next = await page(scope, options, cursorFor(connection, cursor))
      current = pageConnection<T>(next, connection)
      nodes.push(...current.nodes)
    } catch (error) {
      diagnostics.push(
        incomplete(scope, connection, pageNumber, cursor, error instanceof Error ? error.message : String(error)),
      )
      break
    }
  }
  return { nodes, diagnostics }
}

async function readNode(
  scope: Scope,
  options: GitHubOptions,
): Promise<{ node: PartialNode | null; diagnostics: UwDiagnostic[] }> {
  let base: GraphqlIssue
  try {
    base = await page(scope, options, { labelsCursor: undefined, childrenCursor: undefined, blockersCursor: undefined })
  } catch (error) {
    return {
      node: null,
      diagnostics: [incomplete(scope, 'state', 1, undefined, error instanceof Error ? error.message : String(error))],
    }
  }
  const [labelPages, childPages, blockerPages] = await Promise.all([
    collectPages(scope, options, 'labels', base.labels),
    collectPages(scope, options, 'children', base.subIssues),
    collectPages(scope, options, 'blockers', base.blockedBy),
  ])
  const labels = labelPages.nodes.map((entry) => entry.name)
  const children = childPages.nodes.map(refScope)
  const blockers = blockerPages.nodes.map(refScope)
  const diagnostics = [...labelPages.diagnostics, ...childPages.diagnostics, ...blockerPages.diagnostics]
  const parent = base.parent === null ? null : refScope(base.parent)
  if (base.parent !== null && parent === null)
    diagnostics.push(
      incomplete(scope, 'children', 1, undefined, `Native parent reference for ${scope.target} is malformed`),
    )
  const raw = rawSource(scope.target, base.body, base.updatedAt)
  return {
    node: {
      labels,
      children,
      blockers,
      node: {
        uw: scope,
        title: base.title,
        raw,
        updatedAt: base.updatedAt,
        labels,
        wayfinderLabels: labels.filter((label) => (WAYFINDER_LABELS as readonly string[]).includes(label)),
        parent,
        children,
        blockers,
        native: { state: base.state, stateReason: normalizeReason(base.stateReason) },
      },
    },
    diagnostics,
  }
}

async function loadClosure(
  root: Scope,
  options: GitHubOptions,
): Promise<{ partial: Map<string, PartialNode>; diagnostics: UwDiagnostic[] }> {
  const queue: Scope[] = [root]
  const queued = new Set([root.target])
  const partial = new Map<string, PartialNode>()
  const diagnostics: UwDiagnostic[] = []
  while (queue.length > 0) {
    const scope = queue.shift() as Scope
    const read = await readNode(scope, options)
    diagnostics.push(...read.diagnostics)
    if (read.node === null) continue
    partial.set(scope.target, read.node)
    for (const adjacent of [read.node.node.parent, ...read.node.children, ...read.node.blockers]) {
      if (adjacent !== null && !queued.has(adjacent.target)) {
        queued.add(adjacent.target)
        queue.push(adjacent)
      }
    }
  }
  return { partial, diagnostics }
}

function reciprocalDiagnostics(partial: ReadonlyMap<string, PartialNode>): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  for (const partialNode of partial.values()) {
    for (const child of partialNode.children) {
      const observed = partial.get(child.target)
      if (observed !== undefined && observed.node.parent?.target !== partialNode.node.uw.target) {
        diagnostics.push(
          incomplete(
            partialNode.node.uw,
            'children',
            1,
            undefined,
            `Native child ${child.target} does not reciprocally name ${partialNode.node.uw.target} as parent`,
          ),
        )
      }
    }
    const parent = partialNode.node.parent === null ? undefined : partial.get(partialNode.node.parent.target)
    if (parent !== undefined && !parent.children.some((child) => child.target === partialNode.node.uw.target)) {
      diagnostics.push(
        incomplete(
          partialNode.node.uw,
          'parent',
          1,
          undefined,
          `Native parent ${parent.node.uw.target} does not reciprocally list ${partialNode.node.uw.target} as a child`,
        ),
      )
    }
  }
  return diagnostics
}

/**
 * Reads structural closure only. It does not classify tier, decide D8, or admit a UW.
 * All three native connections page independently; any unreadability produces `incomplete`.
 */
export async function readUwGraph(root: Scope, options: GitHubOptions): Promise<UwGraphObservation> {
  const { partial, diagnostics } = await loadClosure(root, options)
  diagnostics.push(...reciprocalDiagnostics(partial))
  const nodes = [...partial.values()].map((entry) => entry.node)
  const rootNode = partial.get(root.target)
  if (diagnostics.length === 0 && rootNode !== undefined) {
    return { status: 'complete', root, nodes, observedAt: rootNode.node.updatedAt }
  }
  return { status: 'incomplete', root, nodes, observedAt: rootNode?.node.updatedAt ?? null, diagnostics }
}
