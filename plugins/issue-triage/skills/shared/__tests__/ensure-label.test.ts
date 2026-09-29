import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureLabel } from '../adapters/github-adapter'

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

describe('ensureLabel', () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    spawnSpy = vi.spyOn(Bun, 'spawn')
    spawnSpy.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not recolour a label that already exists', async () => {
    spawnSpy.mockReturnValueOnce(mockProcess('size:S\nbug\n') as unknown as ReturnType<typeof Bun.spawn>)

    await expect(ensureLabel('size:S', 'Acme/app', 'bfd4f2')).resolves.toBe('present')

    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const cmd = spawnSpy.mock.calls[0][0] as string[]
    expect(cmd).toContain('list')
    expect(cmd.join(' ')).not.toMatch(/edit|create|--force|--color/)
  })

  it('creates a missing label in the given colour and never forces a recolour', async () => {
    spawnSpy
      .mockReturnValueOnce(mockProcess('bug\n') as unknown as ReturnType<typeof Bun.spawn>)
      .mockReturnValueOnce(mockProcess('') as unknown as ReturnType<typeof Bun.spawn>)

    await expect(ensureLabel('size:S', 'Acme/app', 'bfd4f2')).resolves.toBe('created')

    const create = spawnSpy.mock.calls[1][0] as string[]
    expect(create).toContain('create')
    expect(create).toContain('--color')
    expect(create[create.indexOf('--color') + 1]).toBe('bfd4f2')
    expect(create).not.toContain('--force')
    expect(create).not.toContain('ededed')
    expect(create.join(' ')).not.toContain('edit')
  })
})
