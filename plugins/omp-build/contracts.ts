import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Flag, is } from '@oh-my-pi/pi-ai/error/flags'

export * from './adapters/github.ts'
export * from './adapters/github-workflow.ts'
export * from './engine/core.ts'
export * from './engine/schemas.ts'
export { isWorkflowKind, stopBotMayAuthor, WORKFLOW_RECORD_KINDS } from './engine/schemas.ts'
export * from './engine/workflow.ts'
export * from './omp/tool-schemas.ts'
export { readEffectiveFixConfig } from './roxabi/workflow-config.ts'

/** Session-boundary Esc/RPC user-abort: SDK stamps Flag.UserInterrupt on errorId. */
export function hasNativeUserInterruptFlag(errorId: number | undefined): boolean {
  return is(errorId, Flag.UserInterrupt)
}

export function shippedProductVersion(): string {
  const start = dirname(fileURLToPath(import.meta.url))
  for (const path of [join(start, 'package.json'), join(start, '..', 'package.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown }
      if (parsed.name === 'omp-build' && typeof parsed.version === 'string' && parsed.version.length > 0)
        return parsed.version
    } catch {}
  }
  throw new Error('omp-build package.json version is missing')
}
