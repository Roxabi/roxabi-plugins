import type { Gh } from '../adapters/github/types.ts'

export type GraphFixtureRef = number | { repository: string; number: number }
export type GraphFixture = {
  labels?: string[]
  body?: string
  updatedAt?: string
  children?: GraphFixtureRef[]
  blockers?: GraphFixtureRef[]
  parent?: GraphFixtureRef | null
  state?: 'OPEN' | 'CLOSED'
  stateReason?: string | null
  deny?: boolean
}

export function graphFixtureVariable(args: string[], name: string): string | undefined {
  return args
    .flatMap((arg, index) => (arg === '-f' || arg === '-F' ? [args[index + 1] ?? ''] : []))
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}
function page<T>(values: readonly T[], cursor: string | undefined, repeat = false) {
  const parsedCursor = cursor === undefined ? 0 : Number(cursor)
  const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0
  const nodes = values.slice(offset, offset + 100)
  const next = offset + nodes.length
  return {
    nodes,
    pageInfo: {
      hasNextPage: next < values.length,
      endCursor: next < values.length ? (repeat ? 'repeat' : String(next)) : null,
    },
  }
}

/** Keys are canonical repository#number; numeric keys declare issues in acme/app only. */
export function graphGh(fixtures: Record<string, GraphFixture>, repeatLabels = false, repeatChildren = false): Gh {
  const scope = (ref: GraphFixtureRef, repository: string) =>
    typeof ref === 'number' ? { repository, number: ref } : ref
  const node = (ref: GraphFixtureRef, repository: string) => {
    const item = scope(ref, repository)
    return { number: item.number, repository: { nameWithOwner: item.repository } }
  }
  const inferParent = (repository: string, number: number): GraphFixtureRef | null => {
    const parentEntry = Object.entries(fixtures).find(([key, candidate]) => {
      const parentRepository = key.includes('#') ? key.slice(0, key.lastIndexOf('#')) : 'acme/app'
      return candidate.children?.some((child) => {
        const selected = scope(child, parentRepository)
        return selected.repository === repository && selected.number === number
      })
    })
    if (parentEntry === undefined) return null
    const [key] = parentEntry
    const separator = key.lastIndexOf('#')
    return separator < 0
      ? { repository: 'acme/app', number: Number(key) }
      : { repository: key.slice(0, separator), number: Number(key.slice(separator + 1)) }
  }
  const issueProjection = (
    fixture: GraphFixture,
    repository: string,
    number: number,
    parent: GraphFixtureRef | null,
    args: string[],
  ) => ({
    number,
    title: `UW ${number}`,
    body: fixture.body ?? `body ${number}`,
    updatedAt: fixture.updatedAt ?? `2026-10-27T12:00:${String(number).padStart(2, '0')}Z`,
    state: fixture.state ?? 'OPEN',
    stateReason: fixture.stateReason ?? null,
    repository: { nameWithOwner: repository },
    parent: parent === null ? null : node(parent, repository),
    labels: page(
      (fixture.labels ?? []).map((name) => ({ name })),
      graphFixtureVariable(args, 'labelsCursor'),
      repeatLabels,
    ),
    subIssues: page(
      (fixture.children ?? []).map((child) => node(child, repository)),
      graphFixtureVariable(args, 'childrenCursor'),
      repeatChildren,
    ),
    blockedBy: page(
      (fixture.blockers ?? []).map((blocker) => node(blocker, repository)),
      graphFixtureVariable(args, 'blockersCursor'),
    ),
  })
  return async (_cwd, args) => {
    const repository = `${graphFixtureVariable(args, 'owner')}/${graphFixtureVariable(args, 'name')}`.toLowerCase()
    const number = Number(graphFixtureVariable(args, 'number'))
    const fixture =
      fixtures[`${repository}#${number}`] ?? (repository === 'acme/app' ? fixtures[String(number)] : undefined)
    if (!fixture || fixture.deny) throw new Error(`issue ${repository}#${number} is unreadable`)
    const parent = fixture.parent === undefined ? inferParent(repository, number) : fixture.parent
    return JSON.stringify({
      data: { repository: { issue: issueProjection(fixture, repository, number, parent, args) } },
    })
  }
}
