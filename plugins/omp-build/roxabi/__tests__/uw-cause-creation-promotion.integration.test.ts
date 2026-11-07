import { expect, it } from 'vitest'
import { readComposedWorkflowHistory, recordsOf } from '../../dist/contracts.js'
import { installedMultiSisterFixture } from '../../testing/multi-sister-installed-fixture.ts'
import { createInput } from '../../testing/uw-operations-fixture.ts'
import { withRoxabiGitHubPolicy } from '../github-policy.ts'

async function promotionWorld() {
  const world = await installedMultiSisterFixture(1, { report: true })
  const disposition = world.dispositions[0]
  if (disposition?.payload.outcome.state !== 'final' || disposition.payload.outcome.disposition !== 'report')
    throw new Error('missing assessed report disposition')
  const original = world.issues.get(42)
  if (!original) throw new Error('original issue missing')
  original.parent = 41
  world.issues.set(41, {
    title: 'Parent',
    body: '',
    labels: [],
    parent: null,
    blockers: [],
    state: 'OPEN',
    stateReason: null,
  })
  world.comments.set(41, [])
  const initial = createInput()
  const create = {
    ...initial,
    repository: 'acme/app',
    normalization: [],
    draft: {
      ...initial.draft,
      criteria: [{ kind: 'new' as const, draftKey: 'promotion', statement: 'Resolve the promoted report' }],
    },
    writes: {
      labels: { add: [], remove: [] },
      relations: {
        parent: { repository: 'acme/app', number: 41 },
        addChildren: [],
        removeChildren: [],
        addBlockers: [],
        removeBlockers: [],
      },
    },
  }
  const report = { scope: world.context.original, recordId: disposition.recordId, kind: 'cause-disposition' as const }
  return { world, create, report }
}

it('rejects promotion to a foreign parent while creating the otherwise identical local-parent request', async () => {
  const local = await promotionWorld()
  const localResult = await local.world.operations.promoteReport({
    report: local.report,
    create: local.create,
    reason: 'Create separate work',
  })
  expect(localResult.status, JSON.stringify(localResult)).toBe('created')
  expect(local.world.confirmations()).toBe(1)
  expect(local.world.issues.get(43)?.parent).toBe(41)

  const foreign = await promotionWorld()
  const listing = await foreign.world.operations.listReports(foreign.report.scope)
  expect(listing.ok, JSON.stringify(listing)).toBe(true)
  if (!listing.ok) throw new Error('foreign request report unavailable')
  expect(listing.value.reports.map((item) => item.ref)).toContainEqual(local.report)
  expect(foreign.report).toEqual(local.report)
  const originalComments = foreign.world.comments.get(42)?.length
  const foreignResult = await foreign.world.operations.promoteReport({
    report: foreign.report,
    create: {
      ...foreign.create,
      writes: {
        ...foreign.create.writes,
        relations: {
          ...foreign.create.writes.relations,
          parent: { repository: 'other/repo', number: 41 },
        },
      },
    },
    reason: 'Create separate work',
  })
  expect(foreignResult.status, JSON.stringify(foreignResult)).toBe('refused')
  expect(foreign.world.confirmations()).toBe(0)
  expect(foreign.world.issues.has(43)).toBe(false)
  expect(foreign.world.comments.get(42)?.length).toBe(originalComments)
})

it('promotes a report with a promotion receipt, never a debt receipt', async () => {
  const { world, create, report } = await promotionWorld()
  const result = await world.operations.promoteReport({
    report,
    create,
    reason: 'This report merits a separately scoped UW',
  })
  expect(result.status, JSON.stringify(result)).toBe('created')
  expect(world.confirmations()).toBe(1)
  const github = withRoxabiGitHubPolicy({ cwd: '/fixture', gh: world.gh, readAuthor: 'automation' })
  const read = await readComposedWorkflowHistory([world.context.original], github)
  expect(read.ok, JSON.stringify(read)).toBe(true)
  if (!read.ok || !read.histories[0]) throw new Error('promoted report history unavailable')
  const kinds = recordsOf(read.histories[0]).map((record) => record.kind)
  expect(kinds).toContain('cause-operation')
  expect(kinds).toContain('report-promotion')
  expect(kinds).not.toContain('debt-receipt')
  expect(world.comments.get(43)?.some((comment) => comment.body.includes('kind=spec-identity'))).toBe(true)
})
