import { vi } from 'vitest'
import { registerResolveSizeLegacySuite } from '../../../../shared/__tests__/resolveSize-legacy-schema.suite'

// Block .claude/dev-core.yml so SIZE_OPTIONS_JSON env var is the sole source.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: (path: string, encoding?: BufferEncoding) => {
      if (path === '.claude/dev-core.yml') throw new Error('ENOENT')
      return actual.readFileSync(path, encoding ?? 'utf-8')
    },
  }
})

registerResolveSizeLegacySuite({
  loadConfigHelpers: () => import('../adapters/config-helpers'),
})
