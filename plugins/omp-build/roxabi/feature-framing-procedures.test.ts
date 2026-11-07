import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { FRAMING_PROCEDURE_FILES } from '../engine/framing-context-schema.ts'
import { projectFramingContext } from '../omp/omp-feature-framing-context.ts'
import { createFramingEffectGuard } from './feature-framing-effect-guard.ts'
import { framingProcedureText, loadFramingProcedures, verifyFramingProcedures } from './feature-framing-procedures.ts'
import type { PinnedFileRef } from './uw-action-contract.ts'

const pin = {
  name: 'omp-build' as const,
  version: '1',
  repository: 'example/plugin',
  commit: 'a'.repeat(40),
  root: 'plugins/omp-build',
}
function fixture() {
  const files = new Map<string, Buffer>(
    Object.values(FRAMING_PROCEDURE_FILES).map((path) => [
      path,
      Buffer.from(`# ${path}\n\n## Steps\n1. Inspect facts.\n\n## Done\nFacts retained.\n`),
    ]),
  )
  const pinned = new Map(files)
  return {
    files,
    pinned,
    ports: {
      plugin: {
        resolveInstalledPluginPin: async () => ({ ok: true as const, value: pin }),
        readInstalledFile: async (path: string) => {
          const value = files.get(path)
          return value
            ? { ok: true as const, value }
            : { ok: false as const, diagnostics: [{ code: 'missing', message: path }] }
        },
      },
      readPinnedFile: async (ref: PinnedFileRef) => {
        const value = pinned.get(ref.path.slice(`${pin.root}/`.length))
        return value
          ? { ok: true as const, value }
          : { ok: false as const, diagnostics: [{ code: 'missing', message: ref.path }] }
      },
    },
  }
}

describe('framing procedure supply', () => {
  it('binds exact installed and pinned bytes and rejects a copied handle', async () => {
    const { ports } = fixture()
    const result = await loadFramingProcedures(ports)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(framingProcedureText(result.value, 'grilling')).toContain('Inspect facts')
    expect((await verifyFramingProcedures(result.value)).ok).toBe(true)
    expect((await verifyFramingProcedures({ ...result.value })).ok).toBe(false)
  })
  it('refuses pinned mismatch and detects later installed drift', async () => {
    const different = fixture()
    different.pinned.set(FRAMING_PROCEDURE_FILES.grilling, Buffer.from('other'))
    expect((await loadFramingProcedures(different.ports)).ok).toBe(false)
    const original = fixture()
    const result = await loadFramingProcedures(original.ports)
    if (!result.ok) throw new Error('fixture must load')
    original.files.set(FRAMING_PROCEDURE_FILES.grilling, Buffer.from('changed'))
    expect((await verifyFramingProcedures(result.value)).ok).toBe(false)
    const pinnedDrift = fixture()
    const pinnedBundle = await loadFramingProcedures(pinnedDrift.ports)
    if (!pinnedBundle.ok) throw new Error('fixture must load')
    pinnedDrift.pinned.set(FRAMING_PROCEDURE_FILES.grilling, Buffer.from('changed'))
    expect((await verifyFramingProcedures(pinnedBundle.value)).ok).toBe(false)
  })
  it('projects only the selected procedure after the original messages', async () => {
    const { ports } = fixture()
    const bundle = await loadFramingProcedures(ports)
    if (!bundle.ok) throw new Error('fixture must load')
    const message = { role: 'user' as const, content: 'Untrusted request', timestamp: 1 }
    const result = await projectFramingContext({
      event: { type: 'context', messages: [message] },
      procedures: bundle.value,
      stage: 'grilling',
      supplyToken: 'nonce',
      indexRef: 'index-1',
    })
    if (!result.ok) throw new Error('projection must succeed')
    expect(result.value.messages?.[0]).toBe(message)
    const projection = result.value.messages?.[1]
    expect(projection?.role).toBe('custom')
    if (projection?.role !== 'custom') throw new Error('expected custom projection')
    expect(projection.content).toContain(FRAMING_PROCEDURE_FILES.grilling)
    expect(projection.content).not.toContain(FRAMING_PROCEDURE_FILES['domain-modeling'])
    expect(projection.content).not.toContain('Untrusted request')
  })
  it('revokes native effects when the live cwd changes during the same session', async () => {
    const { ports } = fixture()
    const bundle = await loadFramingProcedures(ports)
    if (!bundle.ok) throw new Error('fixture must load')
    let liveCwd = '/source'
    let aborted = false
    const ctx = {
      cwd: '/source',
      agent: { kind: 'main', depth: 0, id: 'Main' },
      abort: () => {
        aborted = true
      },
      sessionManager: {
        getSessionId: () => 'session',
        getCwd: () => liveCwd,
        getSessionFile: () => '/session',
        getArtifactsDir: () => '/artifacts',
      },
    } as unknown as ExtensionContext
    const { guard } = createFramingEffectGuard({
      ctx,
      procedures: bundle.value,
      operationId: 'op',
      proposalDigest: 'digest',
      isCurrent: () => true,
    })
    const point = {
      operationId: 'op',
      proposalDigest: 'digest',
      member: null,
      effectId: 'effect',
      at: 'before-effect' as const,
    }
    await guard.check(point)
    liveCwd = '/other'
    await expect(guard.check(point)).rejects.toThrow('framing-effect-guard-revoked')
    expect(aborted).toBe(true)
  })
})
