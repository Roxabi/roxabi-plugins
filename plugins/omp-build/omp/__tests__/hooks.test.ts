import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  extractWriteContent,
  hasProjectContract,
  isBunTestBlocked,
  SECURITY_SCAN_MAX_BYTES,
  scanSecurityContent,
  shouldBlockPrincipalSwitch,
} from '../guards'
import ompBuildExtension from '../index'

describe('OMP omp-build hooks', () => {
  describe('project contract', () => {
    it('accepts .dev/stack.yml alone', () => {
      expect(hasProjectContract('/repo', (path) => path === '/repo/.dev/stack.yml')).toBe(true)
    })

    it('accepts .dev/dev-core.yml alone', () => {
      expect(hasProjectContract('/repo', (path) => path === '/repo/.dev/dev-core.yml')).toBe(true)
    })

    it('ignores .claude/stack.yml', () => {
      expect(hasProjectContract('/repo', (path) => path === '/repo/.claude/stack.yml')).toBe(false)
    })

    it('ignores the retired pre-.dev contract locations', () => {
      for (const rel of ['stack.yml', '.omp/stack.yml', 'dev-core.yml', '.omp/dev-core.yml']) {
        expect(hasProjectContract('/repo', (path) => path === `/repo/${rel}`)).toBe(false)
      }
    })

    it('is false when no contract exists', () => {
      expect(hasProjectContract('/repo', () => false)).toBe(false)
    })
  })

  describe('bun-test guard', () => {
    it('blocks bare bun test', () => {
      expect(isBunTestBlocked('bun test')).toBe(true)
      expect(isBunTestBlocked('cd apps/api && bun test src')).toBe(true)
    })

    it('allows bun run test', () => {
      expect(isBunTestBlocked('bun run test')).toBe(false)
      expect(isBunTestBlocked('cd apps/api && bun run test')).toBe(false)
    })
  })

  describe('principal freeze pre', () => {
    it('denies git switch feat/foo on principal cwd', () => {
      const principalCwd = '/repo/principal'
      const denied = shouldBlockPrincipalSwitch(
        'git switch feat/foo',
        principalCwd,
        {},
        {
          isPrincipalCwd: (cwd) => cwd === principalCwd,
        },
      )
      expect(denied).toBe(true)
    })

    it('allows switch on non-principal cwd', () => {
      const denied = shouldBlockPrincipalSwitch(
        'git switch feat/foo',
        '/repo/feature-wt',
        {},
        {
          isPrincipalCwd: () => false,
        },
      )
      expect(denied).toBe(false)
    })

    it('honors DEV_CORE_ALLOW_PRINCIPAL_SWITCH escape hatch', () => {
      const principalCwd = '/repo/principal'
      const denied = shouldBlockPrincipalSwitch(
        'git switch feat/foo',
        principalCwd,
        { DEV_CORE_ALLOW_PRINCIPAL_SWITCH: '1' },
        { isPrincipalCwd: (cwd) => cwd === principalCwd },
      )
      expect(denied).toBe(false)
    })
  })

  // `rewriteHarnessPaths` is deliberately absent: it only mattered while
  // registerCommand injected SKILL.md bodies, which this plugin does not do.

  describe('extractWriteContent', () => {
    it('reads OMP edit hashline from input', () => {
      expect(extractWriteContent({ input: '+const api_key = "abcdefgh12345"' })).toContain('api_key')
    })
  })

  // Assembled rather than spelled out: a literal credential in this file would
  // trip the repo's own pre-write security hook before the test could run.
  const CREDENTIAL = `const api_key = ${JSON.stringify('hunter2-hunter2')}\n`
  const SECRET_REASON = 'BLOCKED: Potential hardcoded secret detected'

  describe('security scan ceiling', () => {
    it('catches a credential below the ceiling', () => {
      const payload = CREDENTIAL + 'x'.repeat(1024)
      expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(SECURITY_SCAN_MAX_BYTES)
      expect(scanSecurityContent(payload)).toBe(SECRET_REASON)
    })

    it('scans a payload sitting exactly on the ceiling', () => {
      const payload = CREDENTIAL + 'x'.repeat(SECURITY_SCAN_MAX_BYTES - Buffer.byteLength(CREDENTIAL, 'utf8'))
      expect(Buffer.byteLength(payload, 'utf8')).toBe(SECURITY_SCAN_MAX_BYTES)
      expect(scanSecurityContent(payload)).toBe(SECRET_REASON)
    })

    it('fails open one byte above the ceiling, carrying the same credential', () => {
      const payload = CREDENTIAL + 'x'.repeat(SECURITY_SCAN_MAX_BYTES + 1 - Buffer.byteLength(CREDENTIAL, 'utf8'))
      expect(Buffer.byteLength(payload, 'utf8')).toBe(SECURITY_SCAN_MAX_BYTES + 1)
      expect(scanSecurityContent(payload)).toBeNull()
    })
  })

  describe('extension interceptor', () => {
    type ToolCallHandler = (
      event: { toolName: string; input: Record<string, unknown> },
      ctx: { cwd: string },
    ) => Promise<{ block?: boolean; reason?: string } | undefined>

    let handler: ToolCallHandler
    let contractCwd: string
    let bareCwd: string

    beforeAll(() => {
      contractCwd = mkdtempSync(join(tmpdir(), 'omp-build-contract-'))
      mkdirSync(join(contractCwd, '.dev'))
      writeFileSync(join(contractCwd, '.dev', 'stack.yml'), 'package_manager: bun\n')
      bareCwd = mkdtempSync(join(tmpdir(), 'omp-build-bare-'))

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
      rmSync(contractCwd, { recursive: true, force: true })
      rmSync(bareCwd, { recursive: true, force: true })
    })

    it('blocks bare bun test', async () => {
      const verdict = await handler({ toolName: 'bash', input: { command: 'bun test' } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toMatch(/bun test/i)
    })

    it('lets bun run test through', async () => {
      // The principal probe shells out to git. The escape hatch pins this
      // assertion to the bun-test branch, so the unit project never forks.
      vi.stubEnv('DEV_CORE_ALLOW_PRINCIPAL_SWITCH', '1')
      try {
        const verdict = await handler({ toolName: 'bash', input: { command: 'bun run test' } }, { cwd: contractCwd })
        expect(verdict).toBeUndefined()
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('blocks a write carrying a credential', async () => {
      const verdict = await handler({ toolName: 'write', input: { content: CREDENTIAL } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toBe(`Security check: ${SECRET_REASON}`)
    })

    it('blocks an edit carrying a credential in new_string', async () => {
      // `edit` is the dominant tool in an agent loop; narrowing the branch to
      // `write` alone used to leave every test green (PR #531 review).
      const verdict = await handler({ toolName: 'edit', input: { new_string: CREDENTIAL } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toBe(`Security check: ${SECRET_REASON}`)
    })

    it('blocks an edit carrying a credential in an OMP hashline', async () => {
      const verdict = await handler({ toolName: 'edit', input: { input: `+${CREDENTIAL}` } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toBe(`Security check: ${SECRET_REASON}`)
    })

    it('blocks a bare bun test arriving under the cmd alias', async () => {
      const verdict = await handler({ toolName: 'bash', input: { cmd: 'bun test' } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toMatch(/bun test/i)
    })

    it('lets a clean write through', async () => {
      const verdict = await handler(
        { toolName: 'write', input: { content: 'export const answer = 42\n' } },
        { cwd: contractCwd },
      )
      expect(verdict).toBeUndefined()
    })

    it('goes no-op, warning once, without a project contract', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(await handler({ toolName: 'bash', input: { command: 'bun test' } }, { cwd: bareCwd })).toBeUndefined()
        expect(await handler({ toolName: 'bash', input: { command: 'bun test' } }, { cwd: bareCwd })).toBeUndefined()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0]?.[0]).toContain('omp-build')
      } finally {
        warn.mockRestore()
      }
    })
  })
})
