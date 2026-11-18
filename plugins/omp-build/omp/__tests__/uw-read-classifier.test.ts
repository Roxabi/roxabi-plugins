import { readFileSync } from 'node:fs'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { expect, it } from 'vitest'
import { UwGraphUnavailableError } from '../../roxabi/uw-read-port.ts'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { operatorRootContext } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { installFeatureUwOperationLifecycle } from '../omp-feature-composition.ts'
import { registerUwCommand } from '../omp-uw-command.ts'

const target = { repository: 'acme/widgets', target: 'acme/widgets#42' }
type Command = { handler: (args: string, context: ExtensionContext) => Promise<void> }

it('reports graph refusal diagnostics and preserves unrelated read errors', async () => {
  const diagnostics = [
    {
      code: 'graph-children-incomplete',
      message: 'Child graph page is incomplete',
      location: { kind: 'native' as const, uw: target, connection: 'children' as const, page: 2 },
      related: [{ kind: 'repository' as const, repository: 'acme/widgets' }],
    },
    {
      code: 'graph-blockers-incomplete',
      message: 'Blocker graph page is incomplete',
      location: { kind: 'native' as const, uw: target, connection: 'blockers' as const, page: 3 },
      related: [],
    },
  ]
  let thrown: Error = new UwGraphUnavailableError(diagnostics)
  let command: Command | undefined
  const messages: string[] = []
  const observed: unknown[] = []
  const pi = createExtensionApiStub({
    registerCommand: (_name, value) => {
      command = value as Command
    },
    sendMessage: (message) => messages.push(typeof message === 'string' ? message : String(message.content)),
  })
  installFeatureUwOperationLifecycle(pi)
  registerUwCommand(pi, () => ({
    ...fixtureUwOperations(),
    readUw: async (uw) => {
      observed.push(uw)
      throw thrown
    },
  }))
  if (command === undefined) throw new Error('uw-command-missing')
  const context = operatorRootContext('/repo/feature', consultableProtocolOptions()) as unknown as ExtensionContext
  await command.handler('read acme/widgets#42', context)
  expect(observed).toEqual([target])
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('uw-refused:')
  expect(messages[0]).toContain('graph-children-incomplete')
  expect(messages[0]).toContain('graph-children-incomplete,graph-blockers-incomplete')
  const detail = /detail=([^ ]+)/.exec(messages[0] ?? '')?.[1]
  if (!detail) throw new Error('Refusal artifact unavailable')
  expect(JSON.parse(readFileSync(detail, 'utf8'))).toEqual({ status: 'refused', diagnostics })
  thrown = new Error('unrelated-read-failure')
  await command.handler('read acme/widgets#42', context)
  expect(observed).toEqual([target, target])
  expect(messages[1]).toBe('uw-stopped: unrelated-read-failure')
  thrown = new UwGraphUnavailableError([])
  await command.handler('read acme/widgets#42', context)
  expect(messages[2]).toContain('uw-refused:')
  const localDetail = /detail=([^ ]+)/.exec(messages[2] ?? '')?.[1]
  if (!localDetail) throw new Error('Local refusal artifact unavailable')
  expect(JSON.parse(readFileSync(localDetail, 'utf8'))).toEqual({ status: 'refused', diagnostics: [] })
})
