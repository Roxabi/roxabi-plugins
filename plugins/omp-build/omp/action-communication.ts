import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'

type ActionRetentionKind = 'history' | 'proposal'

export function localProtocolRoot(ctx: Pick<ExtensionContext, 'localProtocolOptions'>): string | null {
  const artifacts = ctx.localProtocolOptions?.getArtifactsDir?.()
  return typeof artifacts === 'string' && artifacts.length > 0 ? join(artifacts, 'local') : null
}

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
