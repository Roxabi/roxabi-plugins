import { describe, expect, it } from 'vitest'
import { calculateTier } from '../domain/complexity'
import {
  createIssueWriter,
  type IssueRef,
  type IssueWriteObservation,
  type IssueWritePorts,
  type NativeIssueWritePlan,
} from '../domain/issue-write'

const repo = 'Acme/app'
const issue = (number: number, repository = repo): IssueRef => ({ repository, number })

function observation(number: number, patch: Partial<IssueWriteObservation> = {}): IssueWriteObservation {
  return {
    issue: issue(number),
    title: `Issue ${number}`,
    body: `Body ${number}`,
    updatedAt: `2026-10-27T00:00:0${number}Z`,
    labels: [],
    parent: null,
    children: [],
    blockers: [],
    ...patch,
  }
}

function plan(patch: Partial<NativeIssueWritePlan> = {}): NativeIssueWritePlan {
  return {
    repository: repo,
    body: 'Replacement body',
    labels: { add: [], remove: [] },
    relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
    ...patch,
  }
}

function statefulPorts(seed: readonly IssueWriteObservation[]): {
  ports: IssueWritePorts
  observations: Map<string, IssueWriteObservation>
  calls: string[]
} {
  const observations = new Map(
    seed.map((value) => [`${value.issue.repository}#${value.issue.number}`, structuredClone(value)]),
  )
  const requiredIssue = (ref: IssueRef): IssueWriteObservation => {
    const value = observations.get(`${ref.repository}#${ref.number}`)
    if (!value) throw new Error(`Missing fixture issue ${ref.repository}#${ref.number}`)
    return value
  }
  const calls: string[] = []
  const read = async (ref: IssueRef): Promise<IssueWriteObservation> => {
    calls.push(`read:${ref.repository}#${ref.number}`)
    const value = observations.get(`${ref.repository}#${ref.number}`)
    if (!value) throw new Error('missing')
    return structuredClone(value)
  }
  const touch = (value: IssueWriteObservation): void => {
    value.updatedAt = `${value.updatedAt}.next`
  }
  const ports: IssueWritePorts = {
    read,
    async create(input) {
      const created = observation(99, { issue: issue(99, input.repository), title: input.title, body: input.body })
      observations.set(`${input.repository}#99`, created)
      calls.push('create')
      return created.issue
    },
    async patch(ref, input) {
      const value = requiredIssue(ref)
      if (input.title !== undefined) value.title = input.title
      value.body = input.body
      touch(value)
      calls.push('patch')
    },
    async updateLabels(ref, input) {
      const value = requiredIssue(ref)
      value.labels = [...value.labels.filter((label) => !input.remove.includes(label)), ...input.add]
      touch(value)
      calls.push('labels')
    },
    async addChild(parent, child) {
      const parentIssue = requiredIssue(parent)
      const childIssue = requiredIssue(child)
      parentIssue.children = [...parentIssue.children, child]
      childIssue.parent = parent
      touch(parentIssue)
      touch(childIssue)
      calls.push(`add-child:${child.number}`)
    },
    async removeChild(parent, child) {
      const parentIssue = requiredIssue(parent)
      const childIssue = requiredIssue(child)
      parentIssue.children = parentIssue.children.filter(
        (ref) => ref.number !== child.number || ref.repository !== child.repository,
      )
      if (childIssue.parent?.number === parent.number && childIssue.parent.repository === parent.repository)
        childIssue.parent = null
      touch(parentIssue)
      touch(childIssue)
      calls.push(`remove-child:${child.number}`)
    },
    async addBlocker(ref, blocker) {
      const value = requiredIssue(ref)
      value.blockers = [...value.blockers, blocker]
      touch(value)
      calls.push(`add-blocker:${blocker.number}`)
    },
    async removeBlocker(ref, blocker) {
      const value = requiredIssue(ref)
      value.blockers = value.blockers.filter(
        (ref) => ref.number !== blocker.number || ref.repository !== blocker.repository,
      )
      touch(value)
      calls.push(`remove-blocker:${blocker.number}`)
    },
  }
  return { ports, observations, calls }
}

