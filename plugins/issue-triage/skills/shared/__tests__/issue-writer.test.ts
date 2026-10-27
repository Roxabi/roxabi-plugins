import { describe, expect, it } from 'vitest'
import { createGhIssueWritePorts } from '../adapters/issue-writer'
import type { IssueWriteObservation } from '../domain/issue-write'

const observed: IssueWriteObservation = {
  issue: { repository: 'Acme/app', number: 7 },
  title: 'Current',
  body: 'Current body',
  updatedAt: '2026-10-27T00:00:00Z',
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
})
