import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { UW_GRAPH_QUERY } from '../../adapters/github-native/uw-graph-query.ts'
import { renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { threeDeliveredChildren } from '../../engine/__tests__/uw-delivery-proof-fixture.ts'
import { scopeKey } from '../../engine/uw-graph.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'
import { closeLinkedWorld } from './uw-close-linked-fixture.ts'

it.each([false, true])(
  'does not treat native closure as delivery when review proof disappears; closed=%s',
  async (closed) => {
    const f = await closeLinkedWorld({ closed })
    f.removeReview()
    const result = await f.operations.closeLinked(f.request)
    expect(result).toMatchObject({
      status: 'refused',
      diagnostics: [expect.objectContaining({ code: 'close-linked-completion-changed' })],
    })
    expect(f.state()).toEqual(
      closed ? { state: 'CLOSED', stateReason: 'COMPLETED' } : { state: 'OPEN', stateReason: null },
    )
  },
)

it('closes only the canonically bound complete UW and reads back its unchanged proof', async () => {
  const f = await closeLinkedWorld()
  expect(f.state()).toEqual({ state: 'OPEN', stateReason: null })
  const result = await f.operations.closeLinked(f.request)
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
  expect(result.status, JSON.stringify(result)).toBe('written')
  if (result.status !== 'written') throw new Error('Expected confirmed close')
  expect(result.value.completion.completions.get(scopeKey(f.leaf.uw))).toEqual(f.request.completion)
  expect(result.value.observation.graph.nodes.find((node) => node.uw.target === f.leaf.uw.target)?.native).toEqual(
    f.state(),
  )
})

it.each(['uw', 'pr', 'mandate', 'head', 'vector', 'sources'] as const)(
  'refuses a stale or foreign %s without closing',
  async (change) => {
    const f = await closeLinkedWorld()
    const r = f.request
    const request = (() => {
      switch (change) {
        case 'uw':
          return { ...r, uw: { ...r.uw, target: 'acme/app#43' } }
        case 'pr':
          return { ...r, pullRequest: { ...r.pullRequest, repository: 'other/app', target: 'other/app#142' } }
        case 'mandate':
          return { ...r, mandate: { ...r.mandate, recordId: 'foreign-mandate' } }
        case 'head':
          return { ...r, completion: { ...r.completion, code: { ...r.completion.code, head: f.leaf.base } } }
        case 'vector':
          return {
            ...r,
            completion: {
              ...r.completion,
              versionVector: [
                { ...r.completion.versionVector[0], version: 'e'.repeat(64) },
                ...r.completion.versionVector.slice(1),
              ] as typeof r.completion.versionVector,
            },
          }
        case 'sources':
          return {
            ...r,
            completion: {
              ...r.completion,
              sources: r.completion.sources.filter((source) => source.kind !== 'workflow-binding'),
            },
          }
      }
    })()
    const result = await f.operations.closeLinked(request)
    expect(result).toMatchObject({
      status: 'refused',
      diagnostics: [
        expect.objectContaining({
          code: change === 'vector' ? 'close-linked-completion-changed' : 'close-linked-binding-changed',
        }),
      ],
    })
    expect(f.state()).toEqual({ state: 'OPEN', stateReason: null })
  },
)

it('refuses when the actual PR head changes after preparation', async () => {
  const f = await closeLinkedWorld()
  f.changedHead()
  expect(await f.operations.closeLinked(f.request)).toMatchObject({
    status: 'refused',
    diagnostics: [expect.objectContaining({ code: 'close-linked-binding-changed' })],
  })
  expect(f.state()).toEqual({ state: 'OPEN', stateReason: null })
})

it('refuses a native state drift before the write rather than overwriting it', async () => {
  const f = await closeLinkedWorld({ race: 'native-before-write' })
  const result = await f.operations.closeLinked(f.request)
  expect(result).toMatchObject({ status: 'refused' })
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })
})

it.each([
  ['proof-after-write', 'close-linked-readback-mismatch'],
  ['unreadable-after-write', 'readback-unconfirmed'],
  ['lost-effect', 'write-failed'],
] as const)('reports %s as partial while retaining the observed native effect', async (race, code) => {
  const f = await closeLinkedWorld({ race })
  const result = await f.operations.closeLinked(f.request)
  expect(result).toMatchObject({ status: 'partial', uw: f.leaf.uw, diagnostics: [expect.objectContaining({ code })] })
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
})

it('accepts an already completed native state only with the current full proof', async () => {
  const f = await closeLinkedWorld({ closed: true })
  const result = await f.operations.closeLinked(f.request)
  expect(result.status, JSON.stringify(result)).toBe('written')
  if (result.status !== 'written') throw new Error('Expected current proof')
  expect(result.value.completion.completions.get(scopeKey(f.leaf.uw))).toEqual(f.request.completion)
  f.changedHead()
  expect(await f.operations.closeLinked(f.request)).toMatchObject({
    status: 'refused',
    diagnostics: [expect.objectContaining({ code: 'close-linked-binding-changed' })],
  })
  expect(f.state()).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
})

