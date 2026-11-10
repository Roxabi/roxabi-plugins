import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import {
  CWD,
  confirmationProposal,
  contextOf,
  installed,
  session,
} from '../../testing/feature-framing-runtime-fixture.ts'
import { manualOperatorDialog } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'

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
})
