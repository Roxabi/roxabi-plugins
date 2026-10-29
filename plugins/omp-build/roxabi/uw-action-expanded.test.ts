import { describe, expect, test } from 'vitest'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import type { UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import { acceptCurrentManifest } from './uw-action-expanded.ts'
import { replayUwActionInputs } from './uw-action-inputs.ts'
import { sha256Bytes } from './uw-action-result.ts'

const reviewed = standaloneReviewInputs()
const recordValue = { outcome: 'missing-context' }
const record = {
  source: 'record' as const,
  record: {
    scope: { repository: 'acme/app', target: 'acme/app#42' },
    kind: 'action-receipt' as const,
    recordId: 'negative',
  },
  selector: '/payload',
  digest: canonicalValueDigest(recordValue),
}
const fileBytes = Buffer.from('additional context')
const file = {
  source: 'git-file' as const,
  repository: 'acme/app',
  commit: 'b'.repeat(40),
  path: 'context.txt',
  digest: sha256Bytes(fileBytes),
}
const request = (expandedContext: UwActionRequest['expandedContext']): UwActionRequest => ({
  actionId: 'fresh',
  purpose: reviewed.manifest.purpose,
  subject: reviewed.manifest.subject,
  code: reviewed.manifest.code,
  stageSources: [],
  expandedContext,
})

describe('expanded context preparation boundary', () => {
  test('requires an accounted record reader and validates the selected payload', async () => {
    const withoutAccounting = {
      readRecord: async () => ({ ok: true as const, value: recordValue }),
    } as unknown as UwActionPorts
    expect((await acceptCurrentManifest(request([record]), withoutAccounting, reviewed.manifest, [])).ok).toBe(false)
    const accounted = {
      ...withoutAccounting,
      readAccountedRecord: async () => ({ ok: true as const, value: recordValue }),
    }
    expect((await acceptCurrentManifest(request([record]), accounted, reviewed.manifest, [])).ok).toBe(true)
    const modified = {
      ...accounted,
      readAccountedRecord: async () => ({ ok: true as const, value: { changed: true } }),
    }
    expect((await acceptCurrentManifest(request([record]), modified, reviewed.manifest, [])).ok).toBe(false)
  })

  test('requires the actual pinned bytes to match the new file digest', async () => {
    const ports = { readPinnedFile: async () => ({ ok: true as const, value: fileBytes }) } as unknown as UwActionPorts
    expect((await acceptCurrentManifest(request([file]), ports, reviewed.manifest, [])).ok).toBe(true)
    const changed = { ...ports, readPinnedFile: async () => ({ ok: true as const, value: Buffer.from('different') }) }
    expect((await acceptCurrentManifest(request([file]), changed, reviewed.manifest, [])).ok).toBe(false)
  })

  test('reviewed replay cannot add new context', async () => {
    const result = await replayUwActionInputs({ reviewed, request: request([file]) }, {} as UwActionPorts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe('review-input-changed')
  })
})
