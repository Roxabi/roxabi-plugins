import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionContext, SessionEntry } from '@oh-my-pi/pi-coding-agent'
import { vi } from 'vitest'
import { FRAMING_PROCEDURE_FILES, type FramingStage } from '../../engine/framing-context-schema.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { sandbox, git as sandboxGit } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import { operatorDialogUi } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { fixture } from '../../testing/uw-operations-fixture.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from '../feature-contract.ts'
import { type FeatureFramingControllerHost, FRAMING_SUBMIT_TOOL } from '../feature-framing-contract.ts'
import { createFeatureFramingController } from '../feature-framing-controller.ts'
import { createFramingPublicationPorts } from '../uw-framing-ports.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'
import { createUwOperations } from '../uw-operations.ts'
import { continueFeature as continueInstalledFeature } from '../workflow.ts'
import type { GitRunner } from '../workflow-checkout.ts'

export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const ARGS = 'Frame a request queue  '
export const ROOT_AGENT = { kind: 'main', depth: 0, id: 'Main', name: 'main' } as const
export type WrittenBoundary = {
  native: ReturnType<typeof nativeGitHub>
  git: GitRunner
  gitCalls: string[][]
  principal: string
  checkouts: string
}

/** A real git sandbox and a stateful native GitHub: the only replaced boundaries of the written path. */
export function writtenBoundary(): WrittenBoundary {
  const box = sandbox()
  for (const key of ['PATH', 'HOME', 'GH_SIM_STATE', 'GH_SIM_ORIGIN'] as const) {
    const value = box.env[key]
    if (value !== undefined) vi.stubEnv(key, value)
  }
  const checkouts = join(box.root, 'checkouts')
  vi.stubEnv('OMP_WORKTREE_DIR', checkouts)
  const principal = join(box.root, 'principal')
  sandboxGit(box.origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  sandboxGit(principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const gitCalls: string[][] = []
  const git: GitRunner = async (cwd, args) => {
    gitCalls.push([...args])
    try {
      return { code: 0, stdout: sandboxGit(cwd, args), stderr: '' }
    } catch (error) {
      return { code: 1, stdout: '', stderr: String(error) }
    }
  }
  return { native: nativeGitHub(), git, gitCalls, principal, checkouts }
}

/** External plugin-pin port: installed bytes and pinned git bytes of the real procedure files. */
function procedureSupply() {
  const pinned = new Map<string, Uint8Array>()
  const pin = {
    name: 'omp-build' as const,
    version: '0.17.2',
    repository: 'acme/widgets',
    commit: 'a'.repeat(40),
    root: 'plugins/omp-build',
  }
  const installed = (path: string) => new Uint8Array(readFileSync(join(PLUGIN_ROOT, path)))
  return {
    ports: {
      plugin: {
        resolveInstalledPluginPin: async () => ({ ok: true as const, value: pin }),
        readInstalledFile: async (path: string) => ({ ok: true as const, value: installed(path) }),
      },
      readPinnedFile: async (ref: { path: string }) => ({
        ok: true as const,
        value: pinned.get(ref.path) ?? installed(ref.path.slice(`${pin.root}/`.length)),
      }),
    },
    drift(stage: FramingStage) {
      pinned.set(
        `${pin.root}/${FRAMING_PROCEDURE_FILES[stage]}`,
        new TextEncoder().encode('## Steps\n1. Changed\n## Done\n'),
      )
    },
    restore(stage: FramingStage) {
      pinned.delete(`${pin.root}/${FRAMING_PROCEDURE_FILES[stage]}`)
    },
  }
}

export function userEntry(id: string, text: string, extra: Record<string, unknown> = {}): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-10-27T12:00:00.000Z',
    message: { role: 'user', content: text, timestamp: 1, ...extra },
  } as unknown as SessionEntry
}

export function questionEntry(id: string, toolCallId: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-10-27T12:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: toolCallId, name: FRAMING_SUBMIT_TOOL, arguments: {} }],
      timestamp: 1,
    },
  } as unknown as SessionEntry
}

