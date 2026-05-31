import { describe, expect, it, vi } from 'vitest'

/**
 * Shared test suite for `resolveSize` under legacy 5-bucket project schema.
 *
 * **Caller contract — required hoisted mock.** The caller must hoist at module scope:
 *
 * ```ts
 * vi.mock('node:fs', async () => {
 *   const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
 *   return {
 *     ...actual,
 *     readFileSync: (path: string, encoding?: BufferEncoding) => {
 *       if (path === '.claude/dev-core.yml') throw new Error('ENOENT')
 *       return actual.readFileSync(path, encoding ?? 'utf-8')
 *     },
 *   }
 * })
 * ```
 *
 * Without this mock SIZE_OPTIONS_JSON env var is not the sole source for resolveSize.
 */
export function registerResolveSizeLegacySuite(opts: {
  loadConfigHelpers: () => Promise<{ resolveSize: (input: string) => string | undefined }>
}) {
  const { loadConfigHelpers } = opts

  describe('resolveSize — legacy 5-bucket project schema', () => {
    it('preserves XS / M / L / XL when present as project options', async () => {
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({
        XS: 'size-xs',
        S: 'size-s',
        M: 'size-m',
        L: 'size-l',
        XL: 'size-xl',
      })
      const { resolveSize } = await loadConfigHelpers()

      expect(resolveSize('XS')).toBe('XS')
      expect(resolveSize('xs')).toBe('XS')
      expect(resolveSize('S')).toBe('S')
      expect(resolveSize('M')).toBe('M')
      expect(resolveSize('L')).toBe('L')
      expect(resolveSize('XL')).toBe('XL')

      delete process.env.SIZE_OPTIONS_JSON
    })

    it('falls back to legacy → new-schema aliasing when project uses new schema', async () => {
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({
        S: 'size-s',
        'F-lite': 'size-flite',
        'F-full': 'size-ffull',
      })
      const { resolveSize } = await loadConfigHelpers()

      expect(resolveSize('XS')).toBe('S')
      expect(resolveSize('M')).toBe('F-lite')
      expect(resolveSize('L')).toBe('F-full')
      expect(resolveSize('XL')).toBe('F-full')

      delete process.env.SIZE_OPTIONS_JSON
    })
  })
}
