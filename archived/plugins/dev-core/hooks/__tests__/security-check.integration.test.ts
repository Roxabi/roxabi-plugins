import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, '')
const HOOK = join(HOOKS_DIR, 'security-check.cjs')

const tmpDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'security-check-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
  }
})

/**
 * Run the hook the way the harness does: PreToolUse tool input via env,
 * cwd = a throwaway project root so the daily debounce state never leaks
 * between tests.
 */
function runHook(hookPath: string, content: string, filePath = 'src/app.ts') {
  const proc = spawnSync(process.execPath, [hookPath], {
    cwd: scratch(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      CLAUDE_TOOL_INPUT: JSON.stringify({ file_path: filePath, content }),
    },
  })
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr }
}

/** A copy of the hook whose `./lib/` dependencies are absent — a partial install. */
function hookWithoutLib(): string {
  const dir = scratch()
  const dest = join(dir, 'security-check.cjs')
  cpSync(HOOK, dest)
  mkdirSync(join(dir, 'lib'))
  return dest
}

describe('security-check exit codes', () => {
  it('exits 2 when its lib dependencies cannot be loaded', () => {
    const r = runHook(hookWithoutLib(), 'const greeting = "hello"\n')

    // Only exit 2 blocks the tool call. 1 (uncaught throw) and 0 both let the
    // write through unscanned.
    expect(r.status, r.stderr).toBe(2)
    expect(r.stderr).toContain('secret scanning is unavailable')
    expect(r.stderr).toContain('claude plugin install dev-core')
  })

  it('exits 0 on clean content', () => {
    const r = runHook(HOOK, 'export const greeting = "hello"\n')

    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('exits 2 and denies when a secret is detected', () => {
    const r = runHook(HOOK, 'const api_key = "sk-live-0123456789abcdef"\n')

    expect(r.status, r.stderr).toBe(2)
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'deny' })
    expect(r.stdout).toContain('hardcoded secret')
  })
})
