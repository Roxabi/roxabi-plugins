import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Contracts from '../../dist/contracts.js'
import { nativeObservationDigest } from '../../dist/contracts.js'
import type { Scope } from '../../engine/record-values.ts'
import { composedCauseEffectGuard } from '../uw-composed-cause-guard.ts'
import { rootObservation } from '../uw-installed-observation.ts'

const boundary = vi.hoisted(() => ({ read: vi.fn(), bind: vi.fn() }))
vi.mock('../../dist/contracts.js', async (load) => ({
  ...(await load<typeof Contracts>()),
  readUwCompletionObservation: boundary.read,
  bindExternalRef: boundary.bind,
}))

const scope = (number: number) => ({ repository: 'owner/repo', target: `owner/repo#${number}` })
const issue = (number: number) => ({ repository: 'owner/repo', number })
const parent = scope(1)
const moved = scope(2)
const child = scope(3)
const history = (uw: Scope) => ({ source: { scope: uw, comments: [] }, operations: [], diagnostics: [] })
const node = (uw: Scope, parentScope: Scope | null, children: Scope[]) => ({
  uw,
  title: uw.target,
  raw: { body: 'Body' },
  updatedAt: '2026-01-01T00:00:00.000Z',
  labels: [],
  parent: parentScope,
  children,
  blockers: [],
  native: { state: 'OPEN', stateReason: null },
})

function setup() {
  const originalHistory = history(parent)
  const before = {
    status: 'complete',
    graph: {
      status: 'complete',
      root: parent,
      observedAt: '2026-01-01T00:00:00.000Z',
      nodes: [node(parent, null, [moved]), node(moved, parent, [])],
    },
    histories: [originalHistory, history(moved)],
  }
  const native = rootObservation(parent, before as never)
  const nativeDigest = nativeObservationDigest({
    ...native,
    labels: [...native.labels],
    children: [...native.children],
    blockers: [...native.blockers],
  })
  const historyDigest = createHash('sha256').update(JSON.stringify(originalHistory)).digest('hex')
  const intent = {
    repository: parent.repository,
    target: parent.target,
    recordId: 'create:intent',
    kind: 'cause-operation',
    payload: {
      proposalDigest: 'd'.repeat(64),
      confirmation: { operationId: 'create' },
      proposal: {
        operation: 'create',
        operationId: 'create',
        parentAcceptance: { parent, nativeObservationDigest: nativeDigest, historyDigest },
        creation: {
          kind: 'sister',
          parentObservation: { parent, state: 'active' },
          relation: 'sister-blocked-by-original',
        },
        writes: { relations: { addChildren: [issue(2)] } },
        allocation: { assignments: [] },
      },
    },
  }
  const intentOperation = {
    recordId: intent.recordId,
    status: 'complete',
    authority: 'authority',
    kind: 'cause-operation',
    record: intent,
    parts: [],
  }
  const after = {
    ...before,
    graph: {
      ...before.graph,
      nodes: [node(parent, null, [child]), node(moved, child, []), node(child, parent, [moved])],
    },
    histories: [{ ...originalHistory, operations: [intentOperation] }, history(moved), history(child)],
  }
  boundary.read.mockResolvedValue(after)
  boundary.bind.mockReturnValue({ ok: true, value: intent })
  return {
    after,
    guard: composedCauseEffectGuard({
      github: {} as never,
      before: before as never,
      intent: intent as never,
      signal: new AbortController().signal,
    }),
  }
}

beforeEach(() => vi.clearAllMocks())

describe('confirmed composed creation effect guard', () => {
  it('permits exactly the planned existing child reparenting and old-parent removal', async () => {
    const { guard } = setup()
    await expect(guard({ primitive: 'patch', created: issue(3) })).resolves.toBeUndefined()
  })

  it('refuses an unrelated native edit during the same planned reparenting', async () => {
    const { guard, after } = setup()
    const node = after.graph.nodes[1]
    if (!node) throw new Error('Expected unrelated node')
    node.title = 'Unrelated edit'
    await expect(guard({ primitive: 'patch', created: issue(3) })).rejects.toThrow('composed-cause-native-stale')
  })
})
