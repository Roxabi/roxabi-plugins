import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { checkPrereqs } from '../prereqs'

describe('checkPrereqs', () => {
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    spawnSyncSpy = vi.spyOn(Bun, 'spawnSync')
  })

  afterEach(() => {
    spawnSyncSpy.mockRestore()
  })

  function mockSpawn(responses: Record<string, { stdout: string; exitCode: number }>) {
    spawnSyncSpy.mockImplementation((cmd: string[]) => {
      const key = cmd.join(' ')
      for (const [pattern, result] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          return {
            stdout: new TextEncoder().encode(result.stdout),
            stderr: new Uint8Array(),
            exitCode: result.exitCode,
            success: result.exitCode === 0,
          } as unknown as ReturnType<typeof Bun.spawnSync>
        }
      }
      return {
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        exitCode: 1,
        success: false,
      } as unknown as ReturnType<typeof Bun.spawnSync>
    })
  }

  it('detects all tools present', () => {
    mockSpawn({
      'bun --version': { stdout: '1.2.0', exitCode: 0 },
      'gh --version': { stdout: 'gh version 2.40.0', exitCode: 0 },
      'gh auth status': { stdout: 'Logged in', exitCode: 0 },
      'git remote get-url origin': { stdout: 'git@github.com:Roxabi/test-repo.git', exitCode: 0 },
    })

    const result = checkPrereqs()
    expect(result.bun).toEqual({ ok: true, version: '1.2.0' })
    expect(result.gh.ok).toBe(true)
    expect(result.gitRemote).toEqual({ ok: true, url: 'git@github.com:Roxabi/test-repo.git', owner: 'Roxabi', repo: 'test-repo' })
  })

  it('handles gh not installed', () => {
    mockSpawn({
      'bun --version': { stdout: '1.2.0', exitCode: 0 },
      'gh --version': { stdout: '', exitCode: 1 },
      'git remote get-url origin': { stdout: 'git@github.com:Roxabi/test-repo.git', exitCode: 0 },
    })

    const result = checkPrereqs()
    expect(result.gh).toEqual({ ok: false, detail: 'not installed' })
  })

  it('handles gh installed but not authenticated', () => {
    mockSpawn({
      'bun --version': { stdout: '1.2.0', exitCode: 0 },
      'gh --version': { stdout: 'gh version 2.40.0', exitCode: 0 },
      'gh auth status': { stdout: '', exitCode: 1 },
      'git remote get-url origin': { stdout: 'git@github.com:Roxabi/test-repo.git', exitCode: 0 },
    })

    const result = checkPrereqs()
    expect(result.gh).toEqual({ ok: false, detail: 'not authenticated' })
  })

  it('handles no git remote', () => {
    mockSpawn({
      'bun --version': { stdout: '1.2.0', exitCode: 0 },
      'gh --version': { stdout: 'gh version 2.40.0', exitCode: 0 },
      'gh auth status': { stdout: 'Logged in', exitCode: 0 },
      'git remote get-url origin': { stdout: '', exitCode: 1 },
    })

    const result = checkPrereqs()
    expect(result.gitRemote).toEqual({ ok: false, url: '', repo: '', owner: '' })
  })

  it('handles all tools missing', () => {
    mockSpawn({})

    const result = checkPrereqs()
    expect(result.bun.ok).toBe(false)
    expect(result.gh.ok).toBe(false)
    expect(result.gitRemote.ok).toBe(false)
  })

  it('parses HTTPS remote URL', () => {
    mockSpawn({
      'bun --version': { stdout: '1.2.0', exitCode: 0 },
      'gh --version': { stdout: 'gh version 2.40.0', exitCode: 0 },
      'gh auth status': { stdout: 'Logged in', exitCode: 0 },
      'git remote get-url origin': { stdout: 'https://github.com/Roxabi/test-repo.git', exitCode: 0 },
    })

    const result = checkPrereqs()
    expect(result.gitRemote).toEqual({ ok: true, url: 'https://github.com/Roxabi/test-repo.git', owner: 'Roxabi', repo: 'test-repo' })
  })
})
