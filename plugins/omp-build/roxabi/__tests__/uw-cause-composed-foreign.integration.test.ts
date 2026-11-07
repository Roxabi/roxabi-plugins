import { afterEach, expect, it, vi } from 'vitest'
import { framed, nativeComment } from '../../adapters/__tests__/github-workflow-support.ts'
import type * as Contracts from '../../dist/contracts.js'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Result } from '../../engine/result.ts'
import type * as CreationSupport from '../uw-cause-creation-support.ts'
import type * as ProposalPreparation from '../uw-proposal-preparation.ts'
import { cleanupComposedScenario, type MutationWorld, preparationTap, scenario } from './uw-cause-composed-fixture.ts'
import { isolateViewerToken, releaseViewerToken } from './uw-normalization-observation.ts'

vi.mock('../uw-proposal-preparation.ts', async (importOriginal) => {
  const original = await importOriginal<typeof ProposalPreparation>()
  return {
    ...original,
    prepareCreateProposal: (...args: Parameters<typeof original.prepareCreateProposal>) => {
      const result = original.prepareCreateProposal(...args)
      if ('proposal' in result) preparationTap.onPrepared?.(result.proposal.operationId)
      return result
    },
  }
})

const intentTap = vi.hoisted(() => ({
  calls: [] as {
    before: Parameters<typeof CreationSupport.exactNewIntent>[0]
    after: Parameters<typeof CreationSupport.exactNewIntent>[1]
    id: string
  }[],
}))
vi.mock('../uw-cause-creation-support.ts', async (importOriginal) => {
  const original = await importOriginal<typeof CreationSupport>()
  return {
    ...original,
    exactNewIntent: (...args: Parameters<typeof original.exactNewIntent>) => {
      intentTap.calls.push({ before: args[0], after: args[1], id: args[2] })
      return original.exactNewIntent(...args)
    },
  }
})

const acceptanceTap = vi.hoisted(() => ({
  calls: [] as {
    input: Parameters<typeof Contracts.recheckComposedParentAcceptance>[0]
    result: Result<Extract<CanonicalRecord, { kind: 'operator-control' }>>
  }[],
}))
vi.mock('../../dist/contracts.js', async (importOriginal) => {
  const original = await importOriginal<typeof Contracts>()
  return {
    ...original,
    recheckComposedParentAcceptance: (...args: Parameters<typeof original.recheckComposedParentAcceptance>) => {
      const result = original.recheckComposedParentAcceptance(...args)
      acceptanceTap.calls.push({ input: args[0], result })
      return result
    },
  }
})

afterEach(() => {
  intentTap.calls.length = 0
  acceptanceTap.calls.length = 0
  releaseViewerToken()
  cleanupComposedScenario()
})

function addForeignIntent(world: MutationWorld, operationId: string): void {
  const comments = world.comments.get(42)
  if (!comments) throw new Error('Expected origin native comments')
  const id = encodeURIComponent(`${operationId}:intent`)
  comments.push({ ...nativeComment(999999, framed('cause-operation', id, id)), user: { login: 'intruder' } })
}

it('retains a preexisting foreign same-id creation claim across the actual confirmed intent cut', async () => {
  isolateViewerToken()
  let operationId = ''
  const run = await scenario(
    () => true,
    undefined,
    undefined,
    (world, id) => {
      operationId = id
      addForeignIntent(world, id)
    },
  )
  const cut = intentTap.calls.find((entry) => entry.id === `${operationId}:intent`)
  expect(cut, `Confirmed intent cut not reached: ${JSON.stringify(run.result)}`).toBeDefined()
  if (!cut) throw new Error('Expected actual confirmed intent cut')
  expect(cut.before.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ recordId: cut.id, kind: 'cause-operation', authority: 'foreign', record: null }),
    ]),
  )
  expect(cut.after.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ recordId: cut.id, kind: 'cause-operation', authority: 'foreign', record: null }),
      expect.objectContaining({
        recordId: cut.id,
        kind: 'cause-operation',
        authority: 'accounted',
        status: 'complete',
      }),
    ]),
  )
  const acceptance = acceptanceTap.calls.find((entry) => entry.input.operation.recordId === cut.id)
  expect(acceptance, `Parent creation delta not reached: ${JSON.stringify(run.result)}`).toBeDefined()
  if (!acceptance) throw new Error('Expected actual parent creation delta')
  expect(acceptance.input.before.status).toBe('complete')
  expect(acceptance.input.before.graph.status).toBe('complete')
  expect(acceptance.input.after.status).toBe('complete')
  const beforeHome = acceptance.input.before.histories.find(
    (history) => history.source.scope.target === cut.before.source.scope.target,
  )
  const afterHome = acceptance.input.after.histories.find(
    (history) => history.source.scope.target === cut.before.source.scope.target,
  )
  const beforeClaims = beforeHome?.operations.filter((entry) => entry.recordId === cut.id)
  expect(beforeClaims).toHaveLength(1)
  expect(beforeClaims?.[0]).toMatchObject({ authority: 'foreign', record: null })
  expect(afterHome?.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ recordId: cut.id, authority: 'foreign', record: null }),
      expect.objectContaining({
        recordId: cut.id,
        kind: 'cause-operation',
        authority: 'accounted',
        status: 'complete',
      }),
    ]),
  )
  expect(acceptance.result.ok, JSON.stringify(acceptance.result)).toBe(true)
  expect(run.result.status, JSON.stringify(run.result)).toBe('created')
})

it('refuses a foreign creation claim added after the sealed assessment cut', async () => {
  isolateViewerToken()
  let operationId = ''
  const run = await scenario(
    (world) => {
      if (!operationId) throw new Error('Expected allocated creation operation')
      addForeignIntent(world, operationId)
      return true
    },
    undefined,
    undefined,
    (_world, id) => {
      operationId = id
    },
  )
  expect(operationId).not.toBe('')
  expect(run.result.status).not.toBe('created')
  expect(run.world.issues.has(43)).toBe(false)
})
