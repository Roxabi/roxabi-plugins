import { describe, expect, it } from 'vitest'
import type { PinnedFileRef, UwActionPorts } from './uw-action-contract.ts'
import { readPinnedPluginFiles } from './uw-action-plugin-files.ts'
import { sha256Bytes } from './uw-action-result.ts'

const one = Buffer.from('one')
const two = Buffer.from('two')
const refs: PinnedFileRef[] = [one, two].map((bytes, index) => ({
  source: 'git-file',
  repository: 'acme/plugin',
  commit: 'a'.repeat(40),
  path: `${index}.txt`,
  digest: sha256Bytes(bytes),
}))

describe('pinned plugin catalogue', () => {
  it('reads ordered verified bytes in one fresh plural call per invocation', async () => {
    let calls = 0
    const ports = {
      readPinnedFiles: async () => {
        calls++
        return { ok: true as const, value: [one, two] }
      },
      readPinnedFile: async () => {
        throw new Error('unexpected singular read')
      },
    } as unknown as UwActionPorts
    expect(await readPinnedPluginFiles(refs, ports)).toEqual({ ok: true, value: [one, two] })
    expect(await readPinnedPluginFiles(refs, ports)).toEqual({ ok: true, value: [one, two] })
    expect(calls).toBe(2)
  })

  it('rejects incomplete, out-of-order, and failed batches', async () => {
    for (const value of [[one], [two, one]]) {
      const ports = { readPinnedFiles: async () => ({ ok: true as const, value }) } as unknown as UwActionPorts
      expect((await readPinnedPluginFiles(refs, ports)).ok).toBe(false)
    }
    const failed = {
      readPinnedFiles: async () => ({
        ok: false as const,
        diagnostics: [{ code: 'record-unreadable', message: 'missing' }],
      }),
    } as unknown as UwActionPorts
    expect((await readPinnedPluginFiles(refs, failed)).ok).toBe(false)
  })

  it('retains the singular fallback for injected ports', async () => {
    const paths: string[] = []
    const ports = {
      readPinnedFile: async (ref: PinnedFileRef) => {
        paths.push(ref.path)
        return { ok: true as const, value: ref.path === '0.txt' ? one : two }
      },
    } as unknown as UwActionPorts
    expect((await readPinnedPluginFiles(refs, ports)).ok).toBe(true)
    expect(paths).toEqual(['0.txt', '1.txt'])
  })
})
