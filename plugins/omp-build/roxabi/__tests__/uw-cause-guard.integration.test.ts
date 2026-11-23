import { describe, expect, it } from 'vitest'
import {
  createIssueWriter,
  type IssueRef,
  type IssueWriteObservation,
  type IssueWritePorts,
  type NativeIssueWritePlan,
} from '../../../issue-triage/skills/shared/domain/issue-write.ts'
import { type CauseEffectGuard, guardedCauseWriter } from '../uw-cause-guard.ts'
import { guardParentInsertions } from '../uw-parent-insertion.ts'

// Declared native issue facts only: this does not authenticate a Native host or operator consent.
const issue = (number: number, repository = 'acme/app'): IssueRef => ({ repository, number })
const key = (ref: IssueRef) => `${ref.repository}#${ref.number}`
const activeParent = issue(1)
const inactiveParent = issue(2)
const existingChild = issue(3)
const createdChild = issue(99)
const foreignParent = issue(1, 'other/app')

function observed(ref: IssueRef): IssueWriteObservation {
  return {
    issue: ref,
    title: `Issue ${ref.number}`,
    body: `Body ${ref.number}`,
    updatedAt: '2026-10-27T12:00:00Z',
    nativeState: { state: 'OPEN', stateReason: null },
    labels: [],
    parent: null,
    children: [],
    blockers: [],
  }
}

function plan(relations: Partial<NativeIssueWritePlan['relations']> = {}): NativeIssueWritePlan {
  return {
    repository: 'acme/app',
    title: 'New issue',
    body: 'Declared new issue',
    labels: { add: ['size:S'], remove: [] },
    relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [], ...relations },
  }
}

function world(options: { loseCreateReturn?: boolean; extraActive?: readonly IssueRef[] } = {}) {
  const facts = new Map(
    [activeParent, inactiveParent, existingChild, foreignParent].map((ref) => [key(ref), observed(ref)]),
  )
  const active = new Set([activeParent, foreignParent, ...(options.extraActive ?? [])].map(key))
  const requireIssue = (ref: IssueRef) => {
    const value = facts.get(key(ref))
    if (!value) throw new Error(`Undeclared native issue ${key(ref)}`)
    return value
  }
  const raw: IssueWritePorts = {
    async read(ref) {
      return structuredClone(requireIssue(ref))
    },
    async create(input) {
      const ref = issue(99, input.repository)
      if (facts.has(key(ref))) throw new Error('Native allocation already exists')
      facts.set(key(ref), { ...observed(ref), title: input.title, body: input.body })
      if (options.loseCreateReturn) throw new Error('Native create response lost')
      return ref
    },
    async patch(ref, input) {
      const value = requireIssue(ref)
      value.title = input.title ?? value.title
      value.body = input.body
    },
    async updateLabels(ref, input) {
      const value = requireIssue(ref)
      value.labels = [...value.labels.filter((label) => !input.remove.includes(label)), ...input.add]
    },
    async addChild(parent, child) {
      const parentValue = requireIssue(parent)
      const childValue = requireIssue(child)
      if (childValue.parent !== null) throw new Error('Child already has a parent')
      parentValue.children = [...parentValue.children, { ...child }]
      childValue.parent = { ...parent }
    },
    async removeChild(parent, child) {
      const parentValue = requireIssue(parent)
      const childValue = requireIssue(child)
      parentValue.children = parentValue.children.filter((ref) => key(ref) !== key(child))
      if (childValue.parent !== null && key(childValue.parent) === key(parent)) childValue.parent = null
    },
    async addBlocker(ref, blocker) {
      const value = requireIssue(ref)
      requireIssue(blocker)
      value.blockers = [...value.blockers, { ...blocker }]
    },
    async removeBlocker(ref, blocker) {
      const value = requireIssue(ref)
      value.blockers = value.blockers.filter((item) => key(item) !== key(blocker))
    },
    async setNativeState(ref, effect) {
      requireIssue(ref).nativeState = effect
    },
  }
  const ordinary = guardParentInsertions(raw, async (parent) => {
    requireIssue(parent)
    if (active.has(key(parent))) throw new Error('cause-parent-active')
  })
  return { facts, raw, ordinary }
}

/** Exercise a fresh declared native read on every guarded effect; this is not consent authentication. */
function freshFactGuard(ports: IssueWritePorts): CauseEffectGuard {
  return async ({ created }) => {
    await ports.read(activeParent)
    if (created !== null) await ports.read(created)
  }
}

