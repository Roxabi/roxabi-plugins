import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import { scopeKey, type UwGraphObservation, WAYFINDER_LABELS } from '../../engine/uw-graph.ts'
import { githubScope } from '../github/transport.ts'
import type { GitHubOptions } from '../github/types.ts'
import { metadataChangeDiagnostic, sameMetadata } from './uw-graph-metadata.ts'
import { page } from './uw-graph-page.ts'
import type { Connection, ConnectionName, GraphqlIssue, IssueRef, PartialNode } from './uw-graph-shape.ts'
import { rawSource } from './uw-spec.ts'

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

function refScope(ref: IssueRef): Scope {
  return githubScope(ref.repository.nameWithOwner, ref.number)
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
  base: GraphqlIssue,
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
      if (!sameMetadata(base, next))
        diagnostics.push(metadataChangeDiagnostic(scope, connection, pageNumber, cursor, base, next))
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
  firstPage: PromiseSettledResult<GraphqlIssue>,
): Promise<{ node: PartialNode | null; diagnostics: UwDiagnostic[] }> {
  if (firstPage.status === 'rejected') {
    const error: unknown = firstPage.reason
    return {
      node: null,
      diagnostics: [incomplete(scope, 'state', 1, undefined, error instanceof Error ? error.message : String(error))],
    }
  }
  const base = firstPage.value
  const [labelPages, childPages, blockerPages] = await Promise.all([
    collectPages(scope, options, 'labels', base, base.labels),
    collectPages(scope, options, 'children', base, base.subIssues),
    collectPages(scope, options, 'blockers', base, base.blockedBy),
  ])
  const labels = labelPages.nodes.map((entry) => entry.name)
  const children = childPages.nodes.map(refScope)
  const blockers = blockerPages.nodes.map(refScope)
  const diagnostics = [...labelPages.diagnostics, ...childPages.diagnostics, ...blockerPages.diagnostics]
  if (base.repository.nameWithOwner !== scope.repository)
    diagnostics.push(
      incomplete(
        scope,
        'state',
        1,
        undefined,
        `Repository identity ${scope.repository} does not match GitHub canonical name ${base.repository.nameWithOwner}`,
      ),
    )
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

function enqueueAdjacent(node: PartialNode, descendantsOnly: boolean, queued: Set<string>, queue: Scope[]): void {
  const adjacentNodes = descendantsOnly ? node.children : [node.node.parent, ...node.children, ...node.blockers]
  for (const adjacent of adjacentNodes) {
    if (adjacent !== null && !queued.has(scopeKey(adjacent))) {
      queued.add(scopeKey(adjacent))
      queue.push(adjacent)
    }
  }
}

async function loadClosure(
  root: Scope,
  options: GitHubOptions,
  descendantsOnly = false,
): Promise<{ partial: Map<string, PartialNode>; diagnostics: UwDiagnostic[] }> {
  const queue: Scope[] = [root]
  const queued = new Set([scopeKey(root)])
  const partial = new Map<string, PartialNode>()
  const diagnostics: UwDiagnostic[] = []
  while (queue.length > 0) {
    const scopes = queue.splice(0, 2)
    const firstPages = await Promise.allSettled(
      scopes.map((scope) =>
        page(scope, options, { labelsCursor: undefined, childrenCursor: undefined, blockersCursor: undefined }),
      ),
    )
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index] as Scope
      const read = await readNode(scope, options, firstPages[index] as PromiseSettledResult<GraphqlIssue>)
      diagnostics.push(...read.diagnostics)
      if (read.node === null) continue
      partial.set(scopeKey(scope), read.node)
      enqueueAdjacent(read.node, descendantsOnly, queued, queue)
    }
  }
  return { partial, diagnostics }
}

function reciprocalDiagnostics(partial: ReadonlyMap<string, PartialNode>): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  for (const partialNode of partial.values()) {
    for (const child of partialNode.children) {
      const observed = partial.get(scopeKey(child))
      if (
        observed !== undefined &&
        (observed.node.parent === null || scopeKey(observed.node.parent) !== scopeKey(partialNode.node.uw))
      ) {
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
    const parent = partialNode.node.parent === null ? undefined : partial.get(scopeKey(partialNode.node.parent))
    if (parent !== undefined && !parent.children.some((child) => scopeKey(child) === scopeKey(partialNode.node.uw))) {
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
  const nodes = [...partial.values()].map((entry) => entry.node)
  const rootNode = partial.get(scopeKey(root))
  if (diagnostics.length === 0 && rootNode !== undefined) {
    return { status: 'complete', root, nodes, observedAt: rootNode.node.updatedAt }
  }
  return { status: 'incomplete', root, nodes, observedAt: rootNode?.node.updatedAt ?? null, diagnostics }
}

/** Read only the root and its native descendants; never follow parent or blocker edges. */
export async function readUwSubtree(root: Scope, options: GitHubOptions): Promise<UwGraphObservation> {
  const { partial, diagnostics } = await loadClosure(root, options, true)
  diagnostics.push(...reciprocalDiagnostics(partial))
  const nodes = [...partial.values()].map((entry) => entry.node)
  const rootNode = partial.get(scopeKey(root))
  const parent = rootNode?.node.parent
  if (parent !== null && parent !== undefined && partial.has(scopeKey(parent)))
    diagnostics.push(incomplete(root, 'parent', 1, undefined, 'Native child relations cycle back to the subtree root'))
  if (diagnostics.length === 0 && rootNode !== undefined)
    return { status: 'complete', root, nodes, observedAt: rootNode.node.updatedAt }
  return { status: 'incomplete', root, nodes, observedAt: rootNode?.node.updatedAt ?? null, diagnostics }
}
