import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { expect, test } from 'vitest'
import type { UwActionPorts } from '../../roxabi/uw-action-contract.ts'
import { actionOperationMethods } from '../../roxabi/uw-action-operations.ts'
import { sha256Bytes } from '../../roxabi/uw-action-result.ts'
import { fixtureUwOperations, standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { registerUwCommand } from '../omp-uw-command.ts'

test('registered /uw action refuses to expand a reviewed replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uw-replay-context-'))
  try {
    const reviewed = standaloneReviewInputs()
    const added = {
      source: 'git-file' as const,
      repository: 'acme/app',
      commit: 'b'.repeat(40),
      path: 'new.txt',
      digest: sha256Bytes(Buffer.from('new')),
    }
    const path = join(directory, 'action.json')
    writeFileSync(
      path,
      JSON.stringify({
        reviewed,
        request: {
          actionId: 'fresh',
          purpose: reviewed.manifest.purpose,
          subject: reviewed.manifest.subject,
          code: reviewed.manifest.code,
          stageSources: [],
          expandedContext: [added],
        },
      }),
    )
    let handler: ((args: string, context: ExtensionContext) => Promise<void>) | undefined
    const messages: string[] = []
    const pi = createExtensionApiStub({
      registerCommand: (name, command) => {
        if (name === 'uw') {
          const registered = command as { handler: (args: string, context: ExtensionContext) => Promise<void> }
          handler = registered.handler
        }
      },
      sendMessage: (message) => {
        messages.push(typeof message === 'string' ? message : String(message?.content ?? message))
      },
    })
    registerUwCommand(pi, () => ({
      ...fixtureUwOperations(),
      ...actionOperationMethods({ actions: {} as UwActionPorts }),
    }))
    if (handler === undefined) throw new Error('registered command unavailable')
    const context = {
      cwd: directory,
      hasUI: false,
      agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 },
    } as unknown as ExtensionContext
    await handler(`action ${path}`, context)
    expect(messages.some((message) => message.includes('review-input-changed'))).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
