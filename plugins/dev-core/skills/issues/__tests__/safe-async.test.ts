import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeAsync } from '../lib/safe-async'

// ─── safeAsync ────────────────────────────────────────────────────────────────

describe('safeAsync', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  describe('success path', () => {
    it('returns the resolved value from fn', async () => {
      // Arrange
      const fn = async () => 42
      // Act
      const result = await safeAsync(fn, 0, 'ctx')
      // Assert
      expect(result).toBe(42)
    })

    it('does NOT write to stderr when fn succeeds', async () => {
      // Arrange
      const fn = async () => 'hello'
      // Act
      await safeAsync(fn, '', 'ctx')
      // Assert — negative: stderr must not be called
      expect(stderrSpy).not.toHaveBeenCalled()
    })

    it('works with a non-primitive resolved value', async () => {
      // Arrange
      const value = { a: 1, b: [2, 3] }
      const fn = async () => value
      // Act
      const result = await safeAsync(fn, null, 'ctx')
      // Assert
      expect(result).toBe(value)
    })
  })

  describe('throw path — Error instance', () => {
    it('returns the fallback when fn throws an Error', async () => {
      // Arrange
      const fn = async (): Promise<number> => {
        throw new Error('boom')
      }
      // Act
      const result = await safeAsync(fn, -1, 'ctx')
      // Assert
      expect(result).toBe(-1)
    })

    it('writes a line to stderr containing the context tag', async () => {
      // Arrange
      const fn = async (): Promise<string> => {
        throw new Error('something went wrong')
      }
      // Act
      await safeAsync(fn, 'fallback', 'my-context')
      // Assert
      expect(stderrSpy).toHaveBeenCalledOnce()
      const written = String((stderrSpy.mock.calls[0] as unknown[])[0])
      expect(written).toContain('[my-context]')
    })

    it('writes a line to stderr containing the error message', async () => {
      // Arrange
      const msg = 'something went wrong'
      const fn = async (): Promise<string> => {
        throw new Error(msg)
      }
      // Act
      await safeAsync(fn, 'fallback', 'my-context')
      // Assert
      const written = String((stderrSpy.mock.calls[0] as unknown[])[0])
      expect(written).toContain(msg)
    })

    it('stderr line ends with a newline', async () => {
      // Arrange
      const fn = async (): Promise<number> => {
        throw new Error('err')
      }
      // Act
      await safeAsync(fn, 0, 'ctx')
      // Assert
      const written = String((stderrSpy.mock.calls[0] as unknown[])[0])
      expect(written.endsWith('\n')).toBe(true)
    })
  })

  describe('throw path — non-Error (string, number, object)', () => {
    it('returns fallback when fn throws a string', async () => {
      // Arrange
      const fn = async (): Promise<number> => {
        throw 'string error'
      }
      // Act
      const result = await safeAsync(fn, -99, 'ctx')
      // Assert
      expect(result).toBe(-99)
    })

    it('writes the stringified thrown value to stderr', async () => {
      // Arrange
      const fn = async (): Promise<number> => {
        throw 'string error'
      }
      // Act
      await safeAsync(fn, 0, 'ctx')
      // Assert
      const written = String((stderrSpy.mock.calls[0] as unknown[])[0])
      expect(written).toContain('string error')
    })

    it('returns fallback when fn throws a number', async () => {
      // Arrange
      const fn = async (): Promise<string> => {
        throw 42
      }
      // Act
      const result = await safeAsync(fn, 'fallback', 'ctx')
      // Assert
      expect(result).toBe('fallback')
    })

    it('includes context tag in stderr even for non-Error throws', async () => {
      // Arrange
      const fn = async (): Promise<boolean> => {
        throw 'oops'
      }
      // Act
      await safeAsync(fn, false, 'my-tag')
      // Assert
      const written = String((stderrSpy.mock.calls[0] as unknown[])[0])
      expect(written).toContain('[my-tag]')
    })
  })
})
