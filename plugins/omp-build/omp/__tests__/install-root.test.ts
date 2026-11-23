import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExtensionApiStub } from '../../testing/extension-api-stub'
import ompBuildExtension from '../index'
import type { OmpBuildExtensionOptions } from '../omp-commands'
import { featureCommandContext } from './feature-command-fixture.ts'

const rootContext = {
  cwd: '/repo/feature',
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

type Command = { handler: (args: string, ctx: typeof rootContext) => Promise<void> }
type Shutdown = (event: object, ctx: typeof rootContext) => void | Promise<void>
type InstallRootOptions = OmpBuildExtensionOptions & { installRoot: string }

const paths: string[] = []

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryInstallRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), 'omp-build-install-root-'))
  const installRoot = join(parent, 'roxabi-marketplace___omp-build___0.12.2')
  mkdirSync(installRoot)
  paths.push(parent)
  return installRoot
}

function installed(options: InstallRootOptions) {
  const commands = new Map<string, Command>()
  const handlers = new Map<string, Shutdown>()
  const registered = new Map<string, Shutdown[]>()
  const sent: string[] = []
  const pi = createExtensionApiStub({
    registerCommand: (name, command) => commands.set(name, command as Command),
    on: (event, handler) => {
      const listeners = registered.get(event) ?? []
      listeners.push(handler as Shutdown)
      registered.set(event, listeners)
      handlers.set(event, async (session, ctx) => {
        for (const listener of listeners) await listener(session, ctx)
      })
    },
    sendUserMessage: async (message) => {
      sent.push(String(message))
    },
    sendMessage: (message) => sent.push(typeof message === 'string' ? message : String(message?.content ?? message)),
  })
  ompBuildExtension(pi, options)
  return { commands, handlers, pi, sent }
}

describe('replaced omp-build install roots', () => {
  it('tells a skill command that its loaded install root was replaced', async () => {
    const installRoot = temporaryInstallRoot()
    rmSync(installRoot, { recursive: true })
    const host = installed({ installRoot } as InstallRootOptions)

    await host.commands.get('cleanup')?.handler('', rootContext)

    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]).toContain(installRoot)
    expect(host.sent[0]).toContain('omp-build 0.12.2')
    expect(host.sent[0]).toMatch(/replaced/i)
    expect(host.sent[0]).toMatch(/restart/i)
    expect(host.sent[0]).not.toMatch(/reinstall/i)
  })

  it('keeps reinstall guidance for a missing skill under an existing root', async () => {
    const installRoot = temporaryInstallRoot()
    mkdirSync(join(installRoot, 'skills', 'cleanup'), { recursive: true })
    const host = installed({ installRoot } as InstallRootOptions)

    await host.commands.get('cleanup')?.handler('', rootContext)

    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]).toMatch(/reinstall/i)
    expect(host.sent[0]).not.toMatch(/replaced/i)
  })

  it.each(['present', 'replaced'])('does not report a session stop without /feature when root is %s', async (state) => {
    const installRoot = temporaryInstallRoot()
    if (state === 'replaced') rmSync(installRoot, { recursive: true })
    const host = installed({ installRoot } as InstallRootOptions)

    await host.handlers.get('session_shutdown')?.({}, rootContext)

    expect(host.sent).toEqual([])
  })

  it('reports the replaced root when invoking /feature', async () => {
    const installRoot = temporaryInstallRoot()
    rmSync(installRoot, { recursive: true })
    const host = installed({ installRoot })

    const context = { ...rootContext, ...featureCommandContext(rootContext.cwd) }
    await host.commands.get('feature')?.handler('#916', context)

    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]).toContain(installRoot)
    expect(host.sent[0]).toMatch(/replaced/i)
    expect(host.sent[0]).toMatch(/restart/i)
  })
})
