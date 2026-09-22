import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ompBuildExtension from '../index'

// Integration, not unit: the principal probe shells out to git, and a unit test
// that forks is failed by vitest.setup.ts (#502). The unit suite pins the
// *allow* path with the escape hatch; without this file the whole
// principal-switch branch can be deleted from the interceptor and every test
// stays green (PR #531 review).

type ToolCallHandler = (
  event: { toolName: string; input: Record<string, unknown> },
  ctx: { cwd: string },
) => Promise<{ block?: boolean; reason?: string } | undefined>

describe('omp-build interceptor > principal freeze', () => {
  let handler: ToolCallHandler
  let principalCwd: string

  beforeAll(() => {
    // A single-worktree repo is its own principal, so no fixture gymnastics.
    principalCwd = mkdtempSync(join(tmpdir(), 'omp-build-principal-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: principalCwd, stdio: 'ignore' })
    mkdirSync(join(principalCwd, '.dev'))
    writeFileSync(join(principalCwd, '.dev', 'stack.yml'), 'package_manager: bun\n')

    let captured: ToolCallHandler | undefined
    ompBuildExtension({
      on: (_event, fn) => {
        captured = fn as ToolCallHandler
      },
    })
    if (!captured) throw new Error('extension registered no tool_call handler')
    handler = captured
  })

  afterAll(() => {
    rmSync(principalCwd, { recursive: true, force: true })
  })

  it('refuses a feature switch inside the principal worktree', async () => {
    const verdict = await handler({ toolName: 'bash', input: { command: 'git switch feat/x' } }, { cwd: principalCwd })
    expect(verdict?.block).toBe(true)
    expect(verdict?.reason).toMatch(/Principal freeze/)
  })

  it('allows a switch back to the base branch', async () => {
    const verdict = await handler({ toolName: 'bash', input: { command: 'git switch main' } }, { cwd: principalCwd })
    expect(verdict).toBeUndefined()
  })

  it('honours the escape hatch on the same command', async () => {
    process.env.DEV_CORE_ALLOW_PRINCIPAL_SWITCH = '1'
    try {
      const verdict = await handler(
        { toolName: 'bash', input: { command: 'git switch feat/x' } },
        { cwd: principalCwd },
      )
      expect(verdict).toBeUndefined()
    } finally {
      delete process.env.DEV_CORE_ALLOW_PRINCIPAL_SWITCH
    }
  })
})
