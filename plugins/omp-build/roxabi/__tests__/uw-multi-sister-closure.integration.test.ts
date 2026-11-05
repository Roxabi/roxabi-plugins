import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import { readComposedWorkflowHistory, recordsOf } from '../../dist/contracts.js'
import { installedMultiSisterFixture } from '../../testing/multi-sister-installed-fixture.ts'
import { withRoxabiGitHubPolicy } from '../github-policy.ts'
import { readAuthenticatedCause } from '../uw-cause-read.ts'
import { createInstalledUwReadPort } from '../uw-read-port.ts'

it.each(['intact', 'missing-identity', 'forged-identity', 'missing-source'] as const)(
  'creates one sister before reading and creating the next; first sister evidence is %s',
  async (evidence) => {
    const world = await installedMultiSisterFixture()
    const first = await world.operations.createSister(world.request(0))
    expect(first.status, JSON.stringify(first)).toBe('created')
    expect(world.confirmations()).toBe(1)
    expect(world.issues.get(42)?.blockers).toContain(43)
    const github = withRoxabiGitHubPolicy({ cwd: '/fixture', gh: world.gh, readAuthor: 'automation' })
    const sister = await readComposedWorkflowHistory([{ repository: 'acme/app', target: 'acme/app#43' }], github)
    expect(sister.ok, JSON.stringify(sister)).toBe(true)
    if (!sister.ok) throw new Error('created sister identity history is unreadable')
    const identity = recordsOf(sister.histories[0]).find((record) => record.kind === 'spec-identity')
    if (identity?.kind !== 'spec-identity') throw new Error('first sister identity missing after creation')
    if (evidence === 'missing-identity') world.comments.set(43, [])
    if (evidence === 'forged-identity') {
      world.comments.set(43, [nativeComment(800, wire({ ...identity, operationId: 'forged-identity-operation' }))])
    }
    if (evidence === 'missing-source') world.comments.set(44, [])
    const reader = createInstalledUwReadPort(github)
    const secondRef = world.request(1).disposition
    if (evidence === 'intact') {
      const second = await readAuthenticatedCause(secondRef, reader, github)
      expect(second.disposition.recordId).toBe(secondRef.recordId)
      expect(second.histories.map((history) => history.source.scope.target)).toContain('acme/app#43')
      const created = await (await world.newCommand()).createSister(world.request(1))
      expect(created.status, JSON.stringify(created)).toBe('created')
      expect(world.confirmations()).toBe(2)
      expect(world.issues.get(42)?.blockers).toEqual(expect.arrayContaining([43, 45]))
      expect(world.comments.get(45)?.some((comment) => comment.body.includes('kind=spec-identity'))).toBe(true)
      expect(world.comments.get(42)?.filter((comment) => comment.body.includes('kind=debt-receipt'))).toHaveLength(2)
    } else {
      await expect(readAuthenticatedCause(secondRef, reader, github)).rejects.toThrow()
      const refused = await (await world.newCommand()).createSister(world.request(1))
      expect(refused.status).toBe('refused')
      expect(world.confirmations()).toBe(1)
      expect(world.issues.has(45)).toBe(false)
    }
  },
)