describe('calculateTier', () => {
  it.each([
    [
      { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
      { score: 1, tier: 'S' },
    ],
    [
      { files: 4, risk: 3, architecture: 3, unknowns: 4, domains: 4 },
      { score: 4, tier: 'F-lite' },
    ],
    [
      { files: 4, risk: 4, architecture: 4, unknowns: 4, domains: 4 },
      { score: 4, tier: 'F-lite' },
    ],
    [
      { files: 7, risk: 7, architecture: 7, unknowns: 7, domains: 7 },
      { score: 7, tier: 'F-full' },
    ],
    [
      { files: 10, risk: 10, architecture: 10, unknowns: 10, domains: 10 },
      { score: 10, tier: 'F-full' },
    ],
  ])('maps the exact weighted κ boundary %#', (factors, expected) => {
    expect(calculateTier(factors)).toEqual(expected)
  })

  it('rejects factors outside integral 1..10', () => {
    expect(() => calculateTier({ files: 0, risk: 1, architecture: 1, unknowns: 1, domains: 1 })).toThrow(/files/)
    expect(() => calculateTier({ files: 1, risk: 1.5, architecture: 1, unknowns: 1, domains: 1 })).toThrow(/risk/)
  })
})

describe('createIssueWriter', () => {
  it('refuses a stale asserted issue without any mutation', async () => {
    const current = observation(1)
    const { ports, calls } = statefulPorts([current])
    const expected = { ...current, body: 'stale body' }

    const result = await createIssueWriter(ports).update(issue(1), plan(), expected)

    expect(result).toMatchObject({ status: 'refused', diagnostics: [{ code: 'write-conflict' }] })
    expect(calls).toEqual(['read:Acme/app#1'])
  })

  it('allows descriptive updatedAt drift while retaining asserted-fact preconditions', async () => {
    const current = observation(1)
    const { ports, calls } = statefulPorts([current])
    const expected = { ...current, updatedAt: '2020-01-01T00:00:00Z' }

    const result = await createIssueWriter(ports).update(issue(1), plan(), expected)

    expect(result.status).toBe('written')
    expect(calls).toContain('patch')
  })

  it('validates plan values before reading or creating an issue', async () => {
    const { ports, calls } = statefulPorts([])

    const result = await createIssueWriter(ports).create(
      plan({ title: 'New issue', labels: { add: [''], remove: [] } }),
    )

    expect(result).toMatchObject({ status: 'refused', diagnostics: [{ code: 'write-invalid-label' }] })
    expect(calls).toEqual([])
  })

  it('writes every asserted native effect, including a cross-repository parent, then reads it back', async () => {
    const subject = observation(1, { labels: ['old'], children: [issue(3)], blockers: [issue(4)] })
    const parent = observation(2, { issue: issue(2, 'Other/repo') })
    const oldChild = observation(3)
    const blocker = observation(4)
    const child = observation(5)
    const { ports, observations, calls } = statefulPorts([subject, parent, oldChild, blocker, child])
    const writePlan = plan({
      title: 'Renamed',
      labels: { add: ['new'], remove: ['old'] },
      relations: {
        parent: issue(2, 'Other/repo'),
        addChildren: [issue(5)],
        removeChildren: [issue(3)],
        addBlockers: [issue(5)],
        removeBlockers: [issue(4)],
      },
    })

    const result = await createIssueWriter(ports).update(issue(1), writePlan, subject)

    expect(result.status).toBe('written')
    expect(observations.get('Acme/app#1')).toMatchObject({
      title: 'Renamed',
      body: 'Replacement body',
      labels: ['new'],
      parent: issue(2, 'Other/repo'),
      children: [issue(5)],
      blockers: [issue(5)],
    })
    expect(calls.filter((call) => !call.startsWith('read:'))).toEqual([
      'labels',
      'add-blocker:5',
      'remove-blocker:4',
      'add-child:1',
      'add-child:5',
      'remove-child:3',
      'patch',
    ])
  })

  it('reports completed mutations and the actual ref when a later write fails', async () => {
    const current = observation(1)
    const { ports } = statefulPorts([current])
    ports.patch = async () => {
      throw new Error('PATCH 422')
    }

    const result = await createIssueWriter(ports).update(
      issue(1),
      plan({ labels: { add: ['triaged'], remove: [] } }),
      current,
    )

    expect(result).toEqual({
      status: 'partial',
      issue: issue(1),
      completed: ['labels'],
      diagnostics: [expect.objectContaining({ code: 'write-failed', message: expect.stringContaining('PATCH 422') })],
    })
  })

  it('reports an unconfirmed create attempt without retrying or inventing an issue ref', async () => {
    const { ports, observations } = statefulPorts([])
    let createAttempts = 0
    ports.create = async (input) => {
      createAttempts += 1
      observations.set(
        `${input.repository}#99`,
        observation(99, { issue: issue(99, input.repository), title: input.title, body: input.body }),
      )
      throw new Error('connection closed after POST')
    }

    const result = await createIssueWriter(ports).create(plan({ title: 'New issue' }))

    expect(result).toEqual({
      status: 'uncertain',
      completed: [],
      diagnostics: [
        expect.objectContaining({
          code: 'create-unconfirmed',
          message: expect.stringContaining('connection closed after POST'),
        }),
      ],
    })
    expect(createAttempts).toBe(1)
    expect(observations.get('Acme/app#99')).toMatchObject({ title: 'New issue' })
  })

  it('creates once, then reports a readback mismatch rather than recreating it', async () => {
    const related = observation(2)
    const { ports, calls } = statefulPorts([related])
    ports.updateLabels = async () => {}

    const result = await createIssueWriter(ports).create(
      plan({
        title: 'New issue',
        labels: { add: ['required'], remove: [] },
        relations: { parent: issue(2), addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
      }),
    )

    expect(result).toMatchObject({
      status: 'partial',
      issue: issue(99),
      completed: ['create', 'labels', 'set-parent:Acme/app#2', 'patch'],
      diagnostics: [{ code: 'write-conflict' }],
    })
    expect(calls.filter((call) => call === 'create')).toHaveLength(1)
  })
})
