import { describe, expect, it } from 'vitest'
import { githubScope } from '../github/transport.ts'
import type { Gh } from '../github/types.ts'
import { readUwGraph } from '../github-native/uw-graph.ts'

function deferred() {
  return Promise.withResolvers<void>()
}

// Give the in-process reader a finite number of turns, then release all gates even on the serial implementation.
async function enteredWithin(promise: Promise<void>): Promise<boolean> {
  let entered = false
  void promise.then(() => {
    entered = true
  })
  for (let turn = 0; turn < 20 && !entered; turn += 1) {
    const next = Promise.withResolvers<void>()
    setImmediate(next.resolve)
    await next.promise
  }
  return entered
}

function variable(args: string[], name: string): string | undefined {
  return args
    .flatMap((arg, index) => (arg === '-f' || arg === '-F' ? [args[index + 1] ?? ''] : []))
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function page<T>(values: readonly T[], cursor: string | undefined) {
  const offset = cursor === undefined ? 0 : Number(cursor)
  const nodes = values.slice(offset, offset + 100)
  const next = offset + nodes.length
  return {
    nodes,
    pageInfo: { hasNextPage: next < values.length, endCursor: next < values.length ? String(next) : null },
  }
}

function fixture(number: number, args: string[]) {
  const ref = (issue: number) => ({ number: issue, repository: { nameWithOwner: 'acme/app' } })
  const labels = number === 1 ? [] : Array.from({ length: 101 }, (_, index) => ({ name: `label-${index}` }))
  const blockers = number === 3 ? Array.from({ length: 101 }, () => ref(1)) : []
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number,
          title: `UW ${number}`,
          body: `body ${number}`,
          updatedAt: `2026-10-27T12:00:0${number}Z`,
          state: 'OPEN',
          stateReason: null,
          repository: { nameWithOwner: 'acme/app' },
          parent: number === 1 ? null : ref(1),
          labels: page(labels, variable(args, 'labelsCursor')),
          subIssues: page(number === 1 ? [ref(2), ref(3)] : [], variable(args, 'childrenCursor')),
          blockedBy: page(blockers, variable(args, 'blockersCursor')),
        },
      },
    },
  })
}

function cursorFor(args: string[]) {
  for (const connection of ['labels', 'children', 'blockers']) {
    const cursor = variable(args, `${connection}Cursor`)
    if (cursor !== undefined) return `${connection}:${cursor}`
  }
  return 'first'
}

function graphTransport(unreadable: boolean) {
  const release2 = deferred()
  const release3 = deferred()
  const enteredBoth = deferred()
  const finished3 = deferred()
  const blockerEntered = deferred()
  const releaseBlocker = deferred()
  const firstEntries = new Set<number>()
  const state = {
    firstFinishes: [] as number[],
    requests: [] as string[],
    active: 0,
    peak: 0,
    firstPagesActive: 0,
    paginationOverlappedFirstPage: false,
  }

  function begin(number: number, cursor: string) {
    state.requests.push(`${number}:${cursor}`)
    state.active += 1
    state.peak = Math.max(state.peak, state.active)
    const heldFirst = cursor === 'first' && (number === 2 || number === 3)
    if (heldFirst) {
      state.firstPagesActive += 1
      firstEntries.add(number)
      if (firstEntries.size === 2) enteredBoth.resolve()
    } else if (cursor !== 'first' && state.firstPagesActive > 0) {
      state.paginationOverlappedFirstPage = true
    }
    return heldFirst
  }

  async function firstPage(number: number) {
    await (number === 2 ? release2.promise : release3.promise)
    state.firstFinishes.push(number)
    if (number === 3) finished3.resolve()
    if (number === 2 && unreadable) throw new Error('issue #2 is unreadable')
  }

  async function cursorPage(number: number, cursor: string) {
    if (number !== 3 || !unreadable) return
    if (cursor === 'blockers:100') {
      blockerEntered.resolve()
      await releaseBlocker.promise
    }
    if (cursor === 'labels:100') throw new Error('labels cursor failed')
  }

  const gh: Gh = async (_cwd, args) => {
    const number = Number(variable(args, 'number'))
    const cursor = cursorFor(args)
    const heldFirst = begin(number, cursor)
    try {
      if (heldFirst) await firstPage(number)
      await cursorPage(number, cursor)
      return fixture(number, args)
    } finally {
      if (heldFirst) state.firstPagesActive -= 1
      state.active -= 1
    }
  }

  async function releaseFirstPages() {
    const overlapped = await enteredWithin(enteredBoth.promise)
    release3.resolve()
    if (overlapped) await finished3.promise
    release2.resolve()
    return overlapped
  }

  async function releasePendingBlocker(isSettled: () => boolean) {
    const blockerStarted = await enteredWithin(blockerEntered.promise)
    let settledWhileBlocked = false
    if (blockerStarted) {
      const next = Promise.withResolvers<void>()
      setImmediate(next.resolve)
      await next.promise
      settledWhileBlocked = isSettled()
    }
    releaseBlocker.resolve()
    return { blockerStarted, settledWhileBlocked }
  }

  return { gh, state, releaseFirstPages, releasePendingBlocker }
}

describe('readUwGraph first-page composition', () => {
  it.each([false, true])('preserves closure order and drains failures (unreadable sibling: %s)', async (unreadable) => {
    const transport = graphTransport(unreadable)
    let settled = false
    const observation = readUwGraph(githubScope('acme/app', 1), { cwd: '/fixture', gh: transport.gh }).finally(() => {
      settled = true
    })
    const overlapped = await transport.releaseFirstPages()
    const pending = unreadable
      ? await transport.releasePendingBlocker(() => settled)
      : { blockerStarted: false, settledWhileBlocked: false }
    const graph = await observation
    const { firstFinishes, paginationOverlappedFirstPage, peak, active, requests } = transport.state

    expect(overlapped).toBe(true)
    expect(firstFinishes).toEqual([3, 2])
    expect(paginationOverlappedFirstPage).toBe(false)
    expect(peak).toBeLessThanOrEqual(3)
    expect(active).toBe(0)
    expect(requests.slice().sort()).toEqual(
      (unreadable
        ? ['1:first', '2:first', '3:first', '3:labels:100', '3:blockers:100']
        : ['1:first', '2:first', '2:labels:100', '3:first', '3:labels:100', '3:blockers:100']
      ).sort(),
    )
    expect(graph.nodes.map((node) => node.uw.target)).toEqual(
      unreadable ? ['acme/app#1', 'acme/app#3'] : ['acme/app#1', 'acme/app#2', 'acme/app#3'],
    )

    if (unreadable) {
      expect(pending.blockerStarted).toBe(true)
      expect(pending.settledWhileBlocked).toBe(false)
      expect(graph.status).toBe('incomplete')
      if (graph.status !== 'incomplete') throw new Error('expected incomplete graph')
      expect(graph.diagnostics).toEqual([
        {
          code: 'graph-incomplete',
          message: 'issue #2 is unreadable',
          related: [],
          location: { kind: 'native', uw: githubScope('acme/app', 2), connection: 'state', page: 1 },
        },
        {
          code: 'graph-incomplete',
          message: 'labels cursor failed',
          related: [],
          location: { kind: 'native', uw: githubScope('acme/app', 3), connection: 'labels', page: 2, cursor: '100' },
        },
      ])
    } else {
      expect(graph.status).toBe('complete')
      expect(graph.nodes[1]?.labels).toHaveLength(101)
      expect(graph.nodes[2]?.labels).toHaveLength(101)
      expect(graph.nodes[2]?.blockers).toHaveLength(101)
    }
  })
})