describe('ordinary guarded cause creation (declared native facts)', () => {
  it('keeps ordinary inactive insertion working and ordinary active insertion held', async () => {
    const permitted = world()
    const result = await createIssueWriter(permitted.ordinary).create(plan({ parent: inactiveParent }))
    expect(result).toMatchObject({ status: 'written', observed: { issue: createdChild, parent: inactiveParent } })
    expect((await permitted.raw.read(inactiveParent)).children).toEqual([createdChild])

    const refused = world()
    const held = await createIssueWriter(refused.ordinary).create(plan({ parent: activeParent }))
    expect(held).toMatchObject({
      status: 'partial',
      issue: createdChild,
      completed: ['create', 'labels'],
      diagnostics: [
        expect.objectContaining({ code: 'write-failed', message: expect.stringContaining('cause-parent-active') }),
      ],
    })
    expect((await refused.raw.read(activeParent)).children).toEqual([])
    expect((await refused.raw.read(createdChild)).parent).toBeNull()

    const updating = world()
    const expected = await updating.raw.read(existingChild)
    const update = await createIssueWriter(updating.ordinary).update(
      existingChild,
      plan({ parent: activeParent }),
      expected,
    )
    expect(update).toMatchObject({
      status: 'partial',
      issue: existingChild,
      completed: ['labels'],
      diagnostics: [
        expect.objectContaining({ code: 'write-failed', message: expect.stringContaining('cause-parent-active') }),
      ],
    })
    expect((await updating.raw.read(activeParent)).children).toEqual([])
    expect((await updating.raw.read(existingChild)).parent).toBeNull()

    const ordinaryCause = world()
    const causeWriter = guardedCauseWriter(ordinaryCause.ordinary, createIssueWriter, freshFactGuard(ordinaryCause.raw))
    const causeHeld = await causeWriter.create(plan({ parent: activeParent }))
    expect(causeHeld).toMatchObject({
      status: 'partial',
      issue: createdChild,
      completed: ['create', 'labels'],
      diagnostics: [
        expect.objectContaining({ code: 'write-failed', message: expect.stringContaining('cause-parent-active') }),
      ],
    })
    expect((await ordinaryCause.raw.read(activeParent)).children).toEqual([])
    expect((await ordinaryCause.raw.read(createdChild)).parent).toBeNull()
  })

  it.each([issue(4), foreignParent])('does not authorize another parent $repository#$number', async (wrongParent) => {
    const state = world({ extraActive: [wrongParent] })
    if (!state.facts.has(key(wrongParent))) state.facts.set(key(wrongParent), observed(wrongParent))
    const writer = guardedCauseWriter(state.ordinary, createIssueWriter, freshFactGuard(state.raw))
    const result = await writer.create(plan({ parent: wrongParent }))
    expect(['partial', 'refused']).toContain(result.status)
    if (result.status === 'partial')
      expect(result).toMatchObject({ issue: createdChild, completed: ['create', 'labels'] })
    expect((await state.raw.read(wrongParent)).children).toEqual([])
    expect((await state.raw.read(activeParent)).children).toEqual([])
    if (state.facts.has(key(createdChild))) expect((await state.raw.read(createdChild)).parent).toBeNull()
  })

  it('keeps an existing-child move under ordinary parent policy', async () => {
    const state = world({ extraActive: [createdChild] })
    const writer = guardedCauseWriter(state.ordinary, createIssueWriter, freshFactGuard(state.raw))
    const result = await writer.create(plan({ addChildren: [existingChild] }))
    expect(result).toMatchObject({ status: 'partial', issue: createdChild, completed: ['create', 'labels'] })
    expect((await state.raw.read(createdChild)).children).toEqual([])
    expect((await state.raw.read(existingChild)).parent).toBeNull()
  })

  it('does not infer a created identity when the native create response is lost', async () => {
    const state = world({ loseCreateReturn: true })
    const writer = guardedCauseWriter(state.ordinary, createIssueWriter, freshFactGuard(state.raw))
    const result = await writer.create(plan({ parent: inactiveParent }))
    expect(result).toMatchObject({ status: 'uncertain', completed: [] })
    expect((await state.raw.read(createdChild)).parent).toBeNull()
    const before = await state.raw.read(existingChild)
    const update = await writer.update(existingChild, plan({ parent: activeParent }), before)
    expect(update).toMatchObject({ status: 'partial', issue: existingChild, completed: ['labels'] })
    expect((await state.raw.read(existingChild)).parent).toBeNull()
    expect((await state.raw.read(activeParent)).children).toEqual([])
  })

  it('rechecks cancellation after creation and labels and retains the actual partial issue', async () => {
    const state = world()
    const abort = new AbortController()
    const guard: CauseEffectGuard = async ({ primitive, created }) => {
      if (
        primitive === 'labels' &&
        created?.repository === createdChild.repository &&
        created.number === createdChild.number
      )
        abort.abort('cancelled before attachment')
      if (primitive === 'add-child' && abort.signal.aborted) throw new Error('cause-effect-cancelled')
    }
    const writer = guardedCauseWriter(state.ordinary, createIssueWriter, guard)
    const result = await writer.create(plan({ parent: inactiveParent }))
    expect(result).toMatchObject({
      status: 'partial',
      issue: createdChild,
      completed: ['create', 'labels'],
      diagnostics: [
        expect.objectContaining({ code: 'write-failed', message: expect.stringContaining('cause-effect-cancelled') }),
      ],
    })
    expect(await state.raw.read(createdChild)).toMatchObject({ labels: ['size:S'], parent: null })
    expect((await state.raw.read(inactiveParent)).children).toEqual([])
  })
})
