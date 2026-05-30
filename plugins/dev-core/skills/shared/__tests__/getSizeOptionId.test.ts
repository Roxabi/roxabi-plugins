import { describe, expect, it, vi } from 'vitest'

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

const LEGACY_5_BUCKET = {
  XS: 'size-xs',
  S: 'size-s',
  M: 'size-m',
  L: 'size-l',
  XL: 'size-xl',
}

describe('getSizeOptionId', () => {
  describe('legacy 5-bucket board {XS, S, M, L, XL}', () => {
    // These cases also prove that lyra's dev-core.yml alias-key stopgap (adding F-lite/F-full as explicit board options) is unneeded.
    it('maps F-full to size-xl via reverse-precedence fallback (XL first)', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify(LEGACY_5_BUCKET)
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act
      const result = getSizeOptionId('F-full')

      // Assert — optionId goes to the XL board bucket; canonical stays F-full for log output
      expect(result?.optionId).toBe('size-xl')
      expect(result?.canonical).toBe('F-full')

      delete process.env.SIZE_OPTIONS_JSON
    })

    it('maps F-lite to size-m via reverse-precedence fallback (M)', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify(LEGACY_5_BUCKET)
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act
      const result = getSizeOptionId('F-lite')

      // Assert
      expect(result?.optionId).toBe('size-m')

      delete process.env.SIZE_OPTIONS_JSON
    })

    it('maps S to size-s (direct key match)', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify(LEGACY_5_BUCKET)
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act
      const result = getSizeOptionId('S')

      // Assert
      expect(result?.optionId).toBe('size-s')

      delete process.env.SIZE_OPTIONS_JSON
    })

    it('maps XS to size-xs (direct key match) — anti-regression: must NOT return size-s', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify(LEGACY_5_BUCKET)
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act
      const result = getSizeOptionId('XS')

      // Assert — XS is a direct key in SIZE_OPTIONS, so it must resolve to its own id
      expect(result?.optionId).toBe('size-xs')
      expect(result?.optionId).not.toBe('size-s')

      delete process.env.SIZE_OPTIONS_JSON
    })
  })

  describe('partial board — no XL fallback to L', () => {
    it('maps F-full to size-l when XL is absent but L is present', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({ S: 'size-s', L: 'size-l' })
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act
      const result = getSizeOptionId('F-full')

      // Assert
      expect(result?.optionId).toBe('size-l')

      delete process.env.SIZE_OPTIONS_JSON
    })
  })

  describe('partial board — no S fallback to XS', () => {
    it('maps S to size-xs when S is absent but XS is present', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({ XS: 'size-xs' })
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act
      const result = getSizeOptionId('S')

      // Assert
      expect(result?.optionId).toBe('size-xs')

      delete process.env.SIZE_OPTIONS_JSON
    })
  })

  describe('canonical new-schema board {S, F-lite, F-full}', () => {
    it('maps S directly to size-s', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({ S: 'size-s', 'F-lite': 'size-flite', 'F-full': 'size-ffull' })
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act & Assert
      expect(getSizeOptionId('S')?.optionId).toBe('size-s')

      delete process.env.SIZE_OPTIONS_JSON
    })

    it('maps F-lite directly to size-flite', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({ S: 'size-s', 'F-lite': 'size-flite', 'F-full': 'size-ffull' })
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act & Assert
      expect(getSizeOptionId('F-lite')?.optionId).toBe('size-flite')

      delete process.env.SIZE_OPTIONS_JSON
    })

    it('maps F-full directly to size-ffull', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({ S: 'size-s', 'F-lite': 'size-flite', 'F-full': 'size-ffull' })
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act & Assert
      expect(getSizeOptionId('F-full')?.optionId).toBe('size-ffull')

      delete process.env.SIZE_OPTIONS_JSON
    })

    it('maps lowercase f-full (alt-case) to size-ffull via resolveSize normalisation', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({ S: 'size-s', 'F-lite': 'size-flite', 'F-full': 'size-ffull' })
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act & Assert
      expect(getSizeOptionId('f-full')?.optionId).toBe('size-ffull')

      delete process.env.SIZE_OPTIONS_JSON
    })

    it('maps F_FULL (underscore alt-case) to size-ffull via resolveSize normalisation', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({ S: 'size-s', 'F-lite': 'size-flite', 'F-full': 'size-ffull' })
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act & Assert
      expect(getSizeOptionId('F_FULL')?.optionId).toBe('size-ffull')

      delete process.env.SIZE_OPTIONS_JSON
    })
  })

  describe('unknown / unrepresentable input', () => {
    it('returns undefined for an unrecognised input string', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify(LEGACY_5_BUCKET)
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act
      const result = getSizeOptionId('bogus')

      // Assert
      expect(result).toBeUndefined()

      delete process.env.SIZE_OPTIONS_JSON
    })
  })

  describe('empty board', () => {
    it('returns undefined for F-full when SIZE_OPTIONS is empty', async () => {
      // Arrange
      vi.resetModules()
      process.env.GITHUB_REPO = 'Test/test-repo'
      process.env.SIZE_OPTIONS_JSON = JSON.stringify({})
      const { getSizeOptionId } = await import('../adapters/config-helpers')

      // Act
      const result = getSizeOptionId('F-full')

      // Assert
      expect(result).toBeUndefined()

      delete process.env.SIZE_OPTIONS_JSON
    })
  })
})