it('refuses before closing when the final binding read observes accepted sibling tier drift', async () => {
  await threeDeliveredChildren(
    {
      p0: 'a'.repeat(40),
      merges: ['b', 'c', 'd'].map((value) => value.repeat(40)),
      heads: ['1', '2', '3'].map((value) => value.repeat(40)),
      parentHead: 'e'.repeat(40),
      trees: ['4', '5', '6'].map((value) => value.repeat(40)),
      baseTrees: ['7', '4', '5'].map((value) => value.repeat(40)),
      mergeTrees: ['4', '5', '6'].map((value) => value.repeat(40)),
      parentTree: 'f'.repeat(40),
      diff: new TextEncoder().encode('diff --git a/fixture.txt b/fixture.txt\n'),
    },
    [{ id: 'C1', statement: 'Save keeps the selected region' }],
    'planned',
    async (world) => {
      const [leaf, sibling] = world.reviews
      if (!leaf || !sibling) throw new Error('Expected accepted siblings')
      const binding = leaf.binding
      if (binding.kind !== 'workflow-binding') throw new Error('Expected canonical workflow binding')
      const mandateId = binding.payload.mandate.recordId
      expect(world.parent.payload.children.map((child) => child.scope)).toContainEqual(sibling.uw)

      async function attempt(drift: boolean) {
        let state: { state: 'OPEN' | 'CLOSED'; stateReason: string | null } = { state: 'OPEN', stateReason: null }
        let rootReads = 0
        let racing = false
        const events: string[] = []
        const leafNumber = Number(leaf.uw.target.split('#')[1])
        const siblingNumber = Number(sibling.uw.target.split('#')[1])
        function isClosePatch(args: string[]): boolean {
          return (
            args[0] === 'api' &&
            args[1] === '--method' &&
            args[2] === 'PATCH' &&
            args[3] === `repos/acme/app/issues/${leafNumber}` &&
            args.includes('state=closed') &&
            args.includes('state_reason=completed')
          )
        }
        function observeGraph(response: string, number: number): string {
          if (number === leafNumber && racing) rootReads++
          const graph = JSON.parse(response)
          if (number === leafNumber) Object.assign(graph.data.repository.issue, state)
          if (drift && racing && rootReads >= 3 && number === siblingNumber) {
            graph.data.repository.issue.labels.nodes = [{ name: 'size:F-lite' }]
            events.push('sibling-tier-drift-observed')
          }
          return JSON.stringify(graph)
        }
        const gh: Gh = async (cwd, args) => {
          if (isClosePatch(args)) {
            events.push('close-patch')
            state = { state: 'CLOSED', stateReason: 'COMPLETED' }
            return '{}'
          }
          const response = await world.gh(cwd, args)
          if (args[0] !== 'api' || args[1] !== 'graphql' || args[3] !== `query=${UW_GRAPH_QUERY}`) return response
          return observeGraph(response, Number(args[9]?.slice('number='.length)))
        }
        const operations = await createInstalledUwOperations({
          cwd: '/simulated',
          gh,
          readAuthor: 'operator',
          operator: {
            async executeConfirmed() {
              throw new Error('No operator mutation authorized')
            },
          },
        })
        const before = await operations.readUw(leaf.uw)
        const completion = before.completion.completions.get(scopeKey(leaf.uw))
        expect(before.observation.status).toBe('complete')
        expect(completion?.state).toBe('complete')
        if (completion?.state !== 'complete') throw new Error('Expected complete inherited leaf')
        racing = true
        const result = await operations.closeLinked({
          uw: leaf.uw,
          pullRequest: leaf.pullRequest,
          mandate: { scope: leaf.uw, kind: 'mandate', recordId: mandateId },
          completion,
        })
        return { result, events, state }
      }

      const control = await attempt(false)
      expect(control.result.status, JSON.stringify(control.result)).toBe('written')
      expect(control.state).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
      expect(control.events).toEqual(['close-patch'])

      const raced = await attempt(true)
      expect(raced.events).toContain('sibling-tier-drift-observed')
      expect(raced.result).toMatchObject({ status: 'refused' })
      expect(raced.events).not.toContain('close-patch')
      expect(raced.state).toEqual({ state: 'OPEN', stateReason: null })
    },
  )
})