export function world(options: { publication?: boolean; written?: WrittenBoundary } = {}) {
  const protocol = consultableProtocolOptions()
  const entries: SessionEntry[] = []
  const location = {
    cwd: options.written?.principal ?? '/work/widgets',
    sessionFile: '/sessions/one.jsonl',
    artifacts: protocol.getArtifactsDir(),
  }
  /** An agent turn is streaming unless a test models the idle human shortcut. */
  const runtime = {
    idle: false,
    pending: false,
    aborts: 0,
    confirms: 0,
    confirm: false,
    answers: [] as boolean[],
    choices: [] as ('confirm' | 'refuse' | 'defer')[],
    onRepoView: null as (() => void) | null,
  }
  const sessionManager = {
    getBranch: () => [...entries],
    getSessionId: () => 'session-1',
    getCwd: () => location.cwd,
    getSessionFile: () => location.sessionFile,
    getArtifactsDir: () => location.artifacts,
  }
  const ctx = (overrides: { agent?: unknown; hasUI?: boolean; mode?: string } = {}) =>
    ({
      cwd: location.cwd,
      hasUI: overrides.hasUI ?? true,
      mode: overrides.mode ?? 'tui',
      ui: {
        ...operatorDialogUi(async () => {
          runtime.confirms += 1
          return runtime.choices.shift() ?? ((runtime.answers.shift() ?? runtime.confirm) ? 'confirm' : 'refuse')
        }),
        confirm: async () => {
          runtime.confirms += 1
          return runtime.answers.shift() ?? runtime.confirm
        },
      },
      sessionManager,
      localProtocolOptions: protocol,
      isIdle: () => runtime.idle,
      hasPendingMessages: () => runtime.pending,
      abort: () => {
        runtime.aborts += 1
      },
      agent: overrides.agent ?? ROOT_AGENT,
    }) as unknown as ExtensionContext
  const supply = procedureSupply()
  const uw = fixture()
  const statuses: string[] = []
  const sent: { content: unknown; options: unknown }[] = []
  const continued: ContinueFeatureInput[] = []
  const outcomes: ContinueFeatureResult[] = []
  let generation = 0
  let occupant: { revoke(reason: string): void } | null = null
  const unexpectedGh = async (_cwd: string, args: string[]): Promise<string> => {
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`)
  }
  const host: FeatureFramingControllerHost = {
    owner: {
      extensionInstanceId: 'extension-1',
      claim(revoke) {
        const mine = { revoke }
        const previous = occupant
        occupant = mine
        previous?.revoke('owner-replaced')
        generation += 1
        return {
          generation,
          isCurrent: () => occupant === mine,
          release() {
            if (occupant === mine) occupant = null
          },
        }
      },
    },
    sendUserMessage: (content, sendOptions) => {
      sent.push({ content, options: sendOptions })
    },
    status: (message) => {
      statuses.push(message)
    },
    procedurePorts: () => supply.ports,
    operator: (receiving) => createOperatorConfirmation(receiving),
    uw: async ({ operator }) =>
      options.written
        ? createInstalledUwOperations({
            cwd: '/fixture',
            gh: options.written.native.gh,
            readAuthor: 'automation',
            operator,
          })
        : createUwOperations({
            ...uw.ports,
            operator,
            ...(options.publication
              ? {
                  framingPublication: createFramingPublicationPorts(
                    { cwd: location.cwd, gh: unexpectedGh },
                    { readUw: uw.ports.readCreated },
                  ),
                }
              : {}),
          }),
    gh: async (cwd, args) => {
      if (args[0] === 'repo' && args[1] === 'view') {
        runtime.onRepoView?.()
        return JSON.stringify({ nameWithOwner: options.written ? 'acme/app' : 'acme/widgets' })
      }
      return options.written ? options.written.native.gh(cwd, args) : unexpectedGh(cwd, args)
    },
    git: async (cwd, args) => {
      if (options.written) return options.written.git(cwd, args)
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    },
    /** Root's adapter shape: the verified continuation drives the real installed workflow exactly once. */
    continueFeature: async ({ continuation }) => {
      if (!options.written) throw new Error('unexpected continuation')
      continued.push(continuation)
      outcomes.push(await continueInstalledFeature(continuation))
    },
  }
  const controller = createFeatureFramingController(host)
  const replaceOwner = () => {
    const previous = occupant
    occupant = { revoke: () => {} }
    previous?.revoke('ordinary-operation')
  }
  return { controller, ctx, entries, location, runtime, supply, uw, statuses, sent, continued, outcomes, replaceOwner }
}

export type World = ReturnType<typeof world>
