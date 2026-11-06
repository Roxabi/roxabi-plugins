import { describe, expect, it } from 'vitest'
import { createGhIssueWritePorts } from '../adapters/issue-writer'
import type { IssueWriteObservation } from '../domain/issue-write'

const observed: IssueWriteObservation = {
  issue: { repository: 'Acme/app', number: 7 },
  title: 'Current',
  body: 'Current body',
  updatedAt: '2026-10-27T00:00:00Z',
  nativeState: { state: 'OPEN', stateReason: null },
  labels: [],
  parent: null,
  children: [],
  blockers: [],
}

describe('createGhIssueWritePorts', () => {
  it('refuses malformed native create output instead of inventing a reference', async () => {
    const ports = createGhIssueWritePorts({
      gh: async () => 'created somehow',
      read: async () => observed,
    })

    await expect(ports.create({ repository: 'Acme/app', title: 'New', body: '' })).rejects.toThrow(/valid issue number/)
  })

  it('sends state-only GitHub updates for close and reopen', async () => {
    const calls: string[][] = []
    const ports = createGhIssueWritePorts({
      gh: async (args) => {
        calls.push([...args])
        return ''
      },
      read: async () => observed,
    })
    await ports.setNativeState(observed.issue, { state: 'CLOSED', stateReason: 'COMPLETED' })
    await ports.setNativeState(observed.issue, { state: 'OPEN', stateReason: null })
    await ports.setNativeState(observed.issue, { state: 'OPEN', stateReason: 'REOPENED' })
    expect(calls).toEqual([
      [
        'api',
        '--method',
        'PATCH',
        'repos/Acme/app/issues/7',
        '--raw-field',
        'state=closed',
        '--raw-field',
        'state_reason=completed',
      ],
      ['api', '--method', 'PATCH', 'repos/Acme/app/issues/7', '--raw-field', 'state=open'],
      [
        'api',
        '--method',
        'PATCH',
        'repos/Acme/app/issues/7',
        '--raw-field',
        'state=open',
        '--raw-field',
        'state_reason=reopened',
      ],
    ])
  })
})
