import { expect, it } from 'vitest'
import {
  createIssueWriter,
  type IssueWritePorts,
  type NativeIssueWritePlan,
} from '../../../issue-triage/skills/shared/domain/issue-write.ts'
import { guardedCauseWriter } from '../uw-cause-guard.ts'

const issue = { repository: 'acme/app', number: 2 }
const parent = { repository: 'acme/app', number: 1 }
const plan: NativeIssueWritePlan = {
  repository: issue.repository,
  title: 'New',
  body: 'Spec',
  labels: { add: [], remove: [] },
  relations: { parent, addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
}
function fixture() {
  const effects: string[] = []
  const ports: IssueWritePorts = {
    read: async (ref) => ({
      issue: ref,
      title: 'Parent',
      body: '',
      updatedAt: '',
      nativeState: { state: 'OPEN', stateReason: null },
      labels: [],
      parent: null,
      children: [],
      blockers: [],
    }),
    create: async () => {
      effects.push('create')
      return issue
    },
    patch: async () => {
      effects.push('patch')
    },
    updateLabels: async () => {
      effects.push('labels')
    },
    addChild: async () => {
      effects.push('add-child')
    },
    removeChild: async () => {
      effects.push('remove-child')
    },
    addBlocker: async () => {
      effects.push('add-blocker')
    },
    removeBlocker: async () => {
      effects.push('remove-blocker')
    },
    setNativeState: async () => {
      effects.push('native-state')
    },
  }
  return { effects, ports }
}

it('refuses before calling the issue writer when the parent is not inactive', async () => {
  const { effects, ports } = fixture()
  const writer = guardedCauseWriter(ports, createIssueWriter, async () => {
    throw new Error('parent active')
  })
  await expect(writer.create(plan)).resolves.toMatchObject({
    status: 'refused',
    diagnostics: [{ code: 'cause-parent-guard' }],
  })
  expect(effects).toEqual([])
})

it('preserves the known created issue as partial if the parent changes before the relation', async () => {
  const { effects, ports } = fixture()
  const writer = guardedCauseWriter(ports, createIssueWriter, async ({ primitive, created }) => {
    if (primitive === 'add-child') {
      expect(created).toEqual(issue)
      throw new Error('parent became active')
    }
  })
  await expect(writer.create(plan)).resolves.toMatchObject({ status: 'partial', issue, completed: ['create'] })
  expect(effects).toEqual(['create'])
})

it('keeps an unconfirmed native create uncertain instead of retrying', async () => {
  const { effects, ports } = fixture()
  ports.create = async () => {
    effects.push('create')
    throw new Error('response lost')
  }
  const writer = guardedCauseWriter(ports, createIssueWriter, async () => {})
  await expect(writer.create(plan)).resolves.toMatchObject({ status: 'uncertain' })
  expect(effects).toEqual(['create'])
})

it('guards the native state primitive exposed by the same writer', async () => {
  const { effects, ports } = fixture()
  const writer = guardedCauseWriter(ports, createIssueWriter, async ({ primitive }) => {
    if (primitive === 'native-state') throw new Error('parent changed')
  })
  const expected = await ports.read(issue)
  await expect(
    writer.setNativeState(issue, { state: 'CLOSED', stateReason: 'COMPLETED' }, expected),
  ).resolves.toMatchObject({ status: 'partial', issue })
  expect(effects).toEqual([])
})
