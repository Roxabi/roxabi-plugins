/**
 * RED tests for updateLabels label-filtering behavior.
 *
 * Desired behavior (not yet implemented):
 *   When `remove` is non-empty, updateLabels first calls `gh label list --repo <R>`
 *   to get the repo's existing labels, filters `remove` to only those that exist,
 *   and only passes the intersection to `--remove-label`.
 *   If the intersection is empty, no `--remove-label` flag is emitted.
 *   A failure of `gh label list` propagates — it is NOT swallowed.
 *   `--add-label` is always included when `add` is non-empty.
 *
 * Current (buggy) behavior: updateLabels builds a single gh issue edit call with
 *   the raw `remove` list, no preflight label list call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Block .claude/dev-core.yml so the vitest.config.ts env (GITHUB_REPO=Test/test-repo) is the sole source.
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

function mockProcess(stdout: string, stderr = '', exitCode = 0) {
  const stdoutStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stdout))
      controller.close()
    },
  })
  const stderrStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stderr))
      controller.close()
    },
  })
  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    exited: Promise.resolve(exitCode),
  }
}

// GITHUB_REPO = 'Test/test-repo' is set via vitest.config.ts env before module load.
const { updateLabels } = await import('../adapters/github-adapter')

describe('updateLabels', () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    spawnSpy = vi.spyOn(Bun, 'spawn')
    spawnSpy.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('when remove contains labels that do not exist in the repo', () => {
    it('calls gh label list first, then gh issue edit with only the existing remove labels', async () => {
      // Arrange: repo has 'present-label' and 'target'; 'missing-label' does not exist
      const labelListProc = mockProcess('present-label\ntarget\n')
      const issueEditProc = mockProcess('')

      spawnSpy
        .mockReturnValueOnce(labelListProc as ReturnType<typeof Bun.spawn>)
        .mockReturnValueOnce(issueEditProc as ReturnType<typeof Bun.spawn>)

      // Act
      await updateLabels(42, ['target'], ['missing-label', 'present-label'])

      // Assert: first spawn is gh label list
      expect(spawnSpy).toHaveBeenCalledTimes(2)

      const firstCmd: string[] = spawnSpy.mock.calls[0][0]
      expect(firstCmd).toContain('gh')
      expect(firstCmd).toContain('label')
      expect(firstCmd).toContain('list')
      expect(firstCmd).toContain('Test/test-repo')

      // Assert: second spawn is gh issue edit
      const secondCmd: string[] = spawnSpy.mock.calls[1][0]
      expect(secondCmd).toContain('gh')
      expect(secondCmd).toContain('issue')
      expect(secondCmd).toContain('edit')
      expect(secondCmd).toContain('42')
      expect(secondCmd).toContain('--add-label')
      expect(secondCmd).toContain('target')
      expect(secondCmd).toContain('--remove-label')
      expect(secondCmd).toContain('present-label')

      // Assert: 'missing-label' is NOT passed to --remove-label
      const removeLabelIdx = secondCmd.indexOf('--remove-label')
      expect(removeLabelIdx).toBeGreaterThan(-1)
      const removeLabelArg = secondCmd[removeLabelIdx + 1]
      expect(removeLabelArg).not.toContain('missing-label')
    })
  })

  describe('when gh label list fails', () => {
    it('propagates the error and rejects the promise', async () => {
      // Arrange: gh label list exits with code 1
      const failedLabelListProc = mockProcess('', 'API error: not found', 1)
      spawnSpy.mockReturnValueOnce(failedLabelListProc as ReturnType<typeof Bun.spawn>)

      // Act & Assert: promise must reject
      await expect(updateLabels(42, ['target'], ['x'])).rejects.toThrow()
    })
  })

  describe('when remove labels are all absent from the repo (empty intersection)', () => {
    it('calls gh label list, then gh issue edit without --remove-label', async () => {
      // Arrange: repo only has 'other-label'; requested remove labels do not exist
      const labelListProc = mockProcess('other-label\n')
      const issueEditProc = mockProcess('')

      spawnSpy
        .mockReturnValueOnce(labelListProc as ReturnType<typeof Bun.spawn>)
        .mockReturnValueOnce(issueEditProc as ReturnType<typeof Bun.spawn>)

      // Act
      await updateLabels(42, ['target'], ['missing-1', 'missing-2'])

      // Assert: two spawns — preflight label list still runs because remove.length > 0
      expect(spawnSpy).toHaveBeenCalledTimes(2)

      const firstCmd: string[] = spawnSpy.mock.calls[0][0]
      expect(firstCmd).toContain('gh')
      expect(firstCmd).toContain('label')
      expect(firstCmd).toContain('list')

      // Assert: second spawn includes --add-label but NOT --remove-label (intersection empty)
      const secondCmd: string[] = spawnSpy.mock.calls[1][0]
      expect(secondCmd).toContain('gh')
      expect(secondCmd).toContain('issue')
      expect(secondCmd).toContain('edit')
      expect(secondCmd).toContain('--add-label')
      expect(secondCmd).toContain('target')
      expect(secondCmd).not.toContain('--remove-label')
    })
  })

  describe('when remove is empty', () => {
    it('skips gh label list and only calls gh issue edit with --add-label', async () => {
      // Arrange: only one spawn needed (no label list preflight)
      const issueEditProc = mockProcess('')
      spawnSpy.mockReturnValueOnce(issueEditProc as ReturnType<typeof Bun.spawn>)

      // Act
      await updateLabels(42, ['target'], [])

      // Assert: only one spawn call — no gh label list
      expect(spawnSpy).toHaveBeenCalledTimes(1)

      const cmd: string[] = spawnSpy.mock.calls[0][0]
      expect(cmd).toContain('gh')
      expect(cmd).toContain('issue')
      expect(cmd).toContain('edit')
      expect(cmd).toContain('--add-label')
      expect(cmd).toContain('target')
      expect(cmd).not.toContain('--remove-label')
    })
  })
})
