import { describe, expect, it } from 'vitest'
import {
  extractWriteContent,
  hasProjectContract,
  isBunTestBlocked,
  PROJECT_CONTRACT_FILES,
  rewriteHarnessPaths,
  shouldBlockPrincipalSwitch,
} from '../guards'

describe('OMP dev-core hooks', () => {
  describe('project contract', () => {
    it('accepts host-neutral contract files', () => {
      for (const rel of PROJECT_CONTRACT_FILES) {
        expect(hasProjectContract('/repo', (path) => path.endsWith(`/${rel}`))).toBe(true)
      }
    })

    it('ignores .claude/stack.yml', () => {
      expect(hasProjectContract('/repo', (path) => path === '/repo/.claude/stack.yml')).toBe(false)
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
      const denied = shouldBlockPrincipalSwitch('git switch feat/foo', principalCwd, process.env, {
        isPrincipalCwd: (cwd) => cwd === principalCwd,
      })
      expect(denied).toBe(true)
    })

    it('allows switch on non-principal cwd', () => {
      const denied = shouldBlockPrincipalSwitch('git switch feat/foo', '/repo/feature-wt', process.env, {
        isPrincipalCwd: () => false,
      })
      expect(denied).toBe(false)
    })

    it('honors DEV_CORE_ALLOW_PRINCIPAL_SWITCH escape hatch', () => {
      const principalCwd = '/repo/principal'
      const denied = shouldBlockPrincipalSwitch(
        'git switch feat/foo',
        principalCwd,
        { ...process.env, DEV_CORE_ALLOW_PRINCIPAL_SWITCH: '1' },
        { isPrincipalCwd: (cwd) => cwd === principalCwd },
      )
      expect(denied).toBe(false)
    })
  })

  describe('rewriteHarnessPaths', () => {
    it('expands leftover CLAUDE_SKILL_DIR and CLAUDE_PLUGIN_ROOT for dump fallback', () => {
      const out = rewriteHarnessPaths('bash "${CLAUDE_SKILL_DIR}/ci-watch.sh"', '/plug/skills/ci-watch', '/plug')
      expect(out).toBe('bash "/plug/skills/ci-watch/ci-watch.sh"')
    })
  })

  describe('extractWriteContent', () => {
    it('reads OMP edit hashline from input', () => {
      expect(extractWriteContent({ input: '+const api_key = "abcdefgh12345"' })).toContain('api_key')
    })
  })
})
