import type { SessionEntry } from '@oh-my-pi/pi-coding-agent'
import { expect } from 'vitest'
import { FRAMING_SUBMIT_TOOL } from '../../roxabi/feature-framing-contract.ts'
import type { contextOf, installed } from '../../testing/feature-framing-runtime-fixture.ts'
import { uwMember } from '../../testing/framing-runtime-fixture.ts'

export async function stageSuccessor(host: ReturnType<typeof installed>, root: ReturnType<typeof contextOf>) {
  const entries: SessionEntry[] = []
  Object.assign(root.sessionManager, { getBranch: () => entries })
  await host.command('ship the billing export', root)
  const supplyToken = async () => {
    const projected = (await host.emit('context', { type: 'context', messages: [] }, root)) as
      | { messages: Array<{ content?: unknown }> }
      | undefined
    const match = /^Supply token: (\S+)$/m.exec(String(projected?.messages.at(-1)?.content ?? ''))
    if (!match?.[1]) throw new Error('framing-projection-missing')
    return match[1]
  }
  const signal = new AbortController().signal
  expect(
    await host.submit(
      { supplyToken: await supplyToken(), form: { kind: 'question', question: 'Question grill?' } },
      root,
      signal,
    ),
  ).toMatchObject({ status: 'waiting' })
  entries.push(
    {
      type: 'message',
      id: 'q-grill',
      parentId: null,
      timestamp: '2026-10-27T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'submit-call', name: FRAMING_SUBMIT_TOOL, arguments: {} }],
        timestamp: 1,
      },
    } as unknown as SessionEntry,
    {
      type: 'message',
      id: 'u-grill',
      parentId: null,
      timestamp: '2026-10-27T12:00:00.000Z',
      message: { role: 'user', content: 'Answer grill', timestamp: 1 },
    } as SessionEntry,
  )
  expect(
    await host.submit(
      {
        supplyToken: await supplyToken(),
        form: {
          kind: 'grilling',
          shape: 'leaf',
          unresolved: [],
          decisions: [{ questionEntryId: 'q-grill', answerEntryId: 'u-grill', decision: 'Decision grill' }],
          terms: [],
        },
      },
      root,
      signal,
    ),
  ).toMatchObject({ status: 'accepted' })
  const member = uwMember(
    { kind: 'new', key: 'root', repository: 'acme/widgets' },
    'Request queue',
    'queue',
    'Requests enter the queue',
  )
  const staged = await host.submit(
    {
      supplyToken: await supplyToken(),
      form: {
        kind: 'proposal',
        decisions: [],
        modules: [],
        vocabulary: [],
        aggregate: {
          kind: 'uw',
          root: 'root',
          members: [{ ...member, slot: { kind: 'new', key: 'root' } }],
          edges: [],
          coverage: [],
          foundations: [],
        },
      },
    },
    root,
    signal,
  )
  expect(staged).toMatchObject({ status: 'accepted', diagnostics: [{ code: 'framing-proposal-staged' }] })
}
