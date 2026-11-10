import { readdirSync } from 'node:fs'
import type { SessionEntry } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { FRAMING_SUBMIT_TOOL } from '../../roxabi/feature-framing-contract.ts'
import { createUwOperations } from '../../roxabi/uw-operations.ts'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import {
  CWD,
  confirmationProposal,
  contextOf,
  installed,
  session,
} from '../../testing/feature-framing-runtime-fixture.ts'
import { uwMember } from '../../testing/framing-runtime-fixture.ts'
import { manualOperatorDialog } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { fixture as uwFixture } from '../../testing/uw-operations-fixture.ts'

async function stageSuccessor(host: ReturnType<typeof installed>, root: ReturnType<typeof contextOf>) {
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

describe('registered UW command and shortcut feedback', () => {
  it('acknowledges a UW command before preparation and explains repeated shortcuts without repeating the operation', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    const statuses: Array<[string, string | undefined]> = []
    const notices: string[] = []
    let factories = 0
    let abandons = 0
    const host = installed({
      uwOperations: async () => {
        factories += 1
        events.push('factory')
        entered.resolve()
        await release.promise
        return {
          ...fixtureUwOperations(),
          abandon: async () => {
            abandons += 1
            return { status: 'refused', diagnostics: [] }
          },
        }
      },
    })
    const state = session()
    const root = contextOf(state)
    root.ui.setStatus = (key, text) => statuses.push([key, text])
    root.ui.notify = (message) => {
      events.push('notice')
      notices.push(message)
    }
    const command = host.command('abandon acme/widgets#42', root, 'uw')
    await entered.promise
    try {
      expect(events).toEqual(['notice', 'factory'])
      expect(notices[0]).toContain('acme/widgets#42')
      expect(notices[0]).toContain('abandon')
      for (let press = 0; press < 2; press += 1) {
        await host.shortcut(root)
        expect(notices.at(-1)).toContain('acme/widgets#42')
        expect(notices.at(-1)).toContain('abandon')
        expect(notices.at(-1)).not.toBe(notices[0])
      }
      expect(events).toEqual(['notice', 'factory', 'notice', 'notice'])
      expect(factories).toBe(1)
      expect(abandons).toBe(0)
      expect(statuses.some(([key]) => key === 'omp-build-framing')).toBe(false)
      expect(statuses.at(-1)).toEqual(['omp-build-operator', expect.stringContaining('acme/widgets#42')])
      expect(state.confirms).toBe(0)
      expect(host.procedureReads()).toBe(0)
      expect(host.messages).toEqual([])
      expect(host.userMessages).toEqual([])
    } finally {
      release.resolve()
      await command
    }
    expect(abandons).toBe(1)
  })

  it('reports a preparation failure once without requiring a held confirmation', async () => {
    let factories = 0
    const host = installed({
      uwOperations: async () => {
        factories += 1
        throw new Error('remote-read-unavailable')
      },
    })
    const state = session()
    const root = contextOf(state)
    const notices: string[] = []
    const statuses: Array<[string, string | undefined]> = []
    root.ui.notify = (message) => notices.push(message)
    root.ui.setStatus = (key, text) => statuses.push([key, text])

    await host.command('abandon acme/widgets#42', root, 'uw')

    expect(host.messages).toEqual(['uw-stopped: remote-read-unavailable'])
    expect(notices.filter((message) => message.includes('remote-read-unavailable'))).toEqual([
      expect.stringContaining('uw-stopped:'),
    ])
    expect(factories).toBe(1)
    expect(state.confirms).toBe(0)
    expect(host.userMessages).toEqual([])
    expect(host.procedureReads()).toBe(0)
    expect(statuses.at(-1)).toEqual(['omp-build-operator', undefined])
  })

  it.each(['settled', 'stopped'] as const)(
    'keeps a started UW action out of framing until it is %s, without treating its confirmation as publication',
    async (end) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const effects: string[] = []
      const notices: string[] = []
      const statuses: Array<[string, string | undefined]> = []
      const dialog = manualOperatorDialog()
      let factories = 0
      const host = installed({
        uwOperations: ({ operator }) => {
          factories += 1
          return {
            ...fixtureUwOperations(),
            acceptMaterial: async () => {
              const result = await operator.executeConfirmed(confirmationProposal, async () => {
                effects.push('started')
                entered.resolve()
                await release.promise
                effects.push('finished')
                return { status: 'refused' as const, diagnostics: [] }
              })
              return result.status === 'confirmed' ? result.value : { status: 'refused', diagnostics: [] }
            },
          }
        },
      })
      const root = contextOf(session())
      Object.assign(root.ui, dialog.ui, {
        notify: (message: string) => notices.push(message),
        setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      })
      const command = host.command('accept-material acme/widgets#42', root, 'uw')
      const view = await dialog.nextMount()
      expect(effects).toEqual([])
      view.handleInput?.('c')
      await entered.promise
      try {
        if (end === 'stopped') {
          const applying = statuses.at(-1)
          const stop = new AbortController()
          stop.abort()
          await host.emit('session_stop', { type: 'session_stop', signal: stop.signal }, root)
          expect(statuses.at(-1)).not.toEqual(applying)
          expect(statuses.at(-1)).toEqual(['omp-build-operator', expect.stringContaining('accept-material')])
        }
        const before = notices.length
        await host.shortcut(root)
        await host.shortcut(root)
        expect(notices.slice(before)).toEqual([
          expect.stringContaining('accept-material'),
          expect.stringContaining('accept-material'),
        ])
        expect(notices.slice(before).every((message) => message.includes('acme/widgets#42'))).toBe(true)
        expect(effects).toEqual(['started'])
        expect(factories).toBe(1)
        expect(dialog.views).toEqual([view])
        expect(statuses.some(([key]) => key === 'omp-build-framing')).toBe(false)
        expect(host.procedureReads()).toBe(0)
        expect(host.messages).toEqual([])
        expect(host.userMessages).toEqual([])
      } finally {
        release.resolve()
        await command
      }
      expect(effects).toEqual(['started', 'finished'])
      expect(statuses.at(-1)).toEqual(['omp-build-operator', undefined])
      if (end === 'stopped') expect(host.messages).toEqual([])
      else {
        expect(host.messages).toEqual([expect.stringMatching(/^uw-refused: .* detail=/)])
        expect(notices.at(-1)).toContain('uw-refused:')
      }
    },
  )

  it.each(['session-file', 'manager-artifacts', 'report-artifacts'] as const)(
    'does not report or retain a result after only the %s mapping changes',
    async (mapping) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const host = installed({
        uwOperations: async () => {
          entered.resolve()
          await release.promise
          return { ...fixtureUwOperations(), abandon: async () => ({ status: 'refused', diagnostics: [] }) }
        },
      })
      const state = session()
      const root = contextOf(state)
      const original = state.artifacts.getArtifactsDir()
      const replacement = consultableProtocolOptions()
      const notices: string[] = []
      root.ui.notify = (message) => notices.push(message)
      const command = host.command('abandon acme/widgets#42', root, 'uw')
      await entered.promise
      if (mapping === 'session-file')
        Object.assign(root.sessionManager, { getSessionFile: () => `${CWD}/rebound-session.jsonl` })
      else if (mapping === 'manager-artifacts')
        Object.assign(root.sessionManager, { getArtifactsDir: () => replacement.getArtifactsDir() })
      else Object.assign(root, { localProtocolOptions: replacement })
      const before = notices.length
      release.resolve()
      await command

      expect(host.messages).toEqual([])
      expect(host.userMessages).toEqual([])
      expect(notices.slice(before)).toEqual([])
      expect(readdirSync(original)).toEqual([])
      expect(readdirSync(replacement.getArtifactsDir())).toEqual([])
    },
  )

  it.each(['status', 'notice'] as const)(
    'does not let a throwing %s projection block decisions or falsify the operation result',
    async (projection) => {
      const dialog = manualOperatorDialog()
      const effects: number[] = []
      let factories = 0
      const host = installed({
        uwOperations: ({ operator }) => {
          const operation = ++factories
          return {
            ...fixtureUwOperations(),
            acceptMaterial: async () => {
              const result = await operator.executeConfirmed(confirmationProposal, async () => {
                effects.push(operation)
                return { status: 'refused' as const, diagnostics: [] }
              })
              return result.status === 'confirmed' ? result.value : { status: 'refused', diagnostics: [] }
            },
          }
        },
      })
      const root = contextOf(session())
      Object.assign(root.ui, dialog.ui)
      const fail = (): never => {
        throw new Error('ui-presentation-failed')
      }
      if (projection === 'status') root.ui.setStatus = fail
      else root.ui.notify = fail

      const refused = host.command('accept-material acme/widgets#42', root, 'uw')
      const first = await dialog.nextMount()
      first.handleInput?.('r')
      await refused
      expect(effects).toEqual([])

      const confirmed = host.command('accept-material acme/widgets#42', root, 'uw')
      const second = await dialog.nextMount()
      expect(effects).toEqual([])
      second.handleInput?.('c')
      await confirmed
      expect(effects).toEqual([2])
      expect(factories).toBe(2)
      expect(dialog.views).toEqual([first, second])
      expect(host.messages).toEqual([
        expect.stringMatching(/^uw-refused: .* detail=/),
        expect.stringMatching(/^uw-refused: .* detail=/),
      ])
      expect(host.userMessages).toEqual([])
      expect(host.procedureReads()).toBe(0)
    },
  )

  it('suppresses a superseded preparation failure without clearing or reannouncing its successor', async () => {
    const firstEntered = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const firstRelease = Promise.withResolvers<void>()
    const secondRelease = Promise.withResolvers<void>()
    const statuses: Array<[string, string | undefined]> = []
    const notices: string[] = []
    let factories = 0
    const host = installed({
      uwOperations: async () => {
        const call = ++factories
        if (call === 1) {
          firstEntered.resolve()
          await firstRelease.promise
          throw new Error('superseded-preparation-failed')
        }
        if (call !== 2) throw new Error('unexpected-factory-reentry')
        secondEntered.resolve()
        await secondRelease.promise
        return { ...fixtureUwOperations(), abandon: async () => ({ status: 'refused', diagnostics: [] }) }
      },
    })
    const root = contextOf(session())
    root.ui.notify = (message) => notices.push(message)
    root.ui.setStatus = (key, text) => statuses.push([key, text])
    const first = host.command('abandon acme/widgets#42', root, 'uw')
    await firstEntered.promise
    const second = host.command('abandon acme/widgets#43', root, 'uw')
    await secondEntered.promise
    const visible = [...notices]
    const status = statuses.at(-1)
    try {
      firstRelease.resolve()
      await first
      expect(host.messages).toEqual([])
      expect(notices).toEqual(visible)
      expect(statuses.at(-1)).toEqual(status)
      expect(status).toEqual(['omp-build-operator', expect.stringContaining('acme/widgets#43')])
      expect(factories).toBe(2)
    } finally {
      secondRelease.resolve()
      await second
    }
    expect(host.messages).toEqual([expect.stringMatching(/^uw-refused: .* detail=/)])
  })

  it('does not let a delayed predecessor stop revoke its successor confirmation', async () => {
    const dialog = manualOperatorDialog()
    const statuses: Array<[string, string | undefined]> = []
    const effects: number[] = []
    let factories = 0
    const host = installed({
      uwOperations: ({ operator }) => {
        const operation = ++factories
        return {
          ...fixtureUwOperations(),
          acceptMaterial: async () => {
            const result = await operator.executeConfirmed(confirmationProposal, async () => {
              effects.push(operation)
              return { status: 'refused' as const, diagnostics: [] }
            })
            return result.status === 'confirmed' ? result.value : { status: 'refused', diagnostics: [] }
          },
        }
      },
    })
    const root = contextOf(session())
    Object.assign(root.ui, dialog.ui, {
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
    })
    const first = host.command('accept-material acme/widgets#42', root, 'uw')
    await dialog.nextMount()
    const stop = new AbortController()
    await host.emit('session_stop', { type: 'session_stop', signal: stop.signal }, root)
    const second = host.command('accept-material acme/widgets#43', root, 'uw')
    const successor = await dialog.nextMount()
    await first
    try {
      const visible = statuses.at(-1)
      stop.abort()
      expect(statuses.at(-1)).toEqual(visible)
      expect(effects).toEqual([])
      successor.handleInput?.('c')
      await second
      successor.handleInput?.('c')
      expect(effects).toEqual([2])
      expect(factories).toBe(2)
    } finally {
      successor.handleInput?.('r')
      await second
    }
  })

  it.each(['same-location', 'moved-location'] as const)(
    'allows successor framing while a stopped action from %s still awaits settlement',
    async (location) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const completed = Promise.withResolvers<void>()
      const dialog = manualOperatorDialog()
      const statuses: Array<[string, string | undefined]> = []
      const effects: string[] = []
      let factories = 0
      const host = installed({
        uwOperations: ({ operator }) => {
          factories += 1
          return {
            ...fixtureUwOperations(),
            prepareFraming: createUwOperations({ ...uwFixture().ports, operator }).prepareFraming,
            acceptMaterial: async () => {
              try {
                const result = await operator.executeConfirmed(confirmationProposal, async () => {
                  effects.push('predecessor-started')
                  entered.resolve()
                  await release.promise
                  effects.push('predecessor-settled')
                  return { status: 'refused' as const, diagnostics: [] }
                })
                return result.status === 'confirmed' ? result.value : { status: 'refused', diagnostics: [] }
              } finally {
                completed.resolve()
              }
            },
            frame: async (prepared) => {
              const result = await operator.executeConfirmed(prepared, async () => {
                effects.push('successor')
                return { status: 'refused' as const, effects: [] as const, diagnostics: [] }
              })
              return result.status === 'confirmed' ? result.value : { status: 'refused', effects: [], diagnostics: [] }
            },
          }
        },
      })
      const root = contextOf(session())
      Object.assign(root.ui, dialog.ui, {
        setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      })
      const predecessor = host.command('accept-material acme/widgets#42', root, 'uw')
      const first = await dialog.nextMount()
      first.handleInput?.('\u001b')
      await predecessor
      await host.shortcut(root)
      const reopened = await dialog.nextMount()
      reopened.handleInput?.('c')
      await entered.promise
      let successorWork: Promise<void> | undefined
      let successor: Awaited<ReturnType<typeof dialog.nextMount>> | undefined
      try {
        if (location === 'moved-location') {
          Object.assign(root, { cwd: `${CWD}/next` })
          Object.assign(root.sessionManager, { getCwd: () => root.cwd })
        }
        await stageSuccessor(host, root)
        const mounted = dialog.nextMount()
        successorWork = host.shortcut(root)
        expect(await Promise.race([mounted.then(() => 'mounted'), successorWork.then(() => 'returned')])).toBe(
          'mounted',
        )
        successor = await mounted
        expect(effects).toEqual(['predecessor-started'])
        const mountedFactories = factories
        const visible = statuses.at(-1)
        release.resolve()
        await completed.promise
        expect(statuses.at(-1)).toEqual(visible)
        expect(effects).toEqual(['predecessor-started', 'predecessor-settled'])
        successor.handleInput?.('c')
        await successorWork
        expect(effects).toEqual(['predecessor-started', 'predecessor-settled', 'successor'])
        expect(factories).toBe(mountedFactories)
      } finally {
        successor?.handleInput?.('r')
        release.resolve()
        await completed.promise
        await successorWork
      }
    },
  )

  it('does not route a stopped action back into its retained revoked framing view', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const effects: string[] = []
    const statuses: Array<[string, string | undefined]> = []
    const dialog = manualOperatorDialog()
    const refusal = { status: 'refused' as const, effects: [] as const, diagnostics: [] }
    let frames = 0
    const host = installed({
      uwOperations: ({ operator }) => ({
        ...fixtureUwOperations(),
        prepareFraming: createUwOperations({ ...uwFixture().ports, operator }).prepareFraming,
        frame: async (prepared) => {
          frames += 1
          const result = await operator.executeConfirmed(prepared, async () => {
            effects.push('started')
            entered.resolve()
            await release.promise
            effects.push('settled')
            return refusal
          })
          return result.status === 'confirmed' ? result.value : refusal
        },
      }),
    })
    const root = contextOf(session())
    Object.assign(root.ui, dialog.ui, {
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
    })
    await stageSuccessor(host, root)
    const work = host.shortcut(root)
    const view = await dialog.nextMount()
    view.handleInput?.('c')
    await entered.promise
    try {
      const stop = new AbortController()
      stop.abort()
      await host.emit('session_stop', { type: 'session_stop', signal: stop.signal }, root)
      const afterStop = [...statuses]
      await host.shortcut(root)
      expect(statuses).toEqual(afterStop)
      expect(dialog.views).toEqual([view])
      expect(frames).toBe(1)
      expect(effects).toEqual(['started'])
      expect(await host.admits('task', root)).toBe(false)
    } finally {
      release.resolve()
      await work
    }
    expect(effects).toEqual(['started', 'settled'])
  })
})
