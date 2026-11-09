import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { expect, test } from 'vitest'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { reportResult } from '../omp-uw-result.ts'

test('reports a deferred decision without approval or a missing UW claim and requires explicit re-entry', () => {
  const messages: string[] = []
  const pi = createExtensionApiStub({
    sendMessage: (message) => messages.push(typeof message === 'string' ? message : String(message.content)),
  })
  const context = { localProtocolOptions: consultableProtocolOptions() } as unknown as ExtensionContext
  const result = {
    status: 'deferred',
    diagnostics: [{ code: 'operator-confirmation-deferred', message: 'Decision deferred' }],
  }
  reportResult(pi, context, result)
  expect(result.status).toBe('deferred')
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('uw-deferred')
  expect(messages[0]).toContain('operator-confirmation-deferred')
  expect(messages[0]).toContain('no approval')
  expect(messages[0]).toContain('re-enter the /uw command')
  expect(messages[0]).not.toContain('no-trustworthy-uw')
  expect(messages[0]).not.toContain('uw-refused')
})
