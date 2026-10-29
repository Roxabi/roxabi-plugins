import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Json } from '../contracts'

export const CREDENTIAL_MODE = 'procedural-fallback' as const

/** Honest disclosure. The imported SDK has no per-child env parameter; this host does not mutate process.env. */
export const CREDENTIAL_DISCLOSURE =
  'credentialMode: procedural-fallback. No per-child env or token scrub is available on the extension API, so residual process env, GH_TOKEN/GITHUB_TOKEN, gh config, git credential helpers, and SSH remain. Worktree isolation is not credential isolation.'

export type ActionRetentionKind = 'instructions' | 'native-result' | 'attempts' | 'history' | 'proposal'

export type ActionMessage =
  | { kind: 'operator-decision'; summary: string; actionableFacts: string[]; detailRef: string }
  | { kind: 'blocker'; summary: string; actionableFacts: string[]; nextAction: string; detailRef: string }
  | { kind: 'final'; summary: string; detailRef: string }

export type ActionCommunication = {
  status(summary: string): void
  message(message: ActionMessage): void
  retain(kind: ActionRetentionKind, value: Json): Promise<string>
}

const STATUS_KEY = 'omp-build'

export function localProtocolRoot(ctx: Pick<ExtensionContext, 'localProtocolOptions'>): string | null {
  const artifacts = ctx.localProtocolOptions?.getArtifactsDir?.()
  return typeof artifacts === 'string' && artifacts.length > 0 ? join(artifacts, 'local') : null
}

export async function retainActionRecord(
  ctx: Pick<ExtensionContext, 'localProtocolOptions'>,
  kind: ActionRetentionKind,
  value: Json,
): Promise<string> {
  const root = localProtocolRoot(ctx)
  if (root === null) throw new Error('action-communication-retention-unavailable')
  const name = `${kind}-${randomUUID()}.json`
  const relative = `omp-build/communication/${kind}/${name}`
  const absolute = join(root, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value)}\n`, { flag: 'wx' })
  return `local://${relative}`
}

/** Bounded local write for the result hook. Missing storage throws; callers still return a compact replacement. */
export function retainActionRecordSync(
  ctx: Pick<ExtensionContext, 'localProtocolOptions'>,
  kind: ActionRetentionKind,
  value: unknown,
): string {
  const root = localProtocolRoot(ctx)
  if (root === null) throw new Error('action-communication-retention-unavailable')
  const name = `${kind}-${randomUUID()}.json`
  const relative = `omp-build/communication/${kind}/${name}`
  const absolute = join(root, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value)}\n`, { flag: 'wx' })
  return `local://${relative}`
}

function renderMessage(message: ActionMessage): string {
  const lines = [
    message.summary,
    ...('actionableFacts' in message ? message.actionableFacts : []),
    CREDENTIAL_DISCLOSURE,
  ]
  if (message.kind === 'blocker') lines.push(`next: ${message.nextAction}`)
  if (message.kind === 'operator-decision') lines.push('options: confirm the exact proposal, or decline')
  lines.push(`detail: ${message.detailRef}`)
  return lines.join('\n')
}

export function createActionCommunication(
  pi: Pick<ExtensionAPI, 'sendMessage'>,
  ctx: Pick<ExtensionContext, 'ui' | 'localProtocolOptions'>,
): ActionCommunication {
  return {
    status(summary) {
      ctx.ui?.setStatus?.(STATUS_KEY, summary)
    },
    message(message) {
      pi.sendMessage(renderMessage(message), { triggerTurn: false })
    },
    retain(kind, value) {
      return retainActionRecord(ctx, kind, value)
    },
  }
}