it('holds a delivered leaf when its outer ancestor has a stable material Spec change', async () => {
  await threeDeliveredChildren(
    {
      p0: 'a'.repeat(40),
      merges: ['b', 'c', 'd'].map((value) => value.repeat(40)),
      heads: ['1', '2', '3'].map((value) => value.repeat(40)),
      parentHead: 'e'.repeat(40),
      trees: ['4', '5', '6'].map((value) => value.repeat(40)),
      baseTrees: ['7', '4', '5'].map((value) => value.repeat(40)),
      mergeTrees: ['4', '5', '6'].map((value) => value.repeat(40)),
      parentTree: 'f'.repeat(40),
      diff: new TextEncoder().encode('diff --git a/fixture.txt b/fixture.txt\n'),
    },
    [{ id: 'C1', statement: 'Save keeps the selected region' }],
    'planned',
    async (world) => {
      const leaf = world.reviews[0]
      const originalLeaf = world.observation.graph.nodes.find((node) => node.uw.target === leaf?.uw.target)
      if (!leaf || !originalLeaf || leaf.binding.kind !== 'workflow-binding')
        throw new Error('Expected delivered inherited leaf and binding')
      const revised = canonicalSpec({
        format: 'omp-build-spec-content/1',
        criteria: [{ id: 'C1', statement: 'Save keeps the selected region with revised requirements' }],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      })
      if (!revised.ok) throw new Error('Expected a conformant revised parent Spec')
      expect(revised.value.version).not.toBe(world.parent.payload.ownSpec.version)
      const revisedBody = renderIssueSpecBody(revised.value, { complexity: 1 })
      const mandateId = leaf.binding.payload.mandate.recordId

      async function attempt(materialChange: boolean) {
        let changed = false
        let state: { state: 'OPEN' | 'CLOSED'; stateReason: string | null } = { state: 'OPEN', stateReason: null }
        const effects: string[] = []
        function isClosePatch(args: string[]): boolean {
          return (
            args[0] === 'api' &&
            args[1] === '--method' &&
            args[2] === 'PATCH' &&
            args[3] === 'repos/acme/app/issues/201' &&
            args.includes('state=closed') &&
            args.includes('state_reason=completed')
          )
        }
        function observeGraph(response: string, number: string | undefined): string {
          const graph = JSON.parse(response)
          if (number === 'number=201') Object.assign(graph.data.repository.issue, state)
          if (changed && number === 'number=200') {
            graph.data.repository.issue.body = revisedBody
            graph.data.repository.issue.updatedAt = '2026-10-28T12:00:00.000Z'
          }
          return JSON.stringify(graph)
        }
        const gh: Gh = async (cwd, args) => {
          if (isClosePatch(args)) {
            effects.push('close-patch')
            state = { state: 'CLOSED', stateReason: 'COMPLETED' }
            return '{}'
          }
          const response = await world.gh(cwd, args)
          if (args[0] !== 'api' || args[1] !== 'graphql' || args[3] !== `query=${UW_GRAPH_QUERY}`) return response
          return observeGraph(response, args[9])
        }
        const operations = await createInstalledUwOperations({
          cwd: '/simulated',
          gh,
          readAuthor: 'operator',
          operator: {
            async executeConfirmed() {
              throw new Error('No operator mutation authorized')
            },
          },
        })
        const baseline = await operations.readUw(leaf.uw)
        const completion = baseline.completion.completions.get(scopeKey(leaf.uw))
        expect(baseline.observation.status).toBe('complete')
        if (completion?.state !== 'complete') throw new Error('Expected valid inherited completion before change')
        const request = {
          uw: leaf.uw,
          pullRequest: leaf.pullRequest,
          mandate: { scope: leaf.uw, kind: 'mandate' as const, recordId: mandateId },
          completion,
        }
        changed = materialChange
        const current = await operations.readUw(leaf.uw)
        const result = await operations.closeLinked(request)
        return { current, result, effects, state }
      }

      const control = await attempt(false)
      expect(control.result.status, JSON.stringify(control.result)).toBe('written')
      expect(control.effects).toEqual(['close-patch'])
      expect(control.state).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })

      const changed = await attempt(true)
      const parent = changed.current.observation.graph.nodes.find((node) => node.uw.target === world.parentScope.target)
      const currentLeaf = changed.current.observation.graph.nodes.find((node) => node.uw.target === leaf.uw.target)
      expect(parent?.raw.body).toBe(revisedBody)
      expect(parent?.raw.lastEditedAt).toBe('2026-10-28T12:00:00.000Z')
      expect(currentLeaf?.raw.body).toBe(originalLeaf.raw.body)
      expect({
        completion: changed.current.completion.completions.get(scopeKey(leaf.uw))?.state,
        result: changed.result,
        effects: changed.effects,
        state: changed.state,
      }).toMatchObject({
        completion: expect.stringMatching(/^(not-complete|indeterminate|abandoned)$/),
        result: { status: 'refused' },
        effects: [],
        state: { state: 'OPEN', stateReason: null },
      })
    },
  )
})
